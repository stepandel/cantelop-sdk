export interface EventStreamOptions<Event> extends ResponseInit {
  eventName?: (event: Event) => string | undefined;
}

export function eventStreamResponse<Event>(
  events: AsyncIterable<Event>,
  options: EventStreamOptions<Event> = {},
): Response {
  const iterator = events[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  const headers = new Headers(options.headers);
  headers.set("content-type", "text/event-stream; charset=utf-8");
  headers.set("cache-control", "no-cache");

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await iterator.next();
        if (result.done) {
          controller.close();
          return;
        }

        const name = options.eventName?.(result.value);
        const prefix = name ? `event: ${name}\n` : "";
        controller.enqueue(
          encoder.encode(`${prefix}data: ${JSON.stringify(result.value)}\n\n`),
        );
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await iterator.return?.(reason);
    },
  });

  const init: ResponseInit = { headers };
  if (options.status !== undefined) init.status = options.status;
  if (options.statusText !== undefined) init.statusText = options.statusText;
  return new Response(body, init);
}
