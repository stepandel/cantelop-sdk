/// <reference types="node" />

import type { ActivityLifecycle } from "./activity.js";
import { CursorBuffer, encodeJSON } from "./cursor-buffer.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

const MAX_OBSERVATION_BYTES = 64 * 1024;

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

interface ActiveSpan {
  readonly spanId: string;
}

export class RuntimeObservationBuffer {
  private readonly buffer = new CursorBuffer<BufferedRuntimeObservation>(
    { maxPending: 256, maxPendingBytes: 1024 * 1024, maxBatch: 64 },
    "Runtime observation",
  );
  private dropped = 0;

  /**
   * Records synchronous runtime output without ever blocking application code.
   * Console/stdout/stderr records are dropped when the bounded observation
   * buffer is full.
   */
  publishBestEffort(messageId: string | undefined, observation: RuntimeObservation): boolean {
    const encoded = encodeJSON(observation, "Runtime observation must be JSON serializable");
    const bytes = Buffer.byteLength(encoded);
    if (bytes > MAX_OBSERVATION_BYTES || !this.buffer.hasCapacity(bytes)) {
      this.dropped++;
      return false;
    }
    this.buffer.append(cursor => Object.freeze({
      cursor, messageId, observation: JSON.parse(encoded) as RuntimeObservation,
    }), bytes);
    return true;
  }

  read(after: number, signal?: AbortSignal, wait = true, acknowledge = true): Promise<readonly BufferedRuntimeObservation[]> {
    return this.buffer.read(after, signal, wait, acknowledge);
  }

  metadata() { return { ...this.buffer.metadata(), dropped: this.dropped }; }

  acknowledge(after: number): void { this.buffer.acknowledge(after); }
}

export class RuntimeObserver {
  private readonly activeSpan = new AsyncLocalStorage<ActiveSpan>();

  constructor(
    private readonly messageId: string,
    private readonly trace: RuntimeTraceContext | undefined,
    private readonly buffer: RuntimeObservationBuffer,
  ) {}

  async span<Result>(name: string, work: () => Result | Promise<Result>, attributes: Readonly<Record<string, string>> = {}): Promise<Result> {
    if (typeof work !== "function") throw new TypeError("Runtime span work must be a function");
    validateName(name);
    if (this.trace === undefined) return work();

    const spanId = randomHex(8);
    const parentSpanId = this.activeSpan.getStore()?.spanId;
    this.buffer.publishBestEffort(this.messageId, Object.freeze({
      type: "span.started", span_id: spanId,
      ...(parentSpanId === undefined ? {} : { parent_span_id: parentSpanId }),
      name, kind: "internal", started_at: new Date().toISOString(), attributes: Object.freeze({ ...attributes }),
    }));
    let status: "ok" | "error" = "ok";
    try {
      return await this.activeSpan.run({ spanId }, work);
    } catch (error) {
      status = "error";
      throw error;
    } finally {
      this.buffer.publishBestEffort(this.messageId, Object.freeze({
        type: "span.completed", span_id: spanId, status,
        finished_at: new Date().toISOString(), attributes: Object.freeze({}),
      }));
    }
  }

  recordActivity(event: ActivityLifecycle): void {
    this.buffer.publishBestEffort(this.trace === undefined ? undefined : this.messageId, Object.freeze({
      type: "log.recorded", log_id: `log_${randomHex(16)}`,
      severity: event.outcome === "failed" ? "error" : "info",
      body: `Activity ${event.outcome}`,
      occurred_at: new Date().toISOString(),
      attributes: Object.freeze({
        source: "activity", activity_id: event.activityId,
        message_id: event.messageId, outcome: event.outcome,
      }),
    }));
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

function randomHex(bytes: number): string {
  const value = randomBytes(bytes).toString("hex");
  return /^0+$/.test(value) ? randomHex(bytes) : value;
}

