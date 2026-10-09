import type { AppSelector, CantelopClientOptions } from "./integration.js";

/** Reserved CLI/runtime injection point. Never includes control-plane login credentials. */
export const APP_CONFIGURATION_CONTEXT_KEY = "dev.cantelop.sdk.app-config.v1";
const MAX_CONFIG_BYTES = 1024 * 1024;
const APP_ID = /^app_[0-9a-f]{32}$/;
const APP_SLUG = /^(?!.*--)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export class AppConfigurationError extends Error {
  constructor(readonly code: "app_configuration_missing" | "app_configuration_invalid" | "app_not_configured" | "app_credentials_expired") {
    super({
      app_configuration_missing: "No App selected; configure an App with the CLI or pass its ID or slug",
      app_configuration_invalid: "App integration configuration is invalid",
      app_not_configured: "No integration credentials for the selected App; configure an integration profile or environment",
      app_credentials_expired: "App integration credentials have expired; refresh them with a compatible CLI",
    }[code]);
    this.name = "AppConfigurationError";
  }
}
export interface ConfiguredApp {
  readonly id: string;
  readonly slug: string;
  readonly edgeUrl?: string;
  readonly accessToken: string;
  readonly expiresAt?: string;
}
export interface AppConfigurationDocument {
  readonly schemaVersion: 1;
  readonly activeProfile: string;
  readonly profiles: Readonly<Record<string, {
    readonly defaultApp?: AppSelector;
    readonly apps: readonly ConfiguredApp[];
  }>>;
}
export interface ConfigurationContext {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly directory?: string;
  readonly injected?: AppConfigurationDocument;
  readonly localDatabaseOrigin?: string;
  /** Test seam; production resolves this through the separate Node-only adapter. */
  readonly loadLocal?: () => Promise<{ document?: AppConfigurationDocument; projectApp?: AppSelector }>;
}

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function invalid(): never { throw new AppConfigurationError("app_configuration_invalid"); }
function selector(value: unknown): AppSelector {
  if (!record(value) || Object.keys(value).length !== 1) return invalid();
  if (typeof value.id === "string" && APP_ID.test(value.id)) return { id: value.id };
  if (typeof value.slug === "string" && APP_SLUG.test(value.slug)) return { slug: value.slug };
  return invalid();
}
export function assertClientOptions(value: CantelopClientOptions<unknown, unknown, unknown>): void {
  if (!record(value)) throw new TypeError("Invalid App options");
  const allowed = ["sessionRuntime", "connection", "edgeUrl", "accessToken", "id", "slug", "profile"];
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new TypeError("Invalid App options");
  if (value.connection !== undefined) {
    if (typeof (value.connection as { fetch?: unknown })?.fetch !== "function" || ["edgeUrl", "accessToken", "id", "slug", "profile"].some(key => (value as Record<string, unknown>)[key] !== undefined)) throw new TypeError("An App connection cannot be combined with other configuration");
  } else if (value.edgeUrl !== undefined || value.accessToken !== undefined) {
    if (typeof value.edgeUrl !== "string" || typeof value.accessToken !== "string" || ["id", "slug", "profile"].some(key => (value as Record<string, unknown>)[key] !== undefined)) throw new TypeError("Explicit App transport requires an Edge URL and token only");
  } else {
    if (value.id !== undefined || value.slug !== undefined) {
      try { selector(value.id === undefined ? { slug: value.slug } : value.slug === undefined ? { id: value.id } : value); }
      catch { throw new TypeError("Select an App by exactly one valid ID or slug"); }
    }
    if (value.profile !== undefined && (typeof value.profile !== "string" || !value.profile)) throw new TypeError("Invalid App profile");
  }
}

export function parseAppConfiguration(value: unknown): AppConfigurationDocument {
  if (!record(value) || value.schemaVersion !== 1 || typeof value.activeProfile !== "string" || !value.activeProfile || !record(value.profiles) || !Object.hasOwn(value.profiles, value.activeProfile)) return invalid();
  const profiles: Record<string, AppConfigurationDocument["profiles"][string]> = Object.create(null);
  for (const [name, profile] of Object.entries(value.profiles)) {
    if (!name || !record(profile) || !Array.isArray(profile.apps) || profile.apps.length > 1000) return invalid();
    const ids = new Set<string>(), slugs = new Set<string>();
    const apps = profile.apps.map((app): ConfiguredApp => {
      if (!record(app) || typeof app.id !== "string" || !APP_ID.test(app.id) || typeof app.slug !== "string" || !APP_SLUG.test(app.slug) || typeof app.accessToken !== "string" || !app.accessToken.trim() || /[\r\n]/.test(app.accessToken)) return invalid();
      if (ids.has(app.id) || slugs.has(app.slug)) return invalid();
      ids.add(app.id); slugs.add(app.slug);
      if (app.edgeUrl !== undefined && typeof app.edgeUrl !== "string") return invalid();
      if (app.expiresAt !== undefined && (typeof app.expiresAt !== "string" || !Number.isFinite(Date.parse(app.expiresAt)))) return invalid();
      return Object.freeze({ id: app.id, slug: app.slug, accessToken: app.accessToken,
        ...(app.edgeUrl === undefined ? {} : { edgeUrl: app.edgeUrl as string }),
        ...(app.expiresAt === undefined ? {} : { expiresAt: app.expiresAt as string }),
      });
    });
    profiles[name] = Object.freeze({ apps: Object.freeze(apps), ...(profile.defaultApp === undefined ? {} : { defaultApp: Object.freeze(selector(profile.defaultApp)) }) });
  }
  return Object.freeze({ schemaVersion: 1, activeProfile: value.activeProfile, profiles: Object.freeze(profiles) });
}
function parseJSON(text: string): AppConfigurationDocument {
  if (new TextEncoder().encode(text).byteLength > MAX_CONFIG_BYTES) return invalid();
  try { return parseAppConfiguration(JSON.parse(text)); } catch { return invalid(); }
}

/** Capture runtime/environment values once so a reference cannot silently switch Apps. */
export function captureConfigurationContext(): ConfigurationContext {
  const runtime = globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined>; cwd?: () => string } };
  const source = runtime.process?.env ?? {};
  const env: Record<string, string | undefined> = {};
  for (const name of ["CANTELOP_APP_CONFIG", "CANTELOP_APP_ID", "CANTELOP_APP_SLUG", "CANTELOP_INTEGRATION_TOKEN", "CANTELOP_EDGE_URL", "CANTELOP_PROFILE", "CANTELOP_INTEGRATION_CONFIG", "CANTELOP_CONFIG", "CANTELOP_PROJECT_CONFIG", "APPDATA", "XDG_CONFIG_HOME"]) env[name] = source[name];
  const injection = Reflect.get(globalThis, Symbol.for(APP_CONFIGURATION_CONTEXT_KEY)) as unknown;
  const injected = injection === undefined ? undefined : parseAppConfiguration(injection);
  const localDatabaseOrigin = source.CANTELOP_LOCAL_DATABASE_ORIGIN;
  return Object.freeze({ env: Object.freeze(env), ...(runtime.process?.cwd === undefined ? {} : { directory: runtime.process.cwd() }), ...(injected === undefined ? {} : { injected }), ...(localDatabaseOrigin === undefined ? {} : { localDatabaseOrigin }) });
}

/** Resolve identity and matching credentials independently; never borrow another App's token. */
export async function resolveAppConfiguration(options: { readonly id?: string; readonly slug?: string; readonly profile?: string }, context: ConfigurationContext): Promise<{ edgeUrl: string; accessToken: string }> {
  const explicit = options.id !== undefined ? selector({ id: options.id }) : options.slug !== undefined ? selector({ slug: options.slug }) : undefined;
  const documents: AppConfigurationDocument[] = [];
  if (context.injected !== undefined) documents.push(context.injected);
  if (context.env.CANTELOP_APP_CONFIG !== undefined) documents.push(parseJSON(context.env.CANTELOP_APP_CONFIG));
  const envID = context.env.CANTELOP_APP_ID, envSlug = context.env.CANTELOP_APP_SLUG;
  if (envID !== undefined && !APP_ID.test(envID) || envSlug !== undefined && !APP_SLUG.test(envSlug)) return invalid();
  const environmentSelector = envID !== undefined ? { id: envID } : envSlug !== undefined ? { slug: envSlug } : undefined;
  const profileName = options.profile ?? context.env.CANTELOP_PROFILE;
  if (profileName !== undefined && !profileName) return invalid();
  const profileFor = (document: AppConfigurationDocument) => {
    const name = profileName ?? document.activeProfile;
    if (!Object.hasOwn(document.profiles, name)) throw new AppConfigurationError("app_not_configured");
    return document.profiles[name]!;
  };
  let selected = explicit ?? documents.map(document => profileFor(document).defaultApp).find(value => value !== undefined) ?? environmentSelector;
  const match = (app: { id?: string; slug?: string }) => selected !== undefined && (selected.id !== undefined ? app.id === selected.id : app.slug === selected.slug);
  const connectionFor = (app: ConfiguredApp) => {
    if (app.expiresAt !== undefined && Date.parse(app.expiresAt) <= Date.now()) throw new AppConfigurationError("app_credentials_expired");
    return { edgeUrl: app.edgeUrl ?? `https://${app.slug}.cantelop.dev`, accessToken: app.accessToken };
  };
  const findConfigured = () => {
    for (const document of documents) {
      const app = profileFor(document).apps.find(match);
      if (app) return connectionFor(app);
    }
    const token = context.env.CANTELOP_INTEGRATION_TOKEN;
    if (token !== undefined) {
      if (!token.trim() || /[\r\n]/.test(token) || environmentSelector === undefined) return invalid();
      // Environment credentials have an explicit App identity, not an unscoped global token.
      if (match({ ...(envID === undefined ? {} : { id: envID }), ...(envSlug === undefined ? {} : { slug: envSlug }) })) {
        const edgeUrl = context.env.CANTELOP_EDGE_URL ?? (envSlug === undefined ? undefined : `https://${envSlug}.cantelop.dev`);
        if (edgeUrl === undefined) throw new AppConfigurationError("app_not_configured");
        return { edgeUrl, accessToken: token };
      }
    }
    return undefined;
  };
  const configured = findConfigured();
  if (configured) return configured;
  const runtime = globalThis as typeof globalThis & { process?: { versions?: { node?: string } } };
  const local = context.loadLocal !== undefined ? await context.loadLocal() : runtime.process?.versions?.node !== undefined
    ? await (await import("#cantelop-app-config")).loadNodeAppConfiguration(context.env, { discoverProject: selected === undefined, ...(context.directory === undefined ? {} : { directory: context.directory }) })
    : {};
  if (local.document !== undefined) documents.push(local.document);
  selected ??= local.projectApp ?? (local.document === undefined ? undefined : profileFor(local.document).defaultApp);
  if (selected === undefined) throw new AppConfigurationError("app_configuration_missing");
  const resolved = findConfigured();
  if (resolved) return resolved;
  throw new AppConfigurationError("app_not_configured");
}
