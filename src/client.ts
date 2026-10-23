import { Fleet, type FleetOptions } from "./fleet.js";
import { App } from "./app.js";
import { captureConfigurationContext, normalizeAppOptions, type ConfigurationContext } from "./app-config.js";
import { resolveEdgeConnection } from "./edge-connection.js";
import type { AppOptions, CantelopClientOptions } from "./integration.js";

/** Shared connection context for named Apps and Fleets. */
export class CantelopClient {
  readonly #context: ConfigurationContext;
  readonly #profile: string | undefined;
  readonly #names = new Set<string>();

  constructor(options: CantelopClientOptions = {}) {
    if (!options || typeof options !== "object" || Array.isArray(options) || Object.keys(options).some(key => key !== "profile") ||
        options.profile !== undefined && (typeof options.profile !== "string" || !options.profile)) throw new TypeError("Invalid CantelopClient options");
    this.#profile = options.profile;
    this.#context = captureConfigurationContext();
  }

  fleet<Message = unknown, Event = never, Reply = never, View = unknown>(options: FleetOptions<Message, Event, Reply, View>): Fleet<Message, Event, Reply, View> {
    if (options && ["connection", "edgeUrl", "accessToken"].some(key => key in options)) throw new TypeError("Fleet transport is configured through integration profiles");
    const normalized = normalizeAppOptions(options);
    if (this.#names.has(normalized.name)) throw new TypeError(`Duplicate App or Fleet name: ${normalized.name}`);
    const fleet = new Fleet(normalized, this.#context, this.#profile);
    this.#names.add(normalized.name);
    return fleet;
  }

  app<Message = unknown, Event = never, Reply = never, View = unknown>(options: AppOptions<Message, Event, Reply, View>): App<Message, Event, Reply, View> {
    const normalized = normalizeAppOptions(options);
    if (this.#names.has(normalized.name)) throw new TypeError(`Duplicate App name: ${normalized.name}`);
    const app = new App(normalized, resolveEdgeConnection(normalized, this.#context, this.#profile));
    this.#names.add(normalized.name);
    return app;
  }
}
