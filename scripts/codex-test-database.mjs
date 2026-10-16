import { createClient } from "@libsql/client";

/** File-backed test infrastructure with the independent transaction connections
 * provided by production's remote libSQL client. Discard a connection after a
 * rejected BEGIN: the local driver can retain its failed prepared statement.
 */
export function createCodexTestDatabase(url) {
  const options = { url, intMode: "bigint" };
  const database = createClient(options);
  const connections = new Set();
  const close = database.close.bind(database);
  database.close = () => {
    for (const connection of connections) connection.close();
    connections.clear();
    close();
  };
  database.transaction = async (mode = "write") => {
    if (database.closed) throw new Error("Test database is closed");
    const connection = createClient(options);
    let tx;
    try {
      tx = await connection.transaction(mode);
    } catch (error) {
      connection.close();
      throw error;
    }
    connections.add(connection);
    let closed = false;
    const finish = () => {
      if (closed) return;
      closed = true;
      try {
        tx.close();
      } finally {
        connection.close();
        connections.delete(connection);
      }
    };
    return {
      execute: tx.execute.bind(tx),
      batch: tx.batch.bind(tx),
      executeMultiple: tx.executeMultiple.bind(tx),
      async commit() {
        try {
          await tx.commit();
        } finally {
          finish();
        }
      },
      async rollback() {
        try {
          await tx.rollback();
        } finally {
          finish();
        }
      },
      close: finish,
      get closed() {
        return closed || tx.closed;
      },
    };
  };
  return database;
}
