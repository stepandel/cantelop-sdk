/// <reference types="node" />
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_BUFFERED_BYTES = 1024 * 1024;

export interface TerminalSocket {
  send(data: Uint8Array): void;
  close(code?: number): void;
}

export interface TerminalSocketHandlers {
  binary(data: Buffer): void;
  text(data: string): void;
  closed(): void;
}

/** Rejects an upgrade before any WebSocket handshake. */
export function refuseUpgrade(socket: Duplex, status: number, reason: string): void {
  if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/** Minimal RFC 6455 server endpoint: no extensions, bounded messages, server frames unmasked. */
export function acceptTerminalSocket(request: IncomingMessage, socket: Duplex, head: Buffer, protocol: string, handlers: TerminalSocketHandlers): TerminalSocket | undefined {
  const key = request.headers["sec-websocket-key"];
  if (request.method !== "GET" || request.headers.upgrade?.toLowerCase() !== "websocket" || request.headers["sec-websocket-version"] !== "13" ||
      typeof key !== "string" || Buffer.from(key, "base64").length !== 16) {
    refuseUpgrade(socket, 400, "Bad Request");
    return undefined;
  }
  const accept = createHash("sha1").update(key + GUID).digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: ${protocol}\r\nCache-Control: no-store\r\n\r\n`);
  let pending: Buffer = head.length ? Buffer.from(head) : Buffer.alloc(0);
  let fragments: Buffer[] = [], fragmentOpcode = 0, fragmentBytes = 0;
  let open = true;
  const finish = () => {
    if (!open) return;
    open = false;
    socket.destroy();
    handlers.closed();
  };
  const frame = (opcode: number, payload: Uint8Array) => {
    if (!open || socket.destroyed) return;
    const length = payload.byteLength;
    const header = length < 126 ? Buffer.from([0x80 | opcode, length])
      : length < 65536 ? Buffer.from([0x80 | opcode, 126, length >> 8, length & 0xff])
      : (() => { const value = Buffer.alloc(10); value[0] = 0x80 | opcode; value[1] = 127; value.writeBigUInt64BE(BigInt(length), 2); return value; })();
    socket.write(Buffer.concat([header, payload]));
    // A stalled reader must not grow Sandbox memory without bound.
    if (socket.writableLength > MAX_BUFFERED_BYTES) finish();
  };
  const close = (code = 1000) => {
    if (!open) return;
    const payload = Buffer.alloc(2); payload.writeUInt16BE(code);
    frame(0x8, payload);
    open = false;
    socket.end();
    handlers.closed();
  };
  const parse = () => {
    while (open) {
      if (pending.length < 2) return;
      const first = pending[0]!, second = pending[1]!;
      const fin = (first & 0x80) !== 0, opcode = first & 0x0f, masked = (second & 0x80) !== 0;
      if ((first & 0x70) !== 0 || !masked) { close(1002); return; }
      let length = second & 0x7f, offset = 2;
      if (length === 126) { if (pending.length < 4) return; length = pending.readUInt16BE(2); offset = 4; }
      else if (length === 127) {
        if (pending.length < 10) return;
        const value = pending.readBigUInt64BE(2);
        if (value > BigInt(MAX_MESSAGE_BYTES)) { close(1009); return; }
        length = Number(value); offset = 10;
      }
      if (length > MAX_MESSAGE_BYTES) { close(1009); return; }
      if (pending.length < offset + 4 + length) return;
      const mask = pending.subarray(offset, offset + 4);
      const payload = Buffer.from(pending.subarray(offset + 4, offset + 4 + length));
      for (let index = 0; index < payload.length; index++) payload[index]! ^= mask[index % 4]!;
      pending = pending.subarray(offset + 4 + length);
      if (opcode >= 0x8) {
        if (!fin || length > 125) { close(1002); return; }
        if (opcode === 0x8) { close(); return; }
        if (opcode === 0x9) frame(0xA, payload);
        else if (opcode !== 0xA) { close(1002); return; }
        continue;
      }
      if (opcode === 0x0 ? fragmentOpcode === 0 : fragmentOpcode !== 0 || (opcode !== 0x1 && opcode !== 0x2)) { close(1002); return; }
      if (opcode !== 0x0) fragmentOpcode = opcode;
      fragmentBytes += payload.length;
      if (fragmentBytes > MAX_MESSAGE_BYTES) { close(1009); return; }
      fragments.push(payload);
      if (!fin) continue;
      const message = Buffer.concat(fragments), type = fragmentOpcode;
      fragments = []; fragmentOpcode = 0; fragmentBytes = 0;
      if (type === 0x2) handlers.binary(message);
      else {
        let text: string;
        try { text = new TextDecoder("utf-8", { fatal: true }).decode(message); }
        catch { close(1007); return; }
        handlers.text(text);
      }
    }
  };
  socket.on("data", (chunk: Buffer) => { pending = pending.length ? Buffer.concat([pending, chunk]) : chunk; parse(); });
  socket.on("error", finish);
  socket.on("close", finish);
  socket.on("end", finish);
  if (pending.length) queueMicrotask(parse);
  return Object.freeze({ send: (data: Uint8Array) => frame(0x2, data), close });
}
