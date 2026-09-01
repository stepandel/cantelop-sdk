/// <reference types="node" />

import { AsyncLocalStorage } from "node:async_hooks";
import { format } from "node:util";

import {
  RuntimeObserver,
  RuntimeObservationBuffer,
  publishUnscopedRuntimeLog,
  type LogSeverity,
} from "./observability.js";

type RuntimeLogSource = "console" | "stdout" | "stderr";
type CaptureTarget = RuntimeObserver | RuntimeObservationBuffer;

const MAX_LOG_BODY = 16_384;
const activeObserver = new AsyncLocalStorage<RuntimeObserver>();
const captureSuppressed = new AsyncLocalStorage<boolean>();
const runtimeBuffers = new Set<RuntimeObservationBuffer>();
const droppedByTarget = new WeakMap<CaptureTarget, number>();
let installed = false;

export function runWithRuntimeLogContext<Result>(
  observer: RuntimeObserver,
  work: () => Result,
): Result {
  installRuntimeLogCapture();
  return activeObserver.run(observer, work);
}

export function registerRuntimeLogBuffer(buffer: RuntimeObservationBuffer): () => void {
  installRuntimeLogCapture();
  runtimeBuffers.add(buffer);
  return () => runtimeBuffers.delete(buffer);
}

export function withoutRuntimeLogCapture<Result>(work: () => Result): Result {
  return captureSuppressed.run(true, work);
}

function installRuntimeLogCapture(): void {
  if (installed) return;
  installed = true;
  patchConsole();
  patchStream(process.stdout, "stdout", "info");
  patchStream(process.stderr, "stderr", "error");
}

function patchConsole(): void {
  const levels: ReadonlyArray<["debug" | "log" | "info" | "warn" | "error", LogSeverity]> = [
    ["debug", "debug"], ["log", "info"], ["info", "info"],
    ["warn", "warn"], ["error", "error"],
  ];
  for (const [method, severity] of levels) {
    const original = console[method].bind(console);
    console[method] = (...values: unknown[]) => {
      capture(format(...values), severity, "console");
      withoutRuntimeLogCapture(() => original(...values));
    };
  }
}

function patchStream(
  stream: NodeJS.WriteStream,
  source: "stdout" | "stderr",
  severity: LogSeverity,
): void {
  const original = stream.write.bind(stream) as (...arguments_: unknown[]) => boolean;
  stream.write = ((...arguments_: unknown[]) => {
    const result = original(...arguments_);
    if (!captureSuppressed.getStore()) {
      const body = decodeChunk(arguments_[0], arguments_[1]);
      if (body !== undefined) capture(body, severity, source);
    }
    return result;
  }) as typeof stream.write;
}

function decodeChunk(chunk: unknown, encoding: unknown): string | undefined {
  if (typeof chunk === "string") return chunk;
  if (chunk instanceof Uint8Array) {
    const selected = typeof encoding === "string" && Buffer.isEncoding(encoding)
      ? encoding as BufferEncoding
      : "utf8";
    return Buffer.from(chunk).toString(selected);
  }
  return undefined;
}

function capture(rawBody: string, severity: LogSeverity, source: RuntimeLogSource): void {
  if (captureSuppressed.getStore()) return;
  const target = activeObserver.getStore() ?? soleRuntimeBuffer();
  if (target === undefined) return;
  for (const line of normalizedLines(rawBody)) record(target, line, severity, source);
}

function soleRuntimeBuffer(): RuntimeObservationBuffer | undefined {
  if (runtimeBuffers.size !== 1) return undefined;
  return runtimeBuffers.values().next().value as RuntimeObservationBuffer | undefined;
}

function normalizedLines(body: string): string[] {
  const lines: string[] = [];
  for (const rawLine of body.split(/\n/)) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.length === 0) continue;
    for (let offset = 0; offset < line.length; offset += MAX_LOG_BODY) {
      lines.push(line.slice(offset, offset + MAX_LOG_BODY));
    }
  }
  return lines;
}

function record(
  target: CaptureTarget,
  body: string,
  severity: LogSeverity,
  source: RuntimeLogSource,
): void {
  const dropped = droppedByTarget.get(target) ?? 0;
  if (dropped > 0) {
    if (!publish(target, `Cantelop dropped ${dropped} runtime log record${dropped === 1 ? "" : "s"} because the observation buffer was full`, "warn", source)) {
      droppedByTarget.set(target, dropped + 1);
      return;
    }
    droppedByTarget.delete(target);
  }
  if (!publish(target, body, severity, source)) {
    droppedByTarget.set(target, (droppedByTarget.get(target) ?? 0) + 1);
  }
}

function publish(
  target: CaptureTarget,
  body: string,
  severity: LogSeverity,
  source: RuntimeLogSource,
): boolean {
  try {
    return target instanceof RuntimeObserver
      ? target.recordRuntimeLog(body, severity, source)
      : publishUnscopedRuntimeLog(target, body, severity, source);
  } catch {
    return false;
  }
}
