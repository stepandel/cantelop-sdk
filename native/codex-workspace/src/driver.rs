use base64::{Engine, engine::general_purpose::STANDARD};
use futures_core::{future::BoxFuture, stream::BoxStream};
use futures_util::{StreamExt, TryStreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{Value as Json, json};
use sqlx::{
    ConnectOptions, Connection, Database, Decode, Encode, Error, Executor, Row, Transaction, Type,
};
use sqlx_core::{
    Either, Url,
    arguments::Arguments,
    column::{Column, ColumnIndex},
    encode::IsNull,
    error::BoxDynError,
    executor::Execute,
    sql_str::SqlStr,
    statement::Statement,
    transaction::TransactionManager,
    type_info::TypeInfo,
    value::{Value, ValueRef},
};
use std::{borrow::Cow, fmt, str::FromStr, sync::Arc, time::Duration};

#[derive(Debug, Clone)]
pub struct Workspace;
pub type WorkspacePool = sqlx::Pool<Workspace>;
pub type WorkspacePoolOptions = sqlx::pool::PoolOptions<Workspace>;

impl Database for Workspace {
    type Connection = WorkspaceConnection;
    type TransactionManager = WorkspaceTransactionManager;
    type Row = WorkspaceRow;
    type QueryResult = WorkspaceQueryResult;
    type Column = WorkspaceColumn;
    type TypeInfo = WorkspaceType;
    type Value = WorkspaceValue;
    type ValueRef<'r> = WorkspaceValueRef<'r>;
    type Arguments = WorkspaceArguments;
    type ArgumentBuffer = Vec<WireValue>;
    type Statement = WorkspaceStatement;
    const NAME: &'static str = "Cantelop workspace";
    const URL_SCHEMES: &'static [&'static str] = &["cantelop-workspace"];
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum WorkspaceType {
    Null,
    Integer,
    Float,
    Text,
    Blob,
}
impl fmt::Display for WorkspaceType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.name())
    }
}
impl TypeInfo for WorkspaceType {
    fn is_null(&self) -> bool {
        *self == Self::Null
    }
    fn name(&self) -> &str {
        match self {
            Self::Null => "NULL",
            Self::Integer => "INTEGER",
            Self::Float => "REAL",
            Self::Text => "TEXT",
            Self::Blob => "BLOB",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum WireValue {
    Null,
    Integer { value: String },
    Float { value: f64 },
    Text { value: String },
    Blob { base64: String },
}
impl WireValue {
    fn kind(&self) -> WorkspaceType {
        match self {
            Self::Null => WorkspaceType::Null,
            Self::Integer { .. } => WorkspaceType::Integer,
            Self::Float { .. } => WorkspaceType::Float,
            Self::Text { .. } => WorkspaceType::Text,
            Self::Blob { .. } => WorkspaceType::Blob,
        }
    }
}
#[derive(Debug, Clone)]
pub struct WorkspaceValue(pub WireValue);
#[derive(Clone, Copy)]
pub struct WorkspaceValueRef<'r>(&'r WireValue);
impl Value for WorkspaceValue {
    type Database = Workspace;
    fn as_ref(&self) -> WorkspaceValueRef<'_> {
        WorkspaceValueRef(&self.0)
    }
    fn type_info(&self) -> Cow<'_, WorkspaceType> {
        Cow::Owned(self.0.kind())
    }
    fn is_null(&self) -> bool {
        matches!(self.0, WireValue::Null)
    }
}
impl<'r> ValueRef<'r> for WorkspaceValueRef<'r> {
    type Database = Workspace;
    fn to_owned(&self) -> WorkspaceValue {
        WorkspaceValue(self.0.clone())
    }
    fn type_info(&self) -> Cow<'_, WorkspaceType> {
        Cow::Owned(self.0.kind())
    }
    fn is_null(&self) -> bool {
        matches!(self.0, WireValue::Null)
    }
}

#[derive(Debug, Clone)]
pub struct WorkspaceColumn {
    ordinal: usize,
    name: String,
    kind: WorkspaceType,
}
impl Column for WorkspaceColumn {
    type Database = Workspace;
    fn ordinal(&self) -> usize {
        self.ordinal
    }
    fn name(&self) -> &str {
        &self.name
    }
    fn type_info(&self) -> &WorkspaceType {
        &self.kind
    }
}
#[derive(Debug)]
pub struct WorkspaceRow {
    columns: Arc<Vec<WorkspaceColumn>>,
    values: Vec<WireValue>,
}
impl Row for WorkspaceRow {
    type Database = Workspace;
    fn columns(&self) -> &[WorkspaceColumn] {
        &self.columns
    }
    fn try_get_raw<I: ColumnIndex<Self>>(&self, index: I) -> Result<WorkspaceValueRef<'_>, Error> {
        let i = index.index(self)?;
        self.values
            .get(i)
            .map(WorkspaceValueRef)
            .ok_or(Error::ColumnIndexOutOfBounds {
                index: i,
                len: self.values.len(),
            })
    }
}
sqlx_core::impl_column_index_for_row!(WorkspaceRow);
impl ColumnIndex<WorkspaceRow> for str {
    fn index(&self, row: &WorkspaceRow) -> Result<usize, Error> {
        row.columns
            .iter()
            .position(|c| c.name == self)
            .ok_or_else(|| Error::ColumnNotFound(self.to_string()))
    }
}

#[derive(Debug, Clone, Default)]
pub struct WorkspaceQueryResult {
    rows_affected: u64,
    last_insert_rowid: i64,
}
impl WorkspaceQueryResult {
    pub fn rows_affected(&self) -> u64 {
        self.rows_affected
    }
    pub fn last_insert_rowid(&self) -> i64 {
        self.last_insert_rowid
    }
}
impl Extend<Self> for WorkspaceQueryResult {
    fn extend<T: IntoIterator<Item = Self>>(&mut self, items: T) {
        for item in items {
            self.rows_affected += item.rows_affected;
            self.last_insert_rowid = item.last_insert_rowid;
        }
    }
}
#[derive(Default)]
pub struct WorkspaceArguments {
    values: Vec<WireValue>,
}
impl Arguments for WorkspaceArguments {
    type Database = Workspace;
    fn reserve(&mut self, additional: usize, _: usize) {
        self.values.reserve(additional);
    }
    fn add<'t, T: Encode<'t, Workspace> + Type<Workspace>>(
        &mut self,
        value: T,
    ) -> Result<(), BoxDynError> {
        let before = self.values.len();
        match value.encode(&mut self.values) {
            Ok(IsNull::Yes) => self.values.push(WireValue::Null),
            Ok(IsNull::No) => {}
            Err(error) => {
                self.values.truncate(before);
                return Err(error);
            }
        }
        Ok(())
    }
    fn len(&self) -> usize {
        self.values.len()
    }
}
sqlx_core::impl_into_arguments_for_arguments!(WorkspaceArguments);
sqlx_core::impl_encode_for_option!(Workspace);

macro_rules! integer {
    ($($ty:ty),*) => { $(
        impl Type<Workspace> for $ty { fn type_info() -> WorkspaceType { WorkspaceType::Integer } }
        impl<'q> Encode<'q, Workspace> for $ty {
            fn encode_by_ref(&self, buf: &mut Vec<WireValue>) -> Result<IsNull, BoxDynError> {
                let value = i64::try_from(*self)?;
                buf.push(WireValue::Integer { value: value.to_string() }); Ok(IsNull::No)
            }
        }
        impl<'r> Decode<'r, Workspace> for $ty {
            fn decode(value: WorkspaceValueRef<'r>) -> Result<Self, BoxDynError> {
                if let WireValue::Integer { value } = value.0 { Ok(value.parse::<i64>()?.try_into()?) }
                else { Err("expected integer".into()) }
            }
        }
    )* };
}
integer!(i8, i16, i32, i64, u8, u16, u32, u64);
impl Type<Workspace> for bool {
    fn type_info() -> WorkspaceType {
        WorkspaceType::Integer
    }
}
impl<'q> Encode<'q, Workspace> for bool {
    fn encode_by_ref(&self, buf: &mut Vec<WireValue>) -> Result<IsNull, BoxDynError> {
        i64::from(*self).encode_by_ref(buf)
    }
}
impl<'r> Decode<'r, Workspace> for bool {
    fn decode(value: WorkspaceValueRef<'r>) -> Result<Self, BoxDynError> {
        Ok(<i64 as Decode<Workspace>>::decode(value)? != 0)
    }
}
impl Type<Workspace> for f64 {
    fn type_info() -> WorkspaceType {
        WorkspaceType::Float
    }
    fn compatible(ty: &WorkspaceType) -> bool {
        matches!(ty, WorkspaceType::Float | WorkspaceType::Integer)
    }
}
impl<'q> Encode<'q, Workspace> for f64 {
    fn encode_by_ref(&self, buf: &mut Vec<WireValue>) -> Result<IsNull, BoxDynError> {
        if !self.is_finite() {
            return Err("non-finite float".into());
        }
        buf.push(WireValue::Float { value: *self });
        Ok(IsNull::No)
    }
}
impl<'r> Decode<'r, Workspace> for f64 {
    fn decode(value: WorkspaceValueRef<'r>) -> Result<Self, BoxDynError> {
        match value.0 {
            WireValue::Float { value } => Ok(*value),
            WireValue::Integer { value } => Ok(value.parse::<i64>()? as f64),
            _ => Err("expected number".into()),
        }
    }
}
impl Type<Workspace> for str {
    fn type_info() -> WorkspaceType {
        WorkspaceType::Text
    }
}
impl Type<Workspace> for String {
    fn type_info() -> WorkspaceType {
        WorkspaceType::Text
    }
}
impl<'q> Encode<'q, Workspace> for &'q str {
    fn encode_by_ref(&self, buf: &mut Vec<WireValue>) -> Result<IsNull, BoxDynError> {
        buf.push(WireValue::Text {
            value: self.to_string(),
        });
        Ok(IsNull::No)
    }
}
impl<'q> Encode<'q, Workspace> for String {
    fn encode_by_ref(&self, buf: &mut Vec<WireValue>) -> Result<IsNull, BoxDynError> {
        self.as_str().encode_by_ref(buf)
    }
}
impl<'r> Decode<'r, Workspace> for &'r str {
    fn decode(value: WorkspaceValueRef<'r>) -> Result<Self, BoxDynError> {
        match value.0 {
            WireValue::Text { value } => Ok(value),
            _ => Err("expected text".into()),
        }
    }
}
impl<'r> Decode<'r, Workspace> for String {
    fn decode(value: WorkspaceValueRef<'r>) -> Result<Self, BoxDynError> {
        Ok(<&str as Decode<Workspace>>::decode(value)?.to_owned())
    }
}
impl Type<Workspace> for [u8] {
    fn type_info() -> WorkspaceType {
        WorkspaceType::Blob
    }
}
impl Type<Workspace> for Vec<u8> {
    fn type_info() -> WorkspaceType {
        WorkspaceType::Blob
    }
}
impl<'q> Encode<'q, Workspace> for &'q [u8] {
    fn encode_by_ref(&self, buf: &mut Vec<WireValue>) -> Result<IsNull, BoxDynError> {
        buf.push(WireValue::Blob {
            base64: STANDARD.encode(self),
        });
        Ok(IsNull::No)
    }
}
impl<'q> Encode<'q, Workspace> for Vec<u8> {
    fn encode_by_ref(&self, buf: &mut Vec<WireValue>) -> Result<IsNull, BoxDynError> {
        self.as_slice().encode_by_ref(buf)
    }
}
impl<'r> Decode<'r, Workspace> for Vec<u8> {
    fn decode(value: WorkspaceValueRef<'r>) -> Result<Self, BoxDynError> {
        match value.0 {
            WireValue::Blob { base64 } => Ok(STANDARD.decode(base64)?),
            _ => Err("expected blob".into()),
        }
    }
}

#[derive(Clone)]
pub struct WorkspaceConnectOptions {
    endpoint: Url,
    token: String,
    namespace: String,
    read_only: bool,
}
impl fmt::Debug for WorkspaceConnectOptions {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("WorkspaceConnectOptions")
            .finish_non_exhaustive()
    }
}
impl WorkspaceConnectOptions {
    pub fn new(endpoint: &str, token: &str) -> Result<Self, Error> {
        let endpoint = Url::parse(endpoint).map_err(|_| protocol("invalid bridge endpoint"))?;
        if endpoint.scheme() != "http"
            || endpoint.host_str() != Some("127.0.0.1")
            || endpoint.port().is_none()
            || endpoint.path() != "/storage"
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
            || endpoint.query().is_some()
            || endpoint.fragment().is_some()
            || token.len() < 32
        {
            return Err(protocol("invalid workspace bridge configuration"));
        }
        Ok(Self {
            endpoint,
            token: token.to_owned(),
            namespace: "state".to_owned(),
            read_only: false,
        })
    }
    pub fn from_environment() -> Result<Self, Error> {
        let endpoint = std::env::var("CANTELOP_CODEX_STORAGE_URL")
            .map_err(|_| protocol("workspace bridge unavailable"))?;
        let token = std::env::var("CANTELOP_CODEX_STORAGE_TOKEN")
            .map_err(|_| protocol("workspace bridge unavailable"))?;
        Self::new(&endpoint, &token)
    }
    pub fn namespace(mut self, namespace: &str) -> Result<Self, Error> {
        if !crate::scope::valid_namespace(namespace) {
            return Err(protocol("invalid storage namespace"));
        }
        self.namespace = namespace.to_owned();
        Ok(self)
    }
    /// Restrict diagnostic pools to a single SELECT statement.
    pub fn read_only(mut self) -> Self {
        self.read_only = true;
        self
    }
}
impl FromStr for WorkspaceConnectOptions {
    type Err = Error;
    fn from_str(_: &str) -> Result<Self, Error> {
        Err(protocol(
            "use workspace bridge options, not a local database URL",
        ))
    }
}
impl ConnectOptions for WorkspaceConnectOptions {
    type Connection = WorkspaceConnection;
    fn from_url(_: &Url) -> Result<Self, Error> {
        Err(protocol("use workspace bridge options"))
    }
    fn connect(
        &self,
    ) -> impl std::future::Future<Output = Result<WorkspaceConnection, Error>> + Send + '_ {
        async move {
            let http = reqwest::Client::builder()
                .retry(reqwest::retry::never())
                .http1_only()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(30))
                .no_proxy()
                .build()
                .map_err(|_| protocol("bridge HTTP client unavailable"))?;
            Ok(WorkspaceConnection {
                options: self.clone(),
                http,
                transaction_id: None,
                depth: 0,
                rollback_pending: false,
            })
        }
    }
    fn log_statements(self, _: log::LevelFilter) -> Self {
        self
    }
    fn log_slow_statements(self, _: log::LevelFilter, _: Duration) -> Self {
        self
    }
}

pub struct WorkspaceConnection {
    options: WorkspaceConnectOptions,
    http: reqwest::Client,
    transaction_id: Option<String>,
    depth: usize,
    rollback_pending: bool,
}
impl fmt::Debug for WorkspaceConnection {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("WorkspaceConnection")
            .field("transaction_depth", &self.depth)
            .finish_non_exhaustive()
    }
}
impl WorkspaceConnection {
    async fn request(&self, input: Json) -> Result<Json, Error> {
        // Requests are sent exactly once. A transport failure can have an ambiguous commit outcome.
        let response = self
            .http
            .post(self.options.endpoint.clone())
            .bearer_auth(&self.options.token)
            .json(&input)
            .send()
            .await
            .map_err(|_| protocol("workspace database transport failed"))?;
        if !response.status().is_success() {
            return Err(protocol("workspace database operation failed"));
        }
        response
            .json()
            .await
            .map_err(|_| protocol("invalid workspace database response"))
    }
    async fn flush_rollback(&mut self) -> Result<(), Error> {
        if self.rollback_pending {
            WorkspaceTransactionManager::rollback(self).await?;
            self.rollback_pending = false;
        }
        Ok(())
    }
    async fn execute_wire(&mut self, sql: &str, args: Vec<WireValue>) -> Result<WireResult, Error> {
        if self.options.read_only {
            let trimmed = sql.trim().trim_end_matches(';').trim();
            if !trimmed.get(..6).is_some_and(|prefix| prefix.eq_ignore_ascii_case("SELECT"))
                || !trimmed.as_bytes().get(6).is_some_and(u8::is_ascii_whitespace)
                || trimmed.contains(';')
            {
                return Err(protocol("diagnostic pools only accept a single SELECT statement"));
            }
        }
        self.flush_rollback().await?;
        let sql = crate::scope::scope_sql(&self.options.namespace, sql)?;
        let mut request =
            json!({ "operation": "execute", "statement": { "sql": sql, "args": args } });
        if let Some(id) = &self.transaction_id {
            request["transactionId"] = json!(id);
        }
        serde_json::from_value(self.request(request).await?)
            .map_err(|_| protocol("invalid SQL result"))
    }
    pub async fn execute_multiple(&mut self, sql: &str) -> Result<(), Error> {
        if self.options.read_only {
            return Err(protocol("scripts are disabled on diagnostic pools"));
        }
        self.flush_rollback().await?;
        let sql = crate::scope::scope_sql(&self.options.namespace, sql)?;
        let mut input = json!({ "operation": "executeMultiple", "sql": sql });
        if let Some(id) = &self.transaction_id {
            input["transactionId"] = json!(id);
        }
        self.request(input).await?;
        Ok(())
    }
}
impl Connection for WorkspaceConnection {
    type Database = Workspace;
    type Options = WorkspaceConnectOptions;
    fn close(mut self) -> impl std::future::Future<Output = Result<(), Error>> + Send + 'static {
        async move {
            if self.depth > 0 {
                WorkspaceTransactionManager::rollback(&mut self).await?;
            }
            Ok(())
        }
    }
    fn close_hard(self) -> impl std::future::Future<Output = Result<(), Error>> + Send + 'static {
        self.close()
    }
    fn ping(&mut self) -> impl std::future::Future<Output = Result<(), Error>> + Send + '_ {
        async move {
            self.execute_wire("SELECT 1", Vec::new()).await?;
            Ok(())
        }
    }
    fn begin(
        &mut self,
    ) -> impl std::future::Future<Output = Result<Transaction<'_, Workspace>, Error>> + Send + '_
    {
        Transaction::begin(self, None)
    }
    fn shrink_buffers(&mut self) {}
    fn flush(&mut self) -> impl std::future::Future<Output = Result<(), Error>> + Send + '_ {
        self.flush_rollback()
    }
    fn should_flush(&self) -> bool {
        self.rollback_pending
    }
}
pub struct WorkspaceTransactionManager;
impl TransactionManager for WorkspaceTransactionManager {
    type Database = Workspace;
    fn begin(
        conn: &mut WorkspaceConnection,
        statement: Option<SqlStr>,
    ) -> impl std::future::Future<Output = Result<(), Error>> + Send + '_ {
        async move {
            conn.flush_rollback().await?;
            if conn.options.read_only {
                return Err(protocol("transactions are disabled on diagnostic pools"));
            }
            if conn.depth > 0 {
                return Err(protocol(
                    "nested transactions are not supported by the workspace bridge",
                ));
            }
            let mode = match statement
                .as_ref()
                .map(|s| s.as_str().trim().to_ascii_uppercase())
            {
                None => "write",
                Some(sql) if sql == "BEGIN" || sql == "BEGIN DEFERRED" => "deferred",
                Some(sql) if sql == "BEGIN IMMEDIATE" || sql == "BEGIN EXCLUSIVE" => "write",
                _ => return Err(protocol("unsupported transaction begin statement")),
            };
            let result = conn
                .request(json!({ "operation": "begin", "mode": mode }))
                .await?;
            let id = result
                .get("transactionId")
                .and_then(Json::as_str)
                .ok_or_else(|| protocol("invalid transaction response"))?;
            conn.transaction_id = Some(id.to_owned());
            conn.depth = 1;
            Ok(())
        }
    }
    fn commit(
        conn: &mut WorkspaceConnection,
    ) -> impl std::future::Future<Output = Result<(), Error>> + Send + '_ {
        async move {
            let id = conn
                .transaction_id
                .take()
                .ok_or_else(|| protocol("transaction not active"))?;
            conn.depth = 0;
            conn.rollback_pending = false;
            conn.request(json!({ "operation": "commit", "transactionId": id }))
                .await?;
            Ok(())
        }
    }
    fn rollback(
        conn: &mut WorkspaceConnection,
    ) -> impl std::future::Future<Output = Result<(), Error>> + Send + '_ {
        async move {
            let Some(id) = conn.transaction_id.take() else {
                conn.depth = 0;
                conn.rollback_pending = false;
                return Ok(());
            };
            conn.depth = 0;
            conn.rollback_pending = false;
            conn.request(json!({ "operation": "rollback", "transactionId": id }))
                .await?;
            Ok(())
        }
    }
    fn start_rollback(conn: &mut WorkspaceConnection) {
        if conn.depth > 0 {
            conn.rollback_pending = true;
        }
    }
    fn get_transaction_depth(conn: &WorkspaceConnection) -> usize {
        conn.depth
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireResult {
    columns: Vec<String>,
    rows: Vec<Vec<WireValue>>,
    rows_affected: u64,
    last_insert_rowid: Option<String>,
}
impl WireResult {
    fn into_rows(self) -> Result<(WorkspaceQueryResult, Vec<WorkspaceRow>), Error> {
        let columns = Arc::new(
            self.columns
                .into_iter()
                .enumerate()
                .map(|(ordinal, name)| WorkspaceColumn {
                    ordinal,
                    name,
                    kind: self
                        .rows
                        .iter()
                        .find_map(|r| {
                            r.get(ordinal)
                                .filter(|v| !matches!(v, WireValue::Null))
                                .map(WireValue::kind)
                        })
                        .unwrap_or(WorkspaceType::Null),
                })
                .collect::<Vec<_>>(),
        );
        let result = WorkspaceQueryResult {
            rows_affected: self.rows_affected,
            last_insert_rowid: self
                .last_insert_rowid
                .map(|id| id.parse::<i64>())
                .transpose()
                .map_err(|_| protocol("invalid row ID"))?
                .unwrap_or(0),
        };
        let mut rows = Vec::with_capacity(self.rows.len());
        for values in self.rows {
            if values.len() != columns.len() {
                return Err(protocol("SQL result column count mismatch"));
            }
            rows.push(WorkspaceRow {
                columns: columns.clone(),
                values,
            });
        }
        Ok((result, rows))
    }
}
impl<'c> Executor<'c> for &'c mut WorkspaceConnection {
    type Database = Workspace;
    fn fetch_many<'e, 'q: 'e, E>(
        self,
        mut query: E,
    ) -> BoxStream<'e, Result<Either<WorkspaceQueryResult, WorkspaceRow>, Error>>
    where
        'c: 'e,
        E: 'q + Execute<'q, Workspace>,
    {
        let raw = std::any::type_name::<E>().contains("::raw_sql::RawSql");
        let args = query
            .take_arguments()
            .map(|a| a.unwrap_or_default().values)
            .map_err(Error::Encode);
        let sql = query.sql();
        let future = async move {
            if raw {
                let _ = args?;
                self.execute_multiple(sql.as_str()).await?;
                return Ok::<_, Error>(futures_util::stream::iter(vec![Ok(Either::Left(
                    WorkspaceQueryResult::default(),
                ))]));
            }
            let (result, rows) = self.execute_wire(sql.as_str(), args?).await?.into_rows()?;
            let mut results = rows
                .into_iter()
                .map(|row| Ok(Either::Right(row)))
                .collect::<Vec<_>>();
            results.push(Ok(Either::Left(result)));
            Ok::<_, Error>(futures_util::stream::iter(results))
        };
        futures_util::stream::once(future).try_flatten().boxed()
    }
    fn fetch_optional<'e, 'q: 'e, E>(
        self,
        query: E,
    ) -> BoxFuture<'e, Result<Option<WorkspaceRow>, Error>>
    where
        'c: 'e,
        E: 'q + Execute<'q, Workspace>,
    {
        Box::pin(async move { self.fetch(query).try_next().await })
    }
    fn prepare_with<'e>(
        self,
        _: SqlStr,
        _: &'e [WorkspaceType],
    ) -> BoxFuture<'e, Result<WorkspaceStatement, Error>>
    where
        'c: 'e,
    {
        Box::pin(async { Err(protocol("explicit SQL preparation is not supported")) })
    }
    fn describe<'e>(
        self,
        _: SqlStr,
    ) -> BoxFuture<'e, Result<sqlx_core::describe::Describe<Workspace>, Error>>
    where
        'c: 'e,
    {
        Box::pin(async { Err(protocol("compile-time SQL description is not supported")) })
    }
}
#[derive(Clone)]
pub struct WorkspaceStatement {
    sql: SqlStr,
    columns: Vec<WorkspaceColumn>,
}
impl Statement for WorkspaceStatement {
    type Database = Workspace;
    fn into_sql(self) -> SqlStr {
        self.sql
    }
    fn sql(&self) -> &SqlStr {
        &self.sql
    }
    fn parameters(&self) -> Option<Either<&[WorkspaceType], usize>> {
        None
    }
    fn columns(&self) -> &[WorkspaceColumn] {
        &self.columns
    }
    sqlx_core::impl_statement_query!(WorkspaceArguments);
}
fn protocol(message: &str) -> Error {
    Error::Protocol(message.to_owned())
}
