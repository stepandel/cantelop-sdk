/// <reference types="node" />
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { AppAuth } from "./native-auth.js";
import { registerRuntimeLogBuffer, withoutRuntimeLogCapture } from "./runtime-log-capture.js";
import { RuntimeProtocolError } from "./runtime-messages.js";
import { SessionRuntimeAdapter, type SessionRuntimeHandlerOptions } from "./session-runtime-adapter.js";
import type { SessionRuntime } from "./session-runtime-contract.js";
import { readInternalFD, readInternalPort, writeError } from "./session-runtime-protocol.js";
import { handleRuntimeRequest } from "./session-runtime-routes.js";
import { markSessionRuntimeStartup } from "./session-runtime-startup.js";

export type { SessionRuntimeHandlerOptions } from "./session-runtime-adapter.js";

export interface SessionRuntimeServer {
  readonly server: Server;
  readonly port: number;
  /** Resolves only after the platform-owned message socket is accepting connections. */
  readonly ready: Promise<void>;
  close(): Promise<void>;
}

type SessionRuntimeHandler = (request: IncomingMessage, response: ServerResponse) => void;

/**
 * Creates the native HTTP protocol adapter. This lower-level entrypoint is
 * primarily useful to platform integration tests and custom native launchers.
 */
export function createSessionRuntimeHandler<Input, Event = never, Reply = never, View = unknown>(
  behaviour: SessionRuntime<Input, Event, Reply, View>,
  options: SessionRuntimeHandlerOptions = {},
): SessionRuntimeHandler {
  return handlerFor(new SessionRuntimeAdapter(behaviour, options));
}

function handlerFor<Input, Event, Reply, View>(runtime: SessionRuntimeAdapter<Input, Event, Reply, View>): SessionRuntimeHandler {
  return (request, response) => {
    void handleRuntimeRequest(request, response, runtime).catch((error: unknown) => {
      if (response.destroyed || response.writableEnded) return;
      if (error instanceof RuntimeProtocolError) writeError(response, error.status, error.code);
      else writeError(response, 500, "runtime_error");
    });
  };
}

/**
 * Starts the Session runtime server on the port injected by Cantelop. Customer
 * code never supplies a deployment port.
 */
export function serveSessionRuntime<Input, Event = never, Reply = never, View = unknown>(
  behaviour: SessionRuntime<Input, Event, Reply, View>,
  options: { readonly auth?: AppAuth } = {},
): SessionRuntimeServer {
  const port = readInternalPort(process.env);
  const inheritedFD = readInternalFD(process.env);
  const runtime = new SessionRuntimeAdapter(behaviour, options.auth === undefined ? {} : { auth: options.auth });
  const unregisterLogBuffer = registerRuntimeLogBuffer(runtime.observations);
  const server = createServer(handlerFor(runtime));
  withoutRuntimeLogCapture(() => markSessionRuntimeStartup("server_created"));
  const ready = listen(server, port, inheritedFD);
  return {
    server,
    port,
    ready,
    close: async () => {
      // Answer open long polls first; server.close() waits for every in-flight request.
      runtime.beginClose();
      try {
        await closeServer(server);
      } finally {
        runtime.dispose();
        unregisterLogBuffer();
      }
    },
  };
}

function listen(server: Server, port: number, inheritedFD: number | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const listening = () => {
      server.removeListener("error", failed);
      withoutRuntimeLogCapture(() => markSessionRuntimeStartup("listener_ready"));
      resolve();
    };
    const failed = (error: Error) => {
      server.removeListener("listening", listening);
      reject(error);
    };
    server.once("listening", listening);
    server.once("error", failed);
    if (inheritedFD === undefined) server.listen(port, "0.0.0.0");
    else server.listen({ fd: inheritedFD });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}
