import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { parse, stringify } from "yaml";
import type { SupabaseInstance, SupabaseSettings } from "./supabase-store.js";

export const SUPABASE_ASSETS = fileURLToPath(
  new URL("../../assets/supabase/", import.meta.url),
);
export const SUPABASE_VERSION = "self-hosted/v0.8.3";
export const SERVICE_ORDER = [
  "db",
  "auth",
  "rest",
  "realtime",
  "imgproxy",
  "storage",
  "meta",
  "studio",
  "api-gw",
  "functions",
] as const;
export type ServiceName = (typeof SERVICE_ORDER)[number];
export function supabaseServices(instance: Pick<SupabaseInstance, "settings_json">): ServiceName[] {
  const enabled = (JSON.parse(instance.settings_json) as SupabaseSettings).functionsEnabled === true;
  return SERVICE_ORDER.filter(service => service !== "functions" || enabled);
}
export interface SupabaseSecrets {
  databasePassword: string;
  jwtSecret: string;
  anonKey: string;
  serviceKey: string;
  studioPassword: string;
  realtimeKey: string;
  secretKeyBase: string;
  metaKey: string;
  s3Key: string;
  s3Secret: string;
  smtpPassword: string;
}
export interface ServiceDefinition {
  image: string;
  environment?: Record<string, string | number | boolean>;
  command?: string[];
  entrypoint?: string[];
  healthcheck?: {
    test: string[];
    interval?: string;
    timeout?: string;
    retries?: number;
    start_period?: string;
  };
}
interface EnvoyRoute {
  name?: string;
  match: { prefix?: string; path?: string; safe_regex?: { regex: string } };
  route?: { cluster: string; [key: string]: unknown };
  typed_per_filter_config?: Record<string, unknown>;
  [key: string]: unknown;
}
interface VirtualHost {
  name: string;
  domains: string[];
  routes: EnvoyRoute[];
  [key: string]: unknown;
}
interface ListenerConfig {
  resources: {
    filter_chains: {
      filters: {
        typed_config: {
          access_log?: unknown;
          route_config: { virtual_hosts: VirtualHost[] };
          [key: string]: unknown;
        };
      }[];
    }[];
  }[];
}

export function supabaseNames(
  instance: Pick<SupabaseInstance, "id" | "generation">,
) {
  if (
    !/^sb_[a-f0-9]{32}$/.test(instance.id) ||
    !/^gen_[a-f0-9]{32}$/.test(instance.generation)
  )
    throw new Error("Invalid managed Supabase identity");
  const prefix = `shelter-${instance.id}`;
  return {
    prefix,
    backend: `${prefix}-backend`,
    frontend: `${prefix}-frontend`,
    container: (service: string) => `${prefix}-${service}`,
    volume: (name: string) => `${prefix}-${instance.generation}-${name}`,
  };
}

export function createSupabaseSecrets(smtpPassword = ""): SupabaseSecrets {
  const jwtSecret = randomBytes(48).toString("hex");
  const token = (role: string) => {
    const header = Buffer.from(
      JSON.stringify({ alg: "HS256", typ: "JWT" }),
    ).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        role,
        iss: "supabase",
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 10 * 365 * 86400,
      }),
    ).toString("base64url");
    return `${header}.${payload}.${createHmac("sha256", jwtSecret).update(`${header}.${payload}`).digest("base64url")}`;
  };
  return {
    databasePassword: randomBytes(32).toString("hex"),
    jwtSecret,
    anonKey: token("anon"),
    serviceKey: token("service_role"),
    studioPassword: randomBytes(24).toString("hex"),
    realtimeKey: randomBytes(8).toString("hex"),
    secretKeyBase: randomBytes(48).toString("hex"),
    metaKey: randomBytes(32).toString("hex"),
    s3Key: randomBytes(16).toString("hex"),
    s3Secret: randomBytes(32).toString("hex"),
    smtpPassword,
  };
}

export function supabaseEnvironment(
  instance: SupabaseInstance,
  secrets: SupabaseSecrets,
): Record<string, string> {
  const settings = JSON.parse(instance.settings_json) as SupabaseSettings;
  const url = `https://${instance.api_hostname}`;
  return {
    POSTGRES_PASSWORD: secrets.databasePassword,
    JWT_SECRET: secrets.jwtSecret,
    ANON_KEY: secrets.anonKey,
    SERVICE_ROLE_KEY: secrets.serviceKey,
    POSTGRES_HOST: "db",
    POSTGRES_PORT: "5432",
    POSTGRES_DB: "postgres",
    JWT_EXPIRY: "3600",
    SUPABASE_PUBLIC_URL: url,
    API_EXTERNAL_URL: `${url}/auth/v1`,
    SITE_URL: settings.siteUrl,
    ADDITIONAL_REDIRECT_URLS: settings.redirectUrls.join(","),
    DISABLE_SIGNUP: settings.smtp ? "false" : "true",
    ENABLE_EMAIL_SIGNUP: settings.smtp ? "true" : "false",
    ENABLE_EMAIL_AUTOCONFIRM: "false",
    ENABLE_ANONYMOUS_USERS: "false",
    ENABLE_PHONE_SIGNUP: "false",
    ENABLE_PHONE_AUTOCONFIRM: "false",
    SMTP_HOST: settings.smtp?.host ?? "",
    SMTP_PORT: String(settings.smtp?.port ?? 587),
    SMTP_USER: settings.smtp?.user ?? "",
    SMTP_PASS: secrets.smtpPassword,
    SMTP_ADMIN_EMAIL: settings.smtp?.adminEmail ?? "",
    SMTP_SENDER_NAME: settings.smtp?.sender ?? "",
    MAILER_URLPATHS_INVITE: "/auth/v1/verify",
    MAILER_URLPATHS_CONFIRMATION: "/auth/v1/verify",
    MAILER_URLPATHS_RECOVERY: "/auth/v1/verify",
    MAILER_URLPATHS_EMAIL_CHANGE: "/auth/v1/verify",
    SECRET_KEY_BASE: secrets.secretKeyBase,
    REALTIME_DB_ENC_KEY: secrets.realtimeKey,
    PG_META_CRYPTO_KEY: secrets.metaKey,
    PGRST_DB_SCHEMAS: "public,graphql_public",
    PGRST_DB_MAX_ROWS: "1000",
    PGRST_DB_EXTRA_SEARCH_PATH: "public",
    GLOBAL_S3_BUCKET: "storage",
    STORAGE_TENANT_ID: instance.id,
    REGION: "local",
    S3_PROTOCOL_ACCESS_KEY_ID: secrets.s3Key,
    S3_PROTOCOL_ACCESS_KEY_SECRET: secrets.s3Secret,
    IMGPROXY_AUTO_WEBP: "true",
    STUDIO_DEFAULT_ORGANIZATION: "Shelter",
    STUDIO_DEFAULT_PROJECT: instance.name,
    OPENAI_API_KEY: "",
    FUNCTIONS_VERIFY_JWT: "true",
    SUPABASE_PUBLISHABLE_KEY: "",
    SUPABASE_SECRET_KEY: "",
    ANON_KEY_ASYMMETRIC: secrets.anonKey,
    SERVICE_ROLE_KEY_ASYMMETRIC: secrets.serviceKey,
    DASHBOARD_USERNAME: "supabase",
    DASHBOARD_PASSWORD: secrets.studioPassword,
    DASHBOARD_BASIC_AUTH: `supabase:{SHA}${createHash("sha1").update(secrets.studioPassword).digest("base64")}`,
  };
}

// Interpret only variables in the checked-in template, never recursively expand supplied values.
function interpolate(
  source: string,
  variables: Record<string, string>,
): string {
  let result = "";
  for (let i = 0; i < source.length;) {
    if (source.startsWith("$$", i)) {
      result += "$";
      i += 2;
      continue;
    }
    if (!source.startsWith("${", i)) {
      result += source[i++];
      continue;
    }
    const start = i + 2;
    let end = start;
    let depth = 1;
    for (; end < source.length; end++) {
      if (source.startsWith("${", end)) {
        depth++;
        end++;
      } else if (source[end] === "}" && --depth === 0) break;
    }
    if (depth) throw new Error("Invalid pinned template variable");
    const expression = source.slice(start, end);
    const match = /^([A-Z_0-9]+)(?::-([\s\S]*))?$/.exec(expression);
    if (!match?.[1]) throw new Error("Invalid pinned template expression");
    const value = variables[match[1]];
    if (value === undefined && match[2] === undefined)
      throw new Error(`Missing template variable ${match[1]}`);
    result +=
      value || (match[2] === undefined ? "" : interpolate(match[2], variables));
    i = end + 1;
  }
  return result;
}

export function supabaseTemplate(
  instance: SupabaseInstance,
  secrets: SupabaseSecrets,
) {
  const vars = supabaseEnvironment(instance, secrets);
  const upstream = parse(
    fs.readFileSync(path.join(SUPABASE_ASSETS, "upstream.yml"), "utf8"),
  ) as { services: Record<ServiceName, ServiceDefinition> };
  const manifest = JSON.parse(
    fs.readFileSync(path.join(SUPABASE_ASSETS, "manifest.json"), "utf8"),
  ) as { version: string; images: Record<ServiceName, string> };
  if (
    manifest.version !== instance.version ||
    instance.version !== SUPABASE_VERSION
  )
    throw new Error("Unsupported Supabase version");
  const services = {} as Record<ServiceName, ServiceDefinition>;
  for (const name of SERVICE_ORDER) {
    const definition = upstream.services[name];
    const image = manifest.images[name];
    if (!/^[-a-zA-Z0-9_./:]+@sha256:[a-f0-9]{64}$/.test(image))
      throw new Error("Unpinned Supabase image");
    services[name] = {
      image,
      environment: Object.fromEntries(
        Object.entries(definition.environment ?? {}).map(([key, value]) => [
          key,
          interpolate(String(value), vars),
        ]),
      ),
      ...(definition.command
        ? {
            command: definition.command.map((value) =>
              interpolate(value, vars),
            ),
          }
        : {}),
      ...(definition.healthcheck
        ? {
            healthcheck: {
              ...definition.healthcheck,
              test: definition.healthcheck.test.map((value) =>
                interpolate(value, vars),
              ),
            },
          }
        : {}),
    };
  }
  // Realtime derives its tenant from the hostname; use the upstream alias only inside this instance's isolated network.
  services.realtime.environment = {
    ...services.realtime.environment,
    ERL_AFLAGS: "+S 2:2 -proto_dist inet_tcp",
  };
  services["api-gw"] = {
    image: manifest.images["api-gw"],
    command: ["envoy", "-c", "/etc/envoy/envoy.yaml", "--concurrency", "2"],
    healthcheck: upstream.services["api-gw"].healthcheck!,
  };
  services.functions.command = ["start", "--user-worker-request-idle-timeout", "30000", "--main-service", "/opt/shelter/functions-router"];
  return { services, gateway: gatewayConfiguration(instance, vars) };
}

function gatewayConfiguration(
  instance: SupabaseInstance,
  vars: Record<string, string>,
): string {
  const config = parse(
    fs.readFileSync(
      path.join(SUPABASE_ASSETS, "envoy/lds.template.yaml"),
      "utf8",
    ),
  ) as ListenerConfig;
  const http = config.resources[0]!.filter_chains[0]!.filters[0]!.typed_config;
  // Studio's Basic authentication is ambient browser authority. Require a same-origin
  // Origin header for mutations before its internal APIs receive the request.
  const filters = http.http_filters as {
    name: string;
    typed_config: Record<string, unknown>;
  }[];
  filters.unshift({
    name: "envoy.filters.http.lua",
    typed_config: {
      "@type": "type.googleapis.com/envoy.extensions.filters.http.lua.v3.Lua",
      inline_code: `function envoy_on_request(handle)
      local headers = handle:headers()
      local host = headers:get(":authority")
      local method = headers:get(":method")
      if (host == "${instance.studio_hostname}" or host == "${instance.studio_hostname}:443") and method ~= "GET" and method ~= "HEAD" and method ~= "OPTIONS" then
        if headers:get("origin") ~= "https://${instance.studio_hostname}" then
          handle:respond({[":status"]="403"}, "Origin rejected")
        end
      end
    end`,
    },
  });
  // Request URLs can carry auth codes, access tokens and signed Storage credentials.
  delete http.access_log;
  const upstream = http.route_config.virtual_hosts[0]!;
  const functionsEnabled = (JSON.parse(instance.settings_json) as SupabaseSettings).functionsEnabled === true;
  const apiRoutes = upstream.routes.filter((route) =>
    ["auth", "rest", "storage", ...(functionsEnabled ? ["functions"] : [])].includes(route.route?.cluster ?? ""),
  );
  const websocket = structuredClone(
    upstream.routes.find((route) => route.match.prefix === "/realtime/v1/")!,
  );
  websocket.match = { path: "/realtime/v1/websocket" };
  websocket.route!.prefix_rewrite = "/socket/websocket";
  const broadcast = structuredClone(
    upstream.routes.find((route) => route.match.prefix === "/realtime/v1/api")!,
  );
  broadcast.match = { path: "/realtime/v1/api/broadcast" };
  broadcast.route!.prefix_rewrite = "/api/broadcast";
  apiRoutes.push(websocket, broadcast);
  // Require exact GraphQL boundary rather than upstream's prefix match.
  for (const route of apiRoutes)
    if (route.match.prefix === "/graphql/v1")
      route.match = { path: "/graphql/v1" };
  const studioRoutes = upstream.routes
    .filter(
      (route) =>
        route.route?.cluster === "studio" || route.route?.cluster === "meta",
    )
    .map((route) => {
      const copy = structuredClone(route);
      if (copy.typed_per_filter_config)
        delete copy.typed_per_filter_config["envoy.filters.http.basic_auth"];
      // Studio uses its own server-side database access. The protected metadata route can use the same administrator login.
      if (copy.route?.cluster === "meta")
        copy.typed_per_filter_config = {
          "envoy.filters.http.rbac": {
            "@type":
              "type.googleapis.com/envoy.extensions.filters.http.rbac.v3.RBACPerRoute",
            rbac: {
              rules: {
                action: "ALLOW",
                policies: {
                  admin: {
                    permissions: [{ any: true }],
                    principals: [{ any: true }],
                  },
                },
              },
            },
          },
        };
      return copy;
    });
  const notFound: EnvoyRoute = {
    match: { prefix: "/" },
    direct_response: { status: 404 },
    typed_per_filter_config: {
      "envoy.filters.http.basic_auth": {
        "@type": "type.googleapis.com/envoy.config.route.v3.FilterConfig",
        disabled: true,
      },
      "envoy.filters.http.rbac": {
        "@type":
          "type.googleapis.com/envoy.extensions.filters.http.rbac.v3.RBACPerRoute",
      },
    },
  };
  apiRoutes.push(notFound);
  http.route_config.virtual_hosts = [
    {
      ...structuredClone(upstream),
      name: "public-api",
      domains: [instance.api_hostname, `${instance.api_hostname}:443`, ...(functionsEnabled ? ["api-gw", "api-gw:8000"] : [])],
      routes: apiRoutes,
    },
    {
      name: "private-studio",
      domains: [instance.studio_hostname, `${instance.studio_hostname}:443`],
      routes: studioRoutes,
    },
    { name: "unknown-host", domains: ["*"], routes: [notFound] },
  ];
  // Substitute scalar values before serializing: empty strings stay strings and
  // user-supplied values cannot become YAML syntax or directives.
  const substitute = (value: unknown): unknown => {
    if (typeof value === "string") return interpolate(value, vars);
    if (Array.isArray(value)) return value.map(substitute);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, substitute(item)]),
      );
    return value;
  };
  return stringify(substitute(config));
}
