export function eventStreamResponse<Event>(
  events: AsyncIterable<Event>,
): Response {
  const iterator = events[Symbol.asyncIterator]();
  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const result = await iterator.next();
          if (result.done) {
            controller.close();
            return;
          }

          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(result.value)}\n\n`),
          );
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel(reason) {
        await iterator.return?.(reason);
      },
    }),
    {
      headers: {
        "cache-control": "no-cache",
        "content-type": "text/event-stream; charset=utf-8",
      },
    },
  );
}
