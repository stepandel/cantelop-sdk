export interface EventStreamResponseOptions<Event> extends ResponseInit {
  eventName?: (event: Event) => string | undefined;
}

function encodeEvent<Event>(
  event: Event,
  eventName?: (event: Event) => string | undefined,
): Uint8Array {
  const name = eventName?.(event);
  const prefix = name ? `event: ${name}\n` : "";
  return new TextEncoder().encode(`${prefix}data: ${JSON.stringify(event)}\n\n`);
}

export function eventStreamResponse<Event>(
  events: AsyncIterable<Event>,
  options: EventStreamResponseOptions<Event> = {},
): Response {
  const iterator = events[Symbol.asyncIterator]();
  const headers = new Headers(options.headers);
  headers.set("content-type", "text/event-stream; charset=utf-8");
  headers.set("cache-control", "no-cache");

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await iterator.next();
        if (result.done) {
          controller.close();
        } else {
          controller.enqueue(encodeEvent(result.value, options.eventName));
        }
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
