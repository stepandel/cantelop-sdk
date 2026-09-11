import { mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

// run(prompt, activityContext) must honor cancellation and await its subprocess.
export function createSupervisedAgent({ run, outcomeDirectory }) {
  const pending = [];
  return {
    receive(context) {
      const command = context.message.payload;
      if (command.type === 'cancel') {
        pending.length = 0;
        context.activity.cancel();
        return;
      }
      if (command.type === 'prompt') pending.push({ prompt: command.prompt, messageId: context.message.id });
      if (context.activity.active || pending.length === 0) return;
      const job = pending.shift();
      context.activity.start(async activity => {
        let outcome = 'completed';
        try {
          activity.signal.throwIfAborted();
          await run(job.prompt, activity);
          activity.signal.throwIfAborted();
        } catch (error) {
          outcome = activity.signal.aborted ? 'cancelled' : 'failed';
          throw error;
        } finally {
          // Persist independently of output handoff and its aborted signal.
          await mkdir(outcomeDirectory, { recursive: true });
          const destination = join(outcomeDirectory, `${job.messageId}.json`);
          const temporary = `${destination}.tmp`;
          await writeFile(temporary, JSON.stringify({ messageId: job.messageId, outcome }));
          await rename(temporary, destination);
          // send is delivered after settlement, so the next activity can start.
          activity.send({ type: 'drain' });
        }
      }, { timeoutMs: 30 * 60 * 1000 });
    },
  };
}
