import { once } from "node:events";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { App } from "./app.js";

export interface ServeOptions {
  port?: number;
  hostname?: string;
}

interface RequestWithController {
  request: Request;
  controller: AbortController;
}

async function toRequest(
  incoming: IncomingMessage,
  includeBody: boolean,
): Promise<RequestWithController> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }

  const controller = new AbortController();
  incoming.once("aborted", () => controller.abort());

  const init: RequestInit = {
    method: incoming.method ?? "GET",
    headers,
    signal: controller.signal,
  };

  if (
    includeBody &&
    incoming.method !== "GET" &&
    incoming.method !== "HEAD"
  ) {
    const chunks: Uint8Array[] = [];
    for await (const chunk of incoming) chunks.push(chunk);
    if (chunks.length > 0) {
      init.body = new Uint8Array(Buffer.concat(chunks));
    }
  }

  return {
    request: new Request(
      `http://${incoming.headers.host ?? "localhost"}${incoming.url ?? "/"}`,
      init,
    ),
    controller,
  };
}

async function writeResponse(
  response: Response,
  outgoing: ServerResponse,
  controller: AbortController,
): Promise<void> {
  outgoing.statusCode = response.status;
  outgoing.statusMessage = response.statusText;
  response.headers.forEach((value, name) => outgoing.setHeader(name, value));

  outgoing.once("close", () => {
    if (!outgoing.writableEnded) controller.abort();
  });

  if (!response.body) {
    outgoing.end();
    return;
  }

  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!outgoing.write(value)) await once(outgoing, "drain");
    }
    outgoing.end();
  } finally {
    reader.releaseLock();
  }
}

export function serve<Input, Output, Event>(
  app: App<Input, Output, Event>,
  options: ServeOptions = {},
): Server {
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      try {
        const { request, controller } = await toRequest(incoming, true);
        const response = await app.handle(request);
        await writeResponse(response, outgoing, controller);
      } catch (error) {
        console.error(error);
        if (!outgoing.headersSent) outgoing.writeHead(500);
        outgoing.end("Internal Server Error");
      }
    })();
  });
  server.listen(options.port ?? 3000, options.hostname);
  return server;
}
