import { createHash } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { Database } from "../lib/database.js";
import { conflict } from "../lib/errors.js";
import { requireSessionAuth, requireSessionMutationAuth } from "./auth.js";

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const text = (length: number) => z.string().trim().max(length).refine((value) => !/[\u0000-\u001f\u007f]/.test(value));
const link = z.union([z.literal(""), z.url().max(2048).refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password;
}, "Use an HTTPS URL without credentials")]);
function luminance(hex: string): number {
  const rgb = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map((v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return rgb[0]! * .2126 + rgb[1]! * .7152 + rgb[2]! * .0722;
}
const palette = z.object({ primary: color, background: color, foreground: color, surface: color }).strict().refine((p) => {
  const foreground = luminance(p.foreground);
  return [p.background, p.surface].every((value) => {
    const background = luminance(value);
    return (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05) >= 4.5;
  });
}, "Text must have a contrast ratio of at least 4.5:1 against the background and cards");
const image = z.string().max(700_000).refine((value) => {
  if (!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  const bytes = Buffer.from(value.slice(value.indexOf(",") + 1), "base64");
  if (bytes.length < 57 || bytes.length > 512 * 1024 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") return false;
  if (bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR") return false;
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || !height || width > 1024 || height > 1024) return false;
  let offset = 8, hasData = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    if (offset + length + 12 > bytes.length) return false;
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT") hasData = true;
    offset += length + 12;
    if (type === "IEND") return hasData && length === 0 && offset === bytes.length;
  }
  return false;
}, "Use a PNG image up to 512 KiB and 1024 × 1024 pixels").nullable();

export const BrandingSchema = z.object({
  version: z.literal(1),
  name: text(60).min(1),
  claim: text(120),
  description: text(300),
  logoLayout: z.enum(["symbol", "wordmark"]),
  logoLight: image,
  logoDark: image,
  icon: image,
  light: palette,
  dark: palette,
  supportUrl: link,
  documentationUrl: link,
  privacyUrl: link,
  legalUrl: link,
  loginMessage: text(300),
  footer: text(200)
}).strict();
export type Branding = z.infer<typeof BrandingSchema>;
export const DEFAULT_BRANDING: Branding = {
  version: 1, name: "Shelter", claim: "give your code a home",
  description: "Self-hosted deployments and domains on your own server.",
  logoLayout: "symbol", logoLight: null, logoDark: null, icon: null,
  light: { primary: "#6652df", background: "#f5f7fc", foreground: "#17243b", surface: "#ffffff" },
  dark: { primary: "#705be8", background: "#061321", foreground: "#f3f5fc", surface: "#0a1c2e" },
  supportUrl: "", documentationUrl: "", privacyUrl: "", legalUrl: "", loginMessage: "", footer: ""
};
const setting = "platform.branding.v1";
export function getBranding(database: Database): Branding {
  try {
    const saved = database.getSetting(setting);
    return saved ? BrandingSchema.parse(JSON.parse(saved)) : DEFAULT_BRANDING;
  } catch { return DEFAULT_BRANDING; }
}
export function brandingState(database: Database) {
  const profile = getBranding(database);
  return { profile, revision: createHash("sha256").update(JSON.stringify(profile)).digest("hex") };
}
export function escapeBrandHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
export function contrastText(hex: string): string {
  const values = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return values[0]! * .2126 + values[1]! * .7152 + values[2]! * .0722 > .179 ? "#000000" : "#ffffff";
}
export function brandingCss(profile: Branding): string {
  return (["light", "dark"] as const).map((mode) => {
    const p = profile[mode];
    if (JSON.stringify(p) === JSON.stringify(DEFAULT_BRANDING[mode])) return "";
    return `${mode === "light" ? ":root" : ":root.dark"}{--primary:${p.primary};--primary-foreground:${contrastText(p.primary)};--background:${p.background};--foreground:${p.foreground};--card:${p.surface};--card-foreground:${p.foreground};--popover:${p.surface};--popover-foreground:${p.foreground};--sidebar:${p.surface};--sidebar-foreground:${p.foreground};--sidebar-primary:${p.primary};--sidebar-primary-foreground:${contrastText(p.primary)};--ring:${p.primary};--sidebar-ring:${p.primary};--chart-1:${p.primary};--accent:color-mix(in srgb,${p.primary} 15%,${p.surface});--accent-foreground:${p.foreground};--sidebar-accent:color-mix(in srgb,${p.primary} 15%,${p.surface});--sidebar-accent-foreground:${p.foreground};--muted:color-mix(in srgb,${p.foreground} 6%,${p.background});--muted-foreground:color-mix(in srgb,${p.foreground} 70%,${p.background});--border:color-mix(in srgb,${p.foreground} 18%,${p.surface});--input:color-mix(in srgb,${p.foreground} 25%,${p.surface});--secondary:color-mix(in srgb,${p.foreground} 8%,${p.surface});--secondary-foreground:${p.foreground}}`;
  }).join("\n");
}
export function brandHtml(source: string, database: Database): string {
  const { profile, revision } = brandingState(database);
  const title = `${profile.name}${profile.claim ? ` — ${profile.claim}` : ""}`;
  let html = source.replace(/<title>[^<]*<\/title>/i, () => `<title>${escapeBrandHtml(title)}</title>`);
  const metadata: Record<string, string> = { "application-name": profile.name, "apple-mobile-web-app-title": profile.name, description: profile.description, "og:site_name": profile.name, "og:title": title, "og:description": profile.description };
  html = html.replace(/<meta\s+(?:name|property)="([^"]+)"\s+content="[^"]*"\s*\/>/g, (tag: string, key: string) => metadata[key] === undefined ? tag : tag.replace(/content="[^"]*"/, () => `content="${escapeBrandHtml(metadata[key]!)}"`));
  html = html.replace(/<link rel="(?:icon|apple-touch-icon)"[^>]*>/g, "");
  const bootstrap = JSON.stringify({ profile, revision }).replaceAll("<", "\\u003c");
  return html.replace("</head>", () => `<link rel="icon" href="/api/branding/assets/icon?v=${revision}" ><link rel="apple-touch-icon" href="/api/branding/assets/icon?v=${revision}"><link id="branding-theme" rel="stylesheet" href="/api/branding/theme.css?v=${revision}"><script id="platform-branding" type="application/json">${bootstrap}</script></head>`);
}

export function registerBrandingRoutes(app: FastifyInstance, database: Database, webDist: string): void {
  app.get("/api/branding", async (_request, reply) => reply.header("cache-control", "no-store").send(brandingState(database)));
  app.get("/api/branding/theme.css", async (_request, reply) => reply.header("cache-control", "no-cache").type("text/css").send(brandingCss(getBranding(database))));
  app.get<{ Params: { kind: string } }>("/api/branding/assets/:kind", async (request, reply) => {
    const key = z.enum(["icon", "logoLight", "logoDark"]).parse(request.params.kind);
    const p = getBranding(database);
    const data = p[key] ?? p.icon ?? p.logoLight ?? p.logoDark;
    reply.header("cache-control", "no-cache");
    if (data) return reply.type("image/png").send(Buffer.from(data.slice(data.indexOf(",") + 1), "base64"));
    if (p.name !== DEFAULT_BRANDING.name) {
      const letter = escapeBrandHtml(Array.from(p.name)[0]?.toUpperCase() ?? "");
      return reply.type("image/svg+xml").send(`<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" rx="96" fill="${p.light.primary}"/><text x="256" y="350" text-anchor="middle" font-family="sans-serif" font-size="320" font-weight="700" fill="${contrastText(p.light.primary)}">${letter}</text></svg>`);
    }
    // The fallback uses a fixed packaged path, never a value supplied by the user.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    try { return reply.type("image/png").send(await fs.readFile(path.join(webDist, "brand", "shelter-icon-512.png"))); }
    catch { return reply.code(404).send({ code: "NOT_FOUND" }); }
  });
  app.get("/site.webmanifest", async (_request, reply) => {
    const { profile, revision } = brandingState(database);
    return reply.header("cache-control", "no-cache").type("application/manifest+json").send({
      name: profile.name, short_name: profile.name, description: profile.description, start_url: "/", scope: "/", display: "standalone",
      theme_color: profile.light.primary, background_color: profile.light.background,
      icons: [{ src: `/api/branding/assets/icon?v=${revision}`, sizes: "any", type: profile.icon || profile.logoLight || profile.logoDark || profile.name === DEFAULT_BRANDING.name ? "image/png" : "image/svg+xml", purpose: "any" }]
    });
  });
  app.get("/api/settings/branding/export", { preHandler: requireSessionAuth }, async (_request, reply) => reply.header("cache-control", "no-store").header("content-disposition", 'attachment; filename="branding.json"').send(getBranding(database)));
  app.post<{ Body: unknown }>("/api/settings/branding/validate", { preHandler: requireSessionMutationAuth, bodyLimit: 2_200_000 }, async (request, reply) => {
    const input = z.object({ profile: BrandingSchema }).strict().parse(request.body);
    return reply.header("cache-control", "no-store").send(input);
  });
  app.put<{ Body: unknown }>("/api/settings/branding", { preHandler: requireSessionMutationAuth, bodyLimit: 2_200_000 }, async (request, reply) => {
    const input = z.object({ profile: BrandingSchema, revision: z.string().length(64) }).strict().parse(request.body);
    database.sqlite.transaction(() => {
      if (brandingState(database).revision !== input.revision) throw conflict("Branding changed. Reload before saving.", "BRANDING_CONFLICT");
      database.setSetting(setting, JSON.stringify(input.profile));
    }).immediate();
    return reply.header("cache-control", "no-store").send(brandingState(database));
  });
  app.post<{ Body: unknown }>("/api/settings/branding/reset", { preHandler: requireSessionMutationAuth }, async (request, reply) => {
    const input = z.object({ revision: z.string().length(64) }).strict().parse(request.body);
    database.sqlite.transaction(() => {
      if (brandingState(database).revision !== input.revision) throw conflict("Branding changed. Reload before resetting.", "BRANDING_CONFLICT");
      database.setSetting(setting, JSON.stringify(DEFAULT_BRANDING));
    }).immediate();
    return reply.header("cache-control", "no-store").send(brandingState(database));
  });
}
