/// <reference types="node" />
import { randomUUID } from "node:crypto";
import type { Transaction, WorkspaceDatabase } from "../database.js";
import { withCodexTransaction } from "../codex-transaction.js";
import type {
  CodexCommittedEvent,
  CodexSessionMessage,
  CodexSessionSettings,
  CodexSessionUpdate,
} from "./codex-protocol.js";

export interface CodexWorkMessage extends CodexSessionMessage {
  settings?: CodexSessionSettings;
  fingerprint: string;
  outcome?: CodexSessionMessage["status"];
}
export interface CodexState {
  version: 1;
  threadId?: string;
  cursor: number;
  messages: CodexWorkMessage[];
  queue: string[];
}
const schema = `
CREATE TABLE IF NOT EXISTS cantelop_codex_sessions (
  session_id TEXT PRIMARY KEY, writer TEXT NOT NULL, state TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cantelop_codex_events (
  session_id TEXT NOT NULL, seq INTEGER NOT NULL, event TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
);`;

export class CodexWriterFenced extends Error {
  constructor() {
    super("Codex Session writer fenced");
  }
}

/** One Session's committed inbox and observation log. A new incarnation fences the old writer.
 * The platform must stop the old Sandbox before starting replacement native tools.
 */
export class CodexStateStore {
  private readonly writer: string;
  private line: Promise<unknown> = Promise.resolve();
  private failure: unknown;
  private current!: CodexState;
  private constructor(
    private readonly database: WorkspaceDatabase,
    readonly sessionId: string,
    previous?: CodexStateStore,
  ) {
    this.writer = previous?.writer ?? randomUUID();
  }
  get state(): Readonly<CodexState> {
    return this.current;
  }
  get failed(): boolean {
    return this.failure !== undefined;
  }

  static async open(
    database: WorkspaceDatabase,
    sessionId: string,
    previous?: CodexStateStore,
  ): Promise<CodexStateStore> {
    if (!sessionId || sessionId.length > 512)
      throw new TypeError("Invalid Codex Session identity");
    const store = new CodexStateStore(database, sessionId, previous);
    await database.executeMultiple(schema);
    store.current = await store.transact(async (tx) => {
      if (previous) {
        const owner = (
          await tx.execute({
            sql: "SELECT writer FROM cantelop_codex_sessions WHERE session_id=?",
            args: [sessionId],
          })
        ).rows[0];
        if (!owner || String(owner.writer) !== store.writer)
          throw new CodexWriterFenced();
      }
      const initial: CodexState = {
        version: 1,
        cursor: 0,
        messages: [],
        queue: [],
      };
      await tx.execute({
        sql: "INSERT INTO cantelop_codex_sessions VALUES (?,?,?) ON CONFLICT(session_id) DO UPDATE SET writer=excluded.writer",
        args: [sessionId, store.writer, JSON.stringify(initial)],
      });
      const row = (
        await tx.execute({
          sql: "SELECT state FROM cantelop_codex_sessions WHERE session_id=?",
          args: [sessionId],
        })
      ).rows[0];
      const state = JSON.parse(String(row?.state)) as CodexState;
      if (
        state.version !== 1 ||
        !Number.isSafeInteger(state.cursor) ||
        state.cursor < 0 ||
        !Array.isArray(state.messages) ||
        !Array.isArray(state.queue)
      )
        throw new Error("Invalid Codex Session state");
      return state;
    });
    return store;
  }

  /** Reopen this incarnation's committed state without taking ownership from a replacement. */
  reopen(database = this.database): Promise<CodexStateStore> {
    return CodexStateStore.open(database, this.sessionId, this);
  }

  /** State changes and their events commit atomically, before either becomes visible. */
  update(
    change: (state: CodexState) => CodexSessionUpdate[],
  ): Promise<CodexCommittedEvent[]> {
    const operation = this.line.then(async () => {
      if (this.failure) throw this.failure;
      const next = structuredClone(this.current);
      const events = change(next).map((event) => ({
        ...event,
        seq: ++next.cursor,
      }));
      try {
        await this.transact(async (tx) => {
          const changed = await tx.execute({
            sql: "UPDATE cantelop_codex_sessions SET state=? WHERE session_id=? AND writer=?",
            args: [JSON.stringify(next), this.sessionId, this.writer],
          });
          if (changed.rowsAffected !== 1) throw new CodexWriterFenced();
          if (events.length)
            await tx.batch(
              events.map((event) => ({
                sql: "INSERT INTO cantelop_codex_events VALUES (?,?,?)",
                args: [this.sessionId, event.seq, JSON.stringify(event)],
              })),
            );
        });
        this.current = next;
        return events;
      } catch (error) {
        // Never replay a failed or ambiguous commit in this incarnation.
        this.failure = error;
        throw error;
      }
    });
    this.line = operation.catch(() => {});
    return operation;
  }

  async events(
    after: number,
    limit: number,
  ): Promise<{
    events: CodexCommittedEvent[];
    cursor: number;
    hasMore: boolean;
  }> {
    await this.line;
    if (this.failure) throw this.failure;
    const rows = (
      await this.database.execute({
        sql: "SELECT event FROM cantelop_codex_events WHERE session_id=? AND seq>? ORDER BY seq LIMIT ?",
        args: [this.sessionId, after, limit + 1],
      })
    ).rows;
    const events: CodexCommittedEvent[] = [];
    let bytes = 0;
    for (const row of rows.slice(0, limit)) {
      const encoded = String(row.event);
      if (events.length && bytes + Buffer.byteLength(encoded) > 48 * 1024)
        break;
      events.push(JSON.parse(encoded) as CodexCommittedEvent);
      bytes += Buffer.byteLength(encoded);
    }
    return {
      events,
      cursor: events.at(-1)?.seq ?? after,
      hasMore: rows.length > events.length,
    };
  }

  private async transact<T>(
    operation: (tx: Transaction) => Promise<T>,
  ): Promise<T> {
    return withCodexTransaction(this.database, operation);
  }
}
