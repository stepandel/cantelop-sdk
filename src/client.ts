import { App } from "./app.js";
import { captureConfigurationContext, type ConfigurationContext } from "./app-config.js";
import type { AppOptions, CantelopClientOptions } from "./integration.js";

/** Shared connection context for any number of named Apps. */
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

  app<Message = unknown, Event = never, Reply = never, View = never>(options: AppOptions<Message, Event, Reply>): App<Message, Event, Reply, View> {
    if (this.#names.has(options?.name)) throw new TypeError(`Duplicate App name: ${options.name}`);
    const app = new App<Message, Event, Reply, View>(options, this.#context, this.#profile);
    this.#names.add(app.name);
    return app;
  }
}
