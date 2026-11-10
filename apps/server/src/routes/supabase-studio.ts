import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { Database } from "../lib/database.js";
import { badRequest, conflict, HttpError } from "../lib/errors.js";
import { decryptString, hashToken } from "../lib/security.js";
import { requireSessionMutationAuth, sessionAuthentication } from "../services/auth.js";
import { panelHostnames } from "../services/panel-domains.js";
import { SupabaseStore, type SupabaseInstance } from "../services/supabase-store.js";
import type { SupabaseSecrets } from "../services/supabase-template.js";

const path = "/_shelter/studio";
const cookieName = "__Host-shelter_studio";
const stateCookie = "__Host-shelter_studio_state";
const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const params = z.object({ id: z.string().regex(/^sb_[a-f0-9]{32}$/) });
const randomToken = () => randomBytes(32).toString("base64url");
const revision = (instance: SupabaseInstance) => hashToken(`${instance.generation}:${instance.encrypted_secrets}`);
const host = (value: unknown) => typeof value === "string" ? value.toLowerCase().replace(/:443$/, "") : "";
const cookieOptions = { path: "/", httpOnly: true, secure: true, sameSite: "lax" as const };
interface AccessRow {
  token_hash: string;
  instance_id: string;
  session_token_hash: string;
  credential_revision: string;
  browser_state_hash: string | null;
  expires_at: string;
}
function uniqueCookie(request: FastifyRequest, name: string) {
  const parts = (request.headers.cookie ?? "").split(";").filter(part => part.trim().startsWith(`${name}=`));
  return parts.length === 1 ? request.cookies[name] : undefined;
}
function equalSecret(left: string, right: string) {
  return timingSafeEqual(createHash("sha256").update(left).digest(), createHash("sha256").update(right).digest());
}

export function registerSupabaseStudioRoutes(app: FastifyInstance, config: AppConfig, db: Database) {
  const store = new SupabaseStore(db);
  const byHost = (request: FastifyRequest) => store.list().find(instance => instance.status === "running" && instance.studio_hostname === host(request.headers.host));
  const valid = (row: AccessRow | undefined, instance: SupabaseInstance) => row && row.instance_id === instance.id
    && row.credential_revision === revision(instance) && row.expires_at > new Date().toISOString()
    && Boolean(db.getSession(row.session_token_hash));
  const headers = (reply: import("fastify").FastifyReply) => reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer");

  app.post("/api/supabase/:id/studio-session", {
    preHandler: requireSessionMutationAuth,
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
  }, async (request, reply) => {
    const instance = store.get(params.parse(request.params).id);
    if (instance.status !== "running") throw conflict("Start the instance before opening Studio", "INSTANCE_NOT_RUNNING");
    const panel = host(request.headers.host);
    if (!panelHostnames(db).includes(panel)) throw badRequest("Open Studio from your configured Shelter domain", "PANEL_HOST_REQUIRED");
    const { state } = z.object({ state: token.optional() }).strict().parse(request.body);
    headers(reply);
    if (!state) return { url: `https://${instance.studio_hostname}${path}/start?panel=${encodeURIComponent(panel)}` };
    const session = sessionAuthentication(request);
    const value = randomToken();
    db.sqlite.prepare("DELETE FROM supabase_studio_access WHERE expires_at <= ?").run(new Date().toISOString());
    db.sqlite.prepare("INSERT INTO supabase_studio_access VALUES (?, 'ticket', ?, ?, ?, ?, ?)").run(
      hashToken(value), instance.id, session.sessionTokenHash, revision(instance), hashToken(state), new Date(Date.now() + 60_000).toISOString(),
    );
    return { url: `https://${instance.studio_hostname}${path}/exchange#${value}` };
  });

  app.get(`${path}/start`, { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (request, reply) => {
    const instance = byHost(request);
    const { panel } = z.object({ panel: z.string() }).parse(request.query);
    if (!instance || request.protocol !== "https" || !panelHostnames(db).includes(panel)) throw new HttpError(403, "STUDIO_ACCESS", "Studio access denied");
    const state = randomToken();
    headers(reply).setCookie(stateCookie, state, { ...cookieOptions, maxAge: 180 });
    // The host-only cookie is checked when the one-use ticket returns to Studio.
    return reply.redirect(`https://${panel}/studio/${instance.id}/launch?state=${state}`, 303);
  });

  app.get(`${path}/exchange`, async (request, reply) => {
    if (!byHost(request) || request.protocol !== "https") throw new HttpError(403, "STUDIO_ACCESS", "Studio access denied");
    headers(reply);
    return reply.type("text/html").send(`<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Supabase Studio</title><script src="${path}/exchange.js" defer></script></head><body><p id="status">Supabase Studio</p></body></html>`);
  });
  app.get(`${path}/exchange.js`, async (request, reply) => {
    if (!byHost(request)) throw new HttpError(403, "STUDIO_ACCESS", "Studio access denied");
    headers(reply);
    return reply.type("application/javascript").send(`(async()=>{const ticket=location.hash.slice(1);history.replaceState(null,'',location.pathname);try{const response=await fetch('${path}/exchange',{method:'POST',headers:{'content-type':'application/json'},credentials:'same-origin',body:JSON.stringify({ticket})});if(!response.ok)throw Error();location.replace('/');}catch{document.getElementById('status').textContent=navigator.language.startsWith('de')?'Bitte Studio erneut über Shelter öffnen.':'Please reopen Studio from Shelter.';}})();`);
  });
  app.post(`${path}/exchange`, { bodyLimit: 2048, config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (request, reply) => {
    const instance = byHost(request);
    if (!instance || request.protocol !== "https" || request.headers.origin !== `https://${instance.studio_hostname}`) throw new HttpError(403, "STUDIO_ACCESS", "Studio access denied");
    const { ticket } = z.object({ ticket: token }).strict().parse(request.body);
    const state = uniqueCookie(request, stateCookie);
    const sessionValue = randomToken();
    const expiry = db.sqlite.transaction(() => {
      const row = db.sqlite.prepare("SELECT * FROM supabase_studio_access WHERE token_hash = ? AND kind = 'ticket'").get(hashToken(ticket)) as AccessRow | undefined;
      if (!valid(row, instance) || !state || row!.browser_state_hash !== hashToken(state)) throw new HttpError(403, "STUDIO_ACCESS", "Studio access denied");
      db.sqlite.prepare("DELETE FROM supabase_studio_access WHERE token_hash = ?").run(hashToken(ticket));
      const session = db.getSession(row!.session_token_hash)!;
      const expiresAt = new Date(Math.min(Date.parse(session.expires_at), Date.now() + 8 * 60 * 60_000));
      db.sqlite.prepare("INSERT INTO supabase_studio_access VALUES (?, 'session', ?, ?, ?, NULL, ?)").run(hashToken(sessionValue), instance.id, row!.session_token_hash, revision(instance), expiresAt.toISOString());
      return expiresAt;
    })();
    headers(reply).clearCookie(stateCookie, cookieOptions).setCookie(cookieName, sessionValue, { ...cookieOptions, sameSite: "strict", expires: expiry });
    return { ok: true };
  });

  app.get("/api/supabase/:id/studio-authorize", async (request, reply) => {
    headers(reply);
    // Never return the injected password through a public panel route, even if
    // a caller forges forwarded headers. Only Traefik's internal authority may call this.
    if (request.raw.socket.remoteAddress?.replace(/^::ffff:/, "") !== config.TRUSTED_PROXY_IP
      || request.headers.host !== "api:7080") return reply.code(403).send();
    const instance = store.get(params.parse(request.params).id);
    if (instance.status !== "running" || host(request.headers["x-forwarded-host"]) !== instance.studio_hostname
      || request.headers["x-forwarded-proto"] !== "https") return reply.code(403).send();
    const secrets = JSON.parse(decryptString(instance.encrypted_secrets, config.APP_SECRET)) as SupabaseSecrets;
    const authorization = `Basic ${Buffer.from(`supabase:${secrets.studioPassword}`).toString("base64")}`;
    const value = uniqueCookie(request, cookieName);
    const row = value && token.safeParse(value).success
      ? db.sqlite.prepare("SELECT * FROM supabase_studio_access WHERE token_hash = ? AND kind = 'session'").get(hashToken(value)) as AccessRow | undefined : undefined;
    if (valid(row, instance)) return reply.header("authorization", authorization).code(204).send();
    // Preserve explicit password access as a fallback; the gateway verifies it again.
    if (typeof request.headers.authorization === "string" && equalSecret(request.headers.authorization, authorization)) return reply.header("authorization", authorization).code(204).send();
    return reply.header("www-authenticate", 'Basic realm="Supabase Studio"').code(401).send();
  });
}
