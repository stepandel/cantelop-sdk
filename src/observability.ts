/// <reference types="node" />

import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

const MAX_PENDING_OBSERVATIONS = 256;
const MAX_PENDING_BYTES = 1024 * 1024;
const MAX_OBSERVATION_BYTES = 64 * 1024;
const MAX_BATCH_OBSERVATIONS = 64;

export type LogSeverity = "debug" | "info" | "warn" | "error";
export type ObservationAttributes = Readonly<Record<string, unknown>>;

export interface RuntimeTraceContext {
  readonly attemptId: string;
  readonly attempt: number;
  readonly requestId?: string;
  readonly traceId: string;
  readonly parentSpanId: string;
}

export type RuntimeObservation =
  | Readonly<{
      type: "span.started";
      span_id: string;
      parent_span_id?: string;
      name: string;
      kind: "internal";
      started_at: string;
      attributes: ObservationAttributes;
    }>
  | Readonly<{
      type: "span.completed";
      span_id: string;
      status: "ok" | "error";
      finished_at: string;
      attributes: ObservationAttributes;
    }>
  | Readonly<{
      type: "log.recorded";
      log_id: string;
      span_id?: string;
      severity: LogSeverity;
      body: string;
      occurred_at: string;
      attributes: ObservationAttributes;
    }>;

export interface BufferedRuntimeObservation {
  readonly cursor: number;
  readonly messageId: string | undefined;
  readonly observation: RuntimeObservation;
}

interface PendingRuntimeObservation extends BufferedRuntimeObservation {
  readonly bytes: number;
  readonly resolve: () => void;
}

interface ActiveSpan {
  readonly spanId: string;
}

export class RuntimeObservationBuffer {
  private readonly observations: PendingRuntimeObservation[] = [];
  private readonly readers = new Set<() => void>();
  private readonly capacityWaiters = new Set<() => void>();
  private nextCursor = 1;
  private pendingBytes = 0;

  async publish(messageId: string | undefined, observation: RuntimeObservation): Promise<void> {
    const encoded = encodeObservation(observation);
    const bytes = Buffer.byteLength(encoded);
    if (bytes > MAX_OBSERVATION_BYTES) {
      throw new TypeError(`Runtime observation exceeds ${MAX_OBSERVATION_BYTES} bytes`);
    }
    while (
      this.observations.length >= MAX_PENDING_OBSERVATIONS ||
      this.pendingBytes + bytes > MAX_PENDING_BYTES
    ) {
      await new Promise<void>((resolve) => this.capacityWaiters.add(resolve));
    }
    return new Promise<void>((resolve) => {
      this.observations.push({
        cursor: this.nextCursor++, messageId,
        observation: JSON.parse(encoded) as RuntimeObservation,
        bytes, resolve,
      });
      this.pendingBytes += bytes;
      for (const wake of [...this.readers]) wake();
    });
  }

  /**
   * Records synchronous runtime output without ever blocking application code.
   * Console/stdout/stderr records are dropped when the bounded observation
   * buffer is full.
   */
  publishBestEffort(messageId: string | undefined, observation: RuntimeObservation): boolean {
    const encoded = encodeObservation(observation);
    const bytes = Buffer.byteLength(encoded);
    if (bytes > MAX_OBSERVATION_BYTES ||
        this.observations.length >= MAX_PENDING_OBSERVATIONS ||
        this.pendingBytes + bytes > MAX_PENDING_BYTES) {
      return false;
    }
    this.observations.push({
      cursor: this.nextCursor++, messageId,
      observation: JSON.parse(encoded) as RuntimeObservation,
      bytes, resolve: () => undefined,
    });
    this.pendingBytes += bytes;
    for (const wake of [...this.readers]) wake();
    return true;
  }

  async read(after: number, signal?: AbortSignal, wait = true): Promise<readonly BufferedRuntimeObservation[]> {
    if (!Number.isSafeInteger(after) || after < 0) {
      throw new TypeError("Runtime observation cursor must be a non-negative integer");
    }
    this.acknowledge(after);
    while (true) {
      if (signal?.aborted) throw abortReason(signal);
      const available = this.observations
        .filter((observation) => observation.cursor > after)
        .slice(0, MAX_BATCH_OBSERVATIONS);
      if (available.length > 0) {
        return available.map(({ cursor, messageId, observation }) =>
          Object.freeze({ cursor, messageId, observation })
        );
      }
      if (!wait) return [];
      await this.waitForObservation(signal);
    }
  }

  private acknowledge(after: number): void {
    let removed = false;
    while (this.observations[0] !== undefined && this.observations[0].cursor <= after) {
      const observation = this.observations.shift()!;
      this.pendingBytes -= observation.bytes;
      observation.resolve();
      removed = true;
    }
    if (removed) {
      for (const wake of this.capacityWaiters) wake();
      this.capacityWaiters.clear();
    }
  }

  private waitForObservation(signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const ready = () => {
        cleanup();
        resolve();
      };
      const abort = () => {
        cleanup();
        reject(abortReason(signal!));
      };
      const cleanup = () => {
        this.readers.delete(ready);
        signal?.removeEventListener("abort", abort);
      };
      this.readers.add(ready);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
}

export class RuntimeObserver {
  private readonly activeSpan = new AsyncLocalStorage<ActiveSpan>();

  constructor(
    private readonly messageId: string,
    private readonly trace: RuntimeTraceContext | undefined,
    private readonly buffer: RuntimeObservationBuffer,
  ) {}

  async span<Result>(name: string, work: () => Result | Promise<Result>): Promise<Result> {
    if (typeof work !== "function") throw new TypeError("Runtime span work must be a function");
    validateName(name);
    if (this.trace === undefined) return work();

    const spanId = randomHex(8);
    const parentSpanId = this.activeSpan.getStore()?.spanId;
    await this.buffer.publish(this.messageId, Object.freeze({
      type: "span.started", span_id: spanId,
      ...(parentSpanId === undefined ? {} : { parent_span_id: parentSpanId }),
      name, kind: "internal", started_at: new Date().toISOString(), attributes: Object.freeze({}),
    }));
    let status: "ok" | "error" = "ok";
    try {
      return await this.activeSpan.run({ spanId }, work);
    } catch (error) {
      status = "error";
      throw error;
    } finally {
      await this.buffer.publish(this.messageId, Object.freeze({
        type: "span.completed", span_id: spanId, status,
        finished_at: new Date().toISOString(), attributes: Object.freeze({}),
      }));
    }
  }

  recordRuntimeLog(body: string, severity: LogSeverity, source: "console" | "stdout" | "stderr"): boolean {
    return publishRuntimeLog(
      this.buffer, this.trace === undefined ? undefined : this.messageId,
      this.trace === undefined ? undefined : this.activeSpan.getStore()?.spanId,
      body, severity, source,
    );
  }
}

export function publishUnscopedRuntimeLog(
  buffer: RuntimeObservationBuffer,
  body: string,
  severity: LogSeverity,
  source: "console" | "stdout" | "stderr",
): boolean {
  return publishRuntimeLog(buffer, undefined, undefined, body, severity, source);
}

function publishRuntimeLog(
  buffer: RuntimeObservationBuffer,
  messageId: string | undefined,
  spanId: string | undefined,
  body: string,
  severity: LogSeverity,
  source: "console" | "stdout" | "stderr",
): boolean {
  return buffer.publishBestEffort(messageId, Object.freeze({
    type: "log.recorded", log_id: `log_${randomHex(16)}`,
    ...(spanId === undefined ? {} : { span_id: spanId }),
    severity, body, occurred_at: new Date().toISOString(),
    attributes: Object.freeze({ source, automatic: true }),
  }));
}

function validateName(name: string): void {
  if (typeof name !== "string" || name.length < 1 || name.length > 256 || /[\0\r\n]/.test(name)) {
    throw new TypeError("Runtime span name must contain 1-256 characters");
  }
}

function encodeObservation(observation: RuntimeObservation): string {
  try {
    return JSON.stringify(observation);
  } catch {
    throw new TypeError("Runtime observation must be JSON serializable");
  }
}

function randomHex(bytes: number): string {
  const value = randomBytes(bytes).toString("hex");
  return /^0+$/.test(value) ? randomHex(bytes) : value;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Runtime observation read cancelled", "AbortError");
}
