use sqlx::Error;
use std::{collections::HashMap, sync::OnceLock};

static OBJECTS: OnceLock<HashMap<String, Vec<String>>> = OnceLock::new();
fn objects() -> &'static HashMap<String, Vec<String>> {
    OBJECTS.get_or_init(|| {
        serde_json::from_str(include_str!("../schema-map.json"))
            .expect("checked-in schema map is valid JSON")
    })
}
pub fn valid_namespace(namespace: &str) -> bool {
    objects().contains_key(namespace)
}

/// Rewrite only known Codex schema identifiers, preserving SQL literals and comments.
pub fn scope_sql(namespace: &str, sql: &str) -> Result<String, Error> {
    let names = objects()
        .get(namespace)
        .ok_or_else(|| Error::Protocol("invalid storage namespace".into()))?;
    let prefix = format!("cantelop_codex_{namespace}_");
    let bytes = sql.as_bytes();
    let mut output = String::with_capacity(sql.len());
    let mut i = 0;
    while i < bytes.len() {
        let start = i;
        if bytes[i] == b'\'' {
            i += 1;
            loop {
                if i >= bytes.len() {
                    return Err(Error::Protocol("unterminated SQL string".into()));
                }
                if bytes[i] == b'\'' {
                    i += 1;
                    if i >= bytes.len() || bytes[i] != b'\'' {
                        break;
                    }
                }
                i += 1;
            }
            output.push_str(&sql[start..i]);
        } else if bytes[i] == b'-' && bytes.get(i + 1) == Some(&b'-') {
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            output.push_str(&sql[start..i]);
        } else if bytes[i] == b'/' && bytes.get(i + 1) == Some(&b'*') {
            i += 2;
            while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                i += 1;
            }
            if i + 1 >= bytes.len() {
                return Err(Error::Protocol("unterminated SQL comment".into()));
            }
            i += 2;
            output.push_str(&sql[start..i]);
        } else if matches!(bytes[i], b'"' | b'`' | b'[') {
            let quote = bytes[i];
            let end = if quote == b'[' { b']' } else { quote };
            i += 1;
            while i < bytes.len() {
                if bytes[i] == end {
                    if end != b']' && bytes.get(i + 1) == Some(&end) {
                        i += 2;
                        continue;
                    }
                    break;
                }
                i += 1;
            }
            if i >= bytes.len() {
                return Err(Error::Protocol("unterminated SQL identifier".into()));
            }
            let name = &sql[start + 1..i];
            i += 1;
            if names.iter().any(|n| n.eq_ignore_ascii_case(name)) {
                output.push(quote as char);
                output.push_str(&prefix);
                output.push_str(name);
                output.push(end as char);
            } else {
                output.push_str(&sql[start..i]);
            }
        } else if bytes[i].is_ascii_alphabetic() || bytes[i] == b'_' {
            i += 1;
            while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_') {
                i += 1;
            }
            let name = &sql[start..i];
            if names.iter().any(|n| n.eq_ignore_ascii_case(name)) {
                output.push_str(&prefix);
            }
            output.push_str(name);
        } else {
            let ch = sql[i..].chars().next().expect("position is in bounds");
            output.push(ch);
            i += ch.len_utf8();
        }
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scopes_identifiers_but_never_sql_literals_or_comments() {
        assert_eq!(
            scope_sql(
                "state",
                "SELECT 'threads', \"threads\".id FROM threads -- threads\n/* threads */"
            )
            .unwrap(),
            "SELECT 'threads', \"cantelop_codex_state_threads\".id FROM cantelop_codex_state_threads -- threads\n/* threads */"
        );
    }
}
