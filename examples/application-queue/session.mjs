/** Application-owned persistence. No runtime or platform mailbox tables. */
export function createPersistentAgent({ run, steer = () => {} }) {
  let db;
  let current;
  const schema = [
    `CREATE TABLE IF NOT EXISTS app_intake (session_id TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(session_id,id))`,
    `CREATE TABLE IF NOT EXISTS app_jobs (sequence INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL,id TEXT NOT NULL,prompt TEXT NOT NULL,state TEXT NOT NULL,steers TEXT NOT NULL DEFAULT '[]',checkpoint TEXT,result TEXT,UNIQUE(session_id,id))`,
  ];
  const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
  const pump = context => {
    if (context.activity.active) return;
    context.activity.start(async ({ signal, output, send }) => {
      try {
        while (!signal.aborted) {
          const job = (await db.execute({ sql: `UPDATE app_jobs SET state='running' WHERE sequence=(SELECT sequence FROM app_jobs WHERE session_id=? AND state='queued' ORDER BY sequence LIMIT 1) RETURNING *`, args: [context.session.id] })).rows[0];
          if (!job) return;
          current = job.id;
          try {
            const result = await run(job.prompt, {
              signal, output,
              steers: JSON.parse(job.steers),
              checkpoint: job.checkpoint === null ? undefined : JSON.parse(job.checkpoint),
              async saveCheckpoint(value) {
                signal.throwIfAborted();
                await db.execute({ sql: `UPDATE app_jobs SET checkpoint=? WHERE session_id=? AND id=? AND state='running'`, args: [JSON.stringify(value), context.session.id, job.id] });
              },
            });
            signal.throwIfAborted();
            await db.execute({ sql: `UPDATE app_jobs SET state='done',result=? WHERE session_id=? AND id=? AND state='running'`, args: [JSON.stringify(result ?? null), context.session.id, job.id] });
          } catch (error) {
            if (!signal.aborted) await db.execute({ sql: `UPDATE app_jobs SET state='failed' WHERE session_id=? AND id=? AND state='running'`, args: [context.session.id, job.id] });
          } finally { current = undefined; }
        }
      } finally {
        // The runtime flushes this after activity settlement, so a command that
        // arrived during cancellation can start the next tracked queue pump.
        send({ type: "wake" });
      }
    });
  };
  return {
    redelivery: true,
    async onActivate(context) {
      db = await context.database();
      await db.batch(schema, "write");
      // This application's policy resumes interrupted jobs from their checkpoints.
      await db.execute({ sql: `UPDATE app_jobs SET state='queued' WHERE session_id=? AND state='running'`, args: [context.session.id] });
      const pending = await db.execute({ sql: `SELECT id FROM app_jobs WHERE session_id=? AND state='queued' LIMIT 1`, args: [context.session.id] });
      if (pending.rows.length) pump(context);
    },
    async onRecover() { /* onActivate already restored this incarnation. */ },
    async receive(context) {
      const command = context.message.payload;
      if (command.type === "wake") {
        const pending = await db.execute({ sql: `SELECT id FROM app_jobs WHERE session_id=? AND state='queued' LIMIT 1`, args: [context.session.id] });
        if (pending.rows.length) pump(context);
        return;
      }
      if (!["prompt", "steer", "cancel"].includes(command.type) || (command.type !== "cancel" && typeof command.prompt !== "string")) throw new Error("invalid command");
      const payload = canonical(command);
      const tx = await db.transaction("write");
      let duplicate = false;
      let target;
      try {
        const previous = (await tx.execute({ sql: `SELECT payload FROM app_intake WHERE session_id=? AND id=?`, args: [context.session.id, context.message.id] })).rows[0];
        if (previous) {
          if (previous.payload !== payload) throw new Error("message identity conflict");
          duplicate = true;
        } else {
          await tx.execute({ sql: `INSERT INTO app_intake VALUES(?,?,?)`, args: [context.session.id, context.message.id, payload] });
          if (command.type === "cancel") {
            await tx.execute({ sql: `UPDATE app_jobs SET state='cancelled' WHERE session_id=? AND state IN ('queued','running')`, args: [context.session.id] });
          } else if (command.type === "steer" && current) {
            target = current;
            const job = (await tx.execute({ sql: `SELECT steers FROM app_jobs WHERE session_id=? AND id=? AND state='running'`, args: [context.session.id, target] })).rows[0];
            if (job) await tx.execute({ sql: `UPDATE app_jobs SET steers=? WHERE session_id=? AND id=?`, args: [JSON.stringify([...JSON.parse(job.steers), command.prompt]), context.session.id, target] });
            else target = undefined;
          }
          if (command.type !== "cancel" && !target) await tx.execute({ sql: `INSERT INTO app_jobs(session_id,id,prompt,state) VALUES(?,?,?,'queued')`, args: [context.session.id, context.message.id, command.prompt] });
        }
        await tx.commit();
      } finally { tx.close(); }
      // The durable receipt and job/control change precede runtime acknowledgement.
      if (!duplicate && command.type === "cancel") context.activity.cancel();
      if (!duplicate && target && current === target) steer(command.prompt);
      if (command.type !== "cancel") pump(context);
    },
  };
}
