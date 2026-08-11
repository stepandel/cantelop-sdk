import { once } from "node:events";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  WebSocket as NodeWebSocket,
  WebSocketServer,
  type RawData,
} from "ws";
import type { App } from "./app.js";
import type {
  WebSocketConnection,
  WebSocketMessage,
} from "./websocket.js";

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

interface PendingMessage {
  resolve(result: IteratorResult<WebSocketMessage>): void;
  reject(error: unknown): void;
}

class MessageQueue implements AsyncIterableIterator<WebSocketMessage> {
  private readonly buffered: WebSocketMessage[] = [];
  private readonly pending: PendingMessage[] = [];
  private done = false;
  private failure: unknown;
  private failed = false;
  private iterated = false;

  push(message: WebSocketMessage): void {
    if (this.done || this.failed) return;
    const pending = this.pending.shift();
    if (pending) pending.resolve({ done: false, value: message });
    else this.buffered.push(message);
  }

  close(): void {
    if (this.done || this.failed) return;
    this.done = true;
    for (const pending of this.pending.splice(0)) {
      pending.resolve({ done: true, value: undefined });
    }
  }

  error(failure: unknown): void {
    if (this.done || this.failed) return;
    this.failed = true;
    this.failure = failure;
    for (const pending of this.pending.splice(0)) pending.reject(failure);
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<WebSocketMessage> {
    if (this.iterated) {
      throw new Error("WebSocket messages can only be consumed once");
    }
    this.iterated = true;
    return this;
  }

  next(): Promise<IteratorResult<WebSocketMessage>> {
    const message = this.buffered.shift();
    if (message !== undefined) {
      return Promise.resolve({ done: false, value: message });
    }
    if (this.failed) return Promise.reject(this.failure);
    if (this.done) return Promise.resolve({ done: true, value: undefined });

    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
    });
  }
}

function binaryMessage(data: RawData): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  return new Uint8Array(data);
}

class NodeWebSocketConnection implements WebSocketConnection {
  private readonly queue = new MessageQueue();
  private readonly controller = new AbortController();

  constructor(private readonly socket: NodeWebSocket) {
    socket.on("message", (data, isBinary) => {
      this.queue.push(isBinary ? binaryMessage(data) : data.toString());
    });
    socket.once("close", () => {
      this.controller.abort();
      this.queue.close();
    });
    socket.once("error", (error) => {
      this.controller.abort(error);
      this.queue.error(error);
    });
  }

  get protocol(): string {
    return this.socket.protocol;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  send(message: WebSocketMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.socket.readyState !== NodeWebSocket.OPEN) {
        reject(new Error("WebSocket is not open"));
        return;
      }
      this.socket.send(message, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  close(code?: number, reason?: string): void {
    this.socket.close(code, reason);
  }

  messages(): AsyncIterable<WebSocketMessage> {
    return this.queue;
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

  const webSockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (incoming, socket, head) => {
    webSockets.handleUpgrade(incoming, socket, head, (webSocket) => {
      void (async () => {
        const connection = new NodeWebSocketConnection(webSocket);
        try {
          const { request } = await toRequest(incoming, false);
          const handled = await app.handleWebSocket(request, connection);
          if (!handled) connection.close(1008, "WebSocket route not found");
        } catch (error) {
          console.error(error);
          connection.close(1011, "WebSocket handler failed");
        }
      })();
    });
  });

  server.listen(options.port ?? 3000, options.hostname);
  return server;
}
