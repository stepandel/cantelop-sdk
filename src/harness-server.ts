/// <reference types="node" />

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import type {
  HarnessEnvironment,
  HarnessRuntime,
} from "./harness.js";
import { markHarnessStartup } from "./harness-startup.js";

const EXECUTION_PATH_PATTERN =
  /^\/__cantelop\/v1\/executions\/(exec_[0-9a-f]{32})$/;
const MAX_ENVELOPE_BYTES = 1024 * 1024;
const INTERNAL_PORT_VARIABLE = "CANTELOP_INTERNAL_PORT";
const EXECUTION_COMPLETE_HEADER = "X-Cantelop-SDK-Execution-Complete";

export interface HarnessRequestHandlerOptions {
  env?: HarnessEnvironment;
}

export interface HarnessServer {
  readonly server: Server;
  readonly port: number;
  /** Resolves only after the platform-owned execution socket is accepting connections. */
  readonly ready: Promise<void>;
  close(): Promise<void>;
}

type HarnessRequestHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => void;

/**
 * Creates the native HTTP protocol adapter. This lower-level entrypoint is
 * primarily useful to platform integration tests and custom native launchers.
 */
export function createHarnessRequestHandler<Input, Output, Event = never>(
  runtime: HarnessRuntime<Input, Output, Event>,
  options: HarnessRequestHandlerOptions = {},
): HarnessRequestHandler {
  return (request, response) => {
    void handleRequest(request, response, runtime, options.env ?? process.env);
  };
}

/**
 * Starts the native harness server on the port injected by Cantelop. The App's
 * harness.runtime.internal_port is the source of truth; customer code never
 * supplies a deployment port.
 */
export function serveHarness<Input, Output, Event = never>(
  runtime: HarnessRuntime<Input, Output, Event>,
): HarnessServer {
  const port = readInternalPort(process.env[INTERNAL_PORT_VARIABLE]);
  const server = createServer(createHarnessRequestHandler(runtime));
  markHarnessStartup("server_created");
  const ready = listen(server, port);
  return {
    server,
    port,
    ready,
    close: () => closeServer(server),
  };
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const listening = () => {
      server.removeListener("error", failed);
      markHarnessStartup("listener_ready");
      resolve();
    };
    const failed = (error: Error) => {
      server.removeListener("listening", listening);
      reject(error);
    };
    server.once("listening", listening);
    server.once("error", failed);
    server.listen(port, "0.0.0.0");
  });
}

async function handleRequest<Input, Output, Event>(
  request: IncomingMessage,
  response: ServerResponse,
  runtime: HarnessRuntime<Input, Output, Event>,
  env: HarnessEnvironment,
): Promise<void> {
  setBaseHeaders(response);
  const url = new URL(request.url ?? "/", "http://harness.cantelop.internal");
  const match = EXECUTION_PATH_PATTERN.exec(url.pathname);
  if (match === null || url.search !== "") {
    writeError(response, 404, "not_found");
    return;
  }
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    writeError(response, 405, "method_not_allowed");
    return;
  }
  if (!isJSONContentType(request.headers["content-type"])) {
    writeError(response, 415, "unsupported_media_type");
    return;
  }
  const executionID = match[1] as string;

  const controller = new AbortController();
  let executionSettled = false;
  const abort = () => controller.abort(new DOMException("Request cancelled", "AbortError"));
  request.once("aborted", abort);
  response.once("close", () => {
    if (!response.writableEnded) abort();
  });

  try {
    const envelope = await readRequestEnvelope(request);
    if (!isRecord(envelope) || !hasOnlyInput(envelope)) {
      writeError(response, 400, "invalid_execution_request");
      return;
    }

    let output: Output;
    try {
      output = await invokeHarness(runtime, {
        id: executionID,
        input: envelope.input as Input,
        env,
        signal: controller.signal,
        emit: () => undefined,
      });
    } finally {
      executionSettled = true;
    }
    if (controller.signal.aborted || response.destroyed) return;
    response.setHeader(EXECUTION_COMPLETE_HEADER, executionID);
    writeJSON(response, 200, { output });
  } catch (error) {
    if (controller.signal.aborted || response.destroyed) return;
    if (executionSettled) {
      response.setHeader(EXECUTION_COMPLETE_HEADER, executionID);
    }
    if (error instanceof ProtocolError) {
      writeError(response, error.status, error.code);
      return;
    }
    writeError(response, 500, "execution_failed");
  } finally {
    request.removeListener("aborted", abort);
  }
}

async function readRequestEnvelope(request: IncomingMessage): Promise<unknown> {
  const declaredLength = request.headers["content-length"];
  if (
    declaredLength !== undefined &&
    (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_ENVELOPE_BYTES)
  ) {
    throw new ProtocolError(413, "execution_input_too_large");
  }

  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
    length += bytes.byteLength;
    if (length > MAX_ENVELOPE_BYTES) {
      throw new ProtocolError(413, "execution_input_too_large");
    }
    chunks.push(bytes);
  }

  const body = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new ProtocolError(400, "invalid_execution_request");
  }
}

function invokeHarness<Input, Output, Event>(
  runtime: HarnessRuntime<Input, Output, Event>,
  context: {
    id: string;
    input: Input;
    env: HarnessEnvironment;
    signal: AbortSignal;
    emit(event: Event): void;
  },
): Output | Promise<Output> {
  return typeof runtime === "function" ? runtime(context) : runtime.run(context);
}

function readInternalPort(value: string | undefined): number {
  if (value === undefined || !/^\d+$/.test(value)) {
    throw new Error(`${INTERNAL_PORT_VARIABLE} is not configured`);
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${INTERNAL_PORT_VARIABLE} must be a TCP port between 1 and 65535`);
  }
  return port;
}

function isJSONContentType(value: string | undefined): boolean {
  return value !== undefined && /^application\/json(?:\s*;|$)/i.test(value);
}

function hasOnlyInput(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === "input";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function setBaseHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json");
}

function writeError(response: ServerResponse, status: number, code: string): void {
  writeJSON(response, status, { error: { code } });
}

function writeJSON(response: ServerResponse, status: number, value: unknown): void {
  let body: string;
  try {
    body = JSON.stringify(value);
  } catch {
    status = 500;
    body = JSON.stringify({ error: { code: "invalid_execution_output" } });
  }
  response.statusCode = status;
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.end(body);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

class ProtocolError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
