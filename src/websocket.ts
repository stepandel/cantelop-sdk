import type { Awaitable } from "./execution.js";

export type WebSocketMessage = string | Uint8Array;

export interface WebSocketConnection {
  readonly protocol: string;
  send(message: WebSocketMessage): Awaitable<void>;
  close(code?: number, reason?: string): void;
  messages(): AsyncIterable<WebSocketMessage>;
}
