import { CantelopClient } from "@cantelop/sdk";

const cantelop = new CantelopClient();

export const support = cantelop.app<{ prompt: string }, { text: string }>({
  name: "support-agent",
  runtime: {
    async receive(context) {
      await context.output.send({ text: `Support received: ${context.message.payload.prompt}` });
    },
  },
});

export const research = cantelop.app<{ topic: string }, never, { summary: string }>({
  name: "research-agent",
  runtime: {
    receive(context) {
      context.reply({ summary: `Research requested for ${context.message.payload.topic}` });
    },
  },
});
