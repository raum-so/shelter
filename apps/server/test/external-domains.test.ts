import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Resolver } from "node:dns/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { Database } from "../src/lib/database.js";
import { decryptString, encryptString } from "../src/lib/security.js";
import { CloudflareService } from "../src/services/cloudflare.js";
import { ExternalDomains } from "../src/services/external-domains.js";
import { ProjectDeletionService } from "../src/services/project-deletion.js";
import type { ProjectRow } from "../src/types/models.js";

const cleanups: Array<() => Promise<void> | void> = [];
const zoneId = "a".repeat(32);
const target = "connect.provider.example";

async function fixture(environment: NodeJS.ProcessEnv = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shelter-external-"));
  const config = loadConfig({ NODE_ENV: "test", DATA_DIR: directory, WEB_DIST: path.join(directory, "web"),
    APP_SECRET: "x".repeat(64), ADMIN_EMAIL: "admin@example.com", ADMIN_PASSWORD: "test admin password",
    CLOUDFLARE_ACCOUNT_ID: "b".repeat(32), CLOUDFLARE_API_TOKEN: "test-provider-token", LOG_LEVEL: "silent", ...environment });
  const database = new Database(config);
  database.setSetting("cloudflare.tunnel_id", "owned-tunnel");
  database.setSetting("cloudflare.saas_zone_id", zoneId);
  database.setSetting("cloudflare.saas_cname_target", target);
  const app = await createApp(config, database);
  cleanups.push(async () => { await app.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@example.com", password: "test admin password" } });
  const headers = { cookie: `shelter_session=${login.cookies.find(c => c.name === "shelter_session")!.value}`,
    "x-csrf-token": login.json().csrfToken as string, host: "localhost:7080", origin: "http://localhost:7080" };
  const cloudflare = new CloudflareService(config, database);
  const service = new ExternalDomains(config, database, cloudflare);
  const makeProject = (id: string, live = true) => {
    const row: ProjectRow = { id, name: id, slug: id, source_type: "git", repository_url: "https://github.com/example/app.git",
      repository_branch: "main", source_archive: null, static_base_path: null, root_directory: ".", build_type: "node",
      dockerfile_path: "Dockerfile", port: 3000, healthcheck_path: "/", memory_limit: "1g", cpu_limit: "1",
      active_deployment_id: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    database.createProject(row);
    if (live) {
      database.createDeployment({ id: `dep-${id}`, project_id: id, status: "ready", source_ref: "main", image_tag: "app:live",
        previous_image_tag: null, internal_port: 3000, static_base_path: null, runtime_kind: "node", runtime_description: null,
        commit_sha: null, error: null, started_at: null, finished_at: null, created_at: row.created_at });
      database.updateProject(id, { active_deployment_id: `dep-${id}` });
    }
    return row;
  };
  const dnsTxt = new Map<string, string>();
  const dnsCname = new Map<string, string>();
  const dns4 = new Map<string, string[]>();
  const dns6 = new Map<string, string[]>();
  vi.spyOn(Resolver.prototype, "resolveTxt").mockImplementation(async name => dnsTxt.has(name) ? [[dnsTxt.get(name)!]] : []);
  vi.spyOn(Resolver.prototype, "resolveCname").mockImplementation(async name => dnsCname.has(name) ? [dnsCname.get(name)!] : []);
  vi.spyOn(Resolver.prototype, "resolve4").mockImplementation(async name => dns4.get(name) ?? []);
  vi.spyOn(Resolver.prototype, "resolve6").mockImplementation(async name => dns6.get(name) ?? []);
  const hostnames = new Map<string, { id: string; hostname: string; status: string; ssl: { status: string }; custom_origin_server?: string;
    ownership_verification?: { type: string; name: string; value: string } }>();
  let tls = "pending_validation";
  let failDelete = false;
  const calls: Array<{ method: string; path: string }> = [];
  const provider = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname !== "api.cloudflare.com") throw new Error("Unexpected network destination");
    const method = init?.method ?? "GET";
    calls.push({ method, path: url.pathname });
    const success = (result: unknown) => Response.json({ success: true, result });
    if (url.pathname === "/client/v4/zones") return success([{ id: zoneId, name: "provider.example", status: "active" }]);
    if (url.pathname === `/client/v4/zones/${zoneId}`) return success({ id: zoneId, name: "provider.example", status: "active", account: { id: "b".repeat(32) } });
    if (url.pathname.endsWith("/fallback_origin")) return success({ origin: target, status: "active" });
    if (url.pathname.endsWith("/dns_records")) return success([{ id: "fallback", name: target, type: "CNAME", content: "owned-tunnel.cfargotunnel.com", proxied: true }]);
    if (url.pathname.endsWith("/custom_hostnames")) {
      if (method === "GET") return success([...hostnames.values()].filter(h => h.hostname === url.searchParams.get("hostname")));
      const { hostname } = JSON.parse(String(init?.body)) as { hostname: string };
      const result = { id: `host-${hostnames.size}`, hostname, status: "active", ssl: { status: tls } };
      hostnames.set(result.id, result);
      return success(result);
    }
    const id = url.pathname.split("/").at(-1)!;
    if (hostnames.has(id)) {
      if (method === "DELETE") {
        if (failDelete) return Response.json({ success: false }, { status: 503 });
        hostnames.delete(id); return success({ id });
      }
      return success({ ...hostnames.get(id), ssl: { status: tls } });
    }
    throw new Error(`Unexpected provider request: ${method} ${url.pathname}`);
  });
  vi.stubGlobal("fetch", provider);
  const prove = (domain: ReturnType<ExternalDomains["create"]>) => {
    for (const record of domain.external!.records) {
      if (record.type === "TXT") dnsTxt.set(record.name, record.value);
      else if (record.type === "CNAME") dnsCname.set(record.name, record.value);
    }
  };
  return { config, database, app, headers, cloudflare, service, makeProject, prove, dnsTxt, dnsCname, dns4, dns6, provider, calls, hostnames,
    ready: () => { tls = "active"; }, failDeletion: (value: boolean) => { failDelete = value; } };
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

const redirectGuard = 'not starts_with(http.request.uri.path, "/.well-known/acme-challenge/")';
const redirectRule = (number: number, expression = '(http.request.scheme eq "http")') => ({
  id: String(number).repeat(32), version: "1", description: `Redirect ${number}`, enabled: true,
  ref: `redirect-${number}`, action: "redirect", expression,
  action_parameters: { from_value: { status_code: 301, target_url: { expression: 'concat("https://", http.host, http.request.uri.path)' }, preserve_query_string: true } },
  logging: { enabled: true }
});

function redirectProvider(f: Awaited<ReturnType<typeof fixture>>, rules: Array<Record<string, unknown>> | null) {
  const original = f.provider.getMockImplementation()!;
  const state = { ruleset: rules === null ? null : { id: "d".repeat(32), kind: "zone", phase: "http_request_dynamic_redirect", version: "1", rules: structuredClone(rules) },
    writes: [] as Array<Record<string, unknown>>, denied: false, failWrite: 0 };
  f.provider.mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (!url.pathname.includes("/rulesets/")) return original(input, init);
    const method = init?.method ?? "GET";
    f.calls.push({ method, path: url.pathname });
    if (state.denied) return Response.json({ success: false }, { status: 403 });
    if (!state.ruleset) return Response.json({ success: false }, { status: 404 });
    if (method === "PATCH") {
      if (state.failWrite === state.writes.length + 1) return Response.json({ success: false }, { status: 503 });
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      state.writes.push(body);
      const index = state.ruleset.rules.findIndex(rule => rule.id === url.pathname.split("/").at(-1));
      if (index < 0) throw new Error("Unknown rule");
      // Cloudflare replaces a rule definition: omitted action fields are lost.
      state.ruleset.rules[index] = { id: state.ruleset.rules[index]!.id, ...body, version: String(state.writes.length + 1) };
      state.ruleset.version = String(state.writes.length + 1);
    }
    return Response.json({ success: true, result: structuredClone(state.ruleset) });
  });
  f.database.deleteSetting("cloudflare.saas_zone_id");
  f.database.deleteSetting("cloudflare.saas_cname_target");
  return state;
}

const planPath = "/api/settings/external-domains/redirects/plan";
const setupPath = "/api/settings/external-domains";
const setupPayload = { zoneId, cnameTarget: target };

describe("certificate redirect setup API", () => {
  it("previews before writing, preserves complete redirect actions and order, and is idempotent", async () => {
    const f = await fixture();
    const original = [redirectRule(1), { ...redirectRule(2), enabled: false }, redirectRule(3, `((http.host eq "other.example") and ${redirectGuard}) or true`)];
    const provider = redirectProvider(f, original);
    const inspected = await f.app.inject({ method: "POST", url: planPath, headers: f.headers, payload: setupPayload });
    expect(inspected.statusCode).toBe(200);
    const plan = inspected.json().plan;
    expect(plan.changes.map((rule: { id: string }) => rule.id)).toEqual([original[0]!.id, original[2]!.id]);
    expect(provider.writes).toHaveLength(0);
    expect(f.database.getSetting("cloudflare.saas_zone_id")).toBeUndefined();
    const saved = await f.app.inject({ method: "PUT", url: setupPath, headers: f.headers, payload: { ...setupPayload, redirectPlanToken: plan.token } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().externalDomains.configured).toBe(true);
    expect(provider.ruleset!.rules.map(rule => rule.id)).toEqual(original.map(rule => rule.id));
    for (const index of [0, 2]) {
      expect(provider.ruleset!.rules[index]).toMatchObject({ ...original[index], version: String(index === 0 ? 2 : 3), expression: `(${original[index]!.expression}) and ${redirectGuard}` });
    }
    expect(provider.ruleset!.rules[1]).toEqual(original[1]);
    const backup = JSON.parse(decryptString(f.database.getSetting(`cloudflare.acme_redirect_backup.${zoneId}`)!, f.config.APP_SECRET));
    expect(backup.ruleset.rules).toEqual(original);
    const again = await f.app.inject({ method: "POST", url: planPath, headers: f.headers, payload: setupPayload });
    expect(again.json().plan.changes).toEqual([]);
    await f.app.inject({ method: "PUT", url: setupPath, headers: f.headers, payload: { ...setupPayload, redirectPlanToken: again.json().plan.token } });
    expect(provider.writes).toHaveLength(2);
    expect(f.calls.filter(call => call.method !== "GET").every(call => call.method === "PATCH" && call.path.includes("/rulesets/"))).toBe(true);
  });

  it.each(["drift", "session", "expiry"])("rejects a stale or mismatched preview (%s) without provider writes", async reason => {
    const f = await fixture(); const provider = redirectProvider(f, [redirectRule(1)]);
    const plan = (await f.app.inject({ method: "POST", url: planPath, headers: f.headers, payload: setupPayload })).json().plan;
    let headers = f.headers;
    if (reason === "drift") provider.ruleset!.rules[0]!.description = "Changed by operator";
    if (reason === "session") {
      const login = await f.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@example.com", password: "test admin password" } });
      headers = { ...headers, cookie: `shelter_session=${login.cookies.find(c => c.name === "shelter_session")!.value}`, "x-csrf-token": login.json().csrfToken };
    }
    if (reason === "expiry") vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6 * 60_000);
    const result = await f.app.inject({ method: "PUT", url: setupPath, headers,
      payload: { ...setupPayload, redirectPlanToken: plan.token } });
    expect(result.statusCode).toBe(409);
    expect(result.json().code).toBe(reason === "drift" ? "ACME_REDIRECT_DRIFT" : "ACME_REDIRECT_PLAN_EXPIRED");
    expect(provider.writes).toHaveLength(0);
    expect(f.database.getSetting("cloudflare.saas_zone_id")).toBeUndefined();
  });

  it.each([null, [{ ...redirectRule(1), expression: `((http.request.scheme eq "http")) and ${redirectGuard}` }]])("saves without writes when no exception is needed: %j", async rules => {
    const f = await fixture(); const provider = redirectProvider(f, rules);
    const response = await f.app.inject({ method: "POST", url: planPath, headers: f.headers, payload: setupPayload });
    expect(response.statusCode).toBe(200);
    expect(response.json().plan.changes).toEqual([]);
    const result = await f.app.inject({ method: "PUT", url: setupPath, headers: f.headers, payload: { ...setupPayload, redirectPlanToken: response.json().plan.token } });
    expect(result.statusCode).toBe(200);
    expect(provider.writes).toHaveLength(0);
  });

  it.each(["permission", "unknown field", "unsupported action"])("requires manual attention instead of unsafe changes (%s)", async reason => {
    const f = await fixture(); const provider = redirectProvider(f, [{ ...redirectRule(1), ...(reason === "unknown field" ? { future_option: true } : {}), ...(reason === "unsupported action" ? { action: "execute" } : {}) }]);
    provider.denied = reason === "permission";
    const response = await f.app.inject({ method: "POST", url: planPath, headers: f.headers, payload: setupPayload });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe(reason === "permission" ? "ACME_REDIRECT_PERMISSION_REQUIRED" : "ACME_REDIRECT_UNSUPPORTED");
    expect(provider.writes).toHaveLength(0);
    expect(f.database.getSetting("cloudflare.saas_zone_id")).toBeUndefined();
  });

  it("keeps partial results visible, requires a new preview and retries only remaining rules", async () => {
    const f = await fixture(); const provider = redirectProvider(f, [redirectRule(1), redirectRule(2)]);
    const plan = (await f.app.inject({ method: "POST", url: planPath, headers: f.headers, payload: setupPayload })).json().plan;
    provider.failWrite = 2;
    const failed = await f.app.inject({ method: "PUT", url: setupPath, headers: f.headers, payload: { ...setupPayload, redirectPlanToken: plan.token } });
    expect(failed.statusCode).toBe(502);
    expect(provider.writes).toHaveLength(1);
    expect(f.database.getSetting("cloudflare.saas_zone_id")).toBeUndefined();
    const replay = await f.app.inject({ method: "PUT", url: setupPath, headers: f.headers, payload: { ...setupPayload, redirectPlanToken: plan.token } });
    expect(replay.json().code).toBe("ACME_REDIRECT_PLAN_EXPIRED");
    provider.failWrite = 0;
    const next = (await f.app.inject({ method: "POST", url: planPath, headers: f.headers, payload: setupPayload })).json().plan;
    expect(next.changes.map((rule: { id: string }) => rule.id)).toEqual([redirectRule(2).id]);
    const saved = await f.app.inject({ method: "PUT", url: setupPath, headers: f.headers, payload: { ...setupPayload, redirectPlanToken: next.token } });
    expect(saved.statusCode).toBe(200);
    expect(provider.writes).toHaveLength(2);
  });

  it("requires a CSRF-protected admin session to inspect rules", async () => {
    const f = await fixture(); const provider = redirectProvider(f, [redirectRule(1)]);
    for (const headers of [{}, { cookie: f.headers.cookie }]) {
      const result = await f.app.inject({ method: "POST", url: planPath, headers, payload: setupPayload });
      expect([401, 403]).toContain(result.statusCode);
    }
    expect(provider.writes).toHaveLength(0);
    expect(f.calls).toHaveLength(0);
  });
});

describe("external customer domain lifecycle", () => {
  it("uses the dedicated verification resolver when host DNS still has a negative cache entry", async () => {
    const f = await fixture({ EXTERNAL_DOMAIN_DNS_SERVERS: "192.0.2.53" });
    f.makeProject("app");
    const domain = f.service.create("app", "portal.customer.example");
    f.prove(domain);
    vi.mocked(Resolver.prototype.resolveTxt).mockImplementation(async function (this: Resolver, name: string) {
      return this.getServers().includes("192.0.2.53") && f.dnsTxt.has(name) ? [[f.dnsTxt.get(name)!]] : [];
    });
    const checked = await f.service.verify(domain.id);
    expect(checked.external?.ownershipVerified).toBe(true);
    expect(checked.external?.phase).toBe("certificate");
  });

  it("defaults verification to public recursive DNS and validates operator overrides", () => {
    expect(loadConfig({ NODE_ENV: "test" }).EXTERNAL_DOMAIN_DNS_SERVERS).toEqual(["1.1.1.1", "8.8.8.8"]);
    expect(loadConfig({ NODE_ENV: "test", EXTERNAL_DOMAIN_DNS_SERVERS: "192.0.2.53, 2001:db8::53" }).EXTERNAL_DOMAIN_DNS_SERVERS)
      .toEqual(["192.0.2.53", "2001:db8::53"]);
    expect(() => loadConfig({ NODE_ENV: "test", EXTERNAL_DOMAIN_DNS_SERVERS: "resolver.example.com" })).toThrow();
  });

  it("requires ownership, correct CNAME, an active certificate and a deployment before routing", async () => {
    const f = await fixture(); f.makeProject("shared");
    const domain = f.service.create("shared", "portal.customer.example");
    expect((await f.service.verify(domain.id)).external?.phase).toBe("ownership");
    expect(f.calls).toHaveLength(0);
    f.prove(domain); f.dnsCname.clear();
    expect((await f.service.verify(domain.id)).external?.phase).toBe("dns");
    expect(f.calls).toHaveLength(0);
    f.prove(domain);
    expect((await f.service.verify(domain.id)).external?.phase).toBe("certificate");
    expect(fs.readFileSync(f.config.traefikConfigPath, "utf8")).not.toContain("portal.customer.example");
    f.ready();
    expect((await f.service.verify(domain.id)).status).toBe("active");
    const routing = fs.readFileSync(f.config.traefikConfigPath, "utf8");
    expect(routing).toContain("portal.customer.example"); expect(routing).toContain("passHostHeader: true");
    f.dnsCname.clear();
    expect((await f.service.verify(domain.id)).external?.phase).toBe("dns");
    expect(fs.readFileSync(f.config.traefikConfigPath, "utf8")).not.toContain("portal.customer.example");
  });

  it("supports shared and dedicated projects while preventing domain reassignment", async () => {
    const f = await fixture(); f.makeProject("shared"); f.makeProject("dedicated"); f.ready();
    for (const [project, hostname] of [["shared", "one.customer.example"], ["shared", "two.customer.example"], ["dedicated", "three.customer.example"]]) {
      const domain = f.service.create(project!, hostname!); f.prove(domain);
      expect((await f.service.verify(domain.id)).status).toBe("active");
    }
    expect(f.database.listDomains("shared")).toHaveLength(2); expect(f.database.listDomains("dedicated")).toHaveLength(1);
    expect(() => f.service.create("dedicated", "one.customer.example")).toThrow("already assigned");
    const routing = fs.readFileSync(f.config.traefikConfigPath, "utf8");
    expect(routing).toContain("service: shared"); expect(routing).toContain("service: dedicated");
  });

  it("resumes a pre-upgrade CNAME binding without recreating the certificate", async () => {
    const f = await fixture(); f.makeProject("app", false);
    const domain = f.service.create("app", "pending.customer.example"); f.prove(domain);
    await f.service.verify(domain.id);
    // Emulate a database last opened by the subdomain-only version.
    f.database.sqlite.exec("ALTER TABLE external_domains DROP COLUMN dns_mode");
    const reopened = new Database(f.config);
    const resumed = new ExternalDomains(f.config, reopened, new CloudflareService(f.config, reopened));
    reopened.recoverPendingDomains();
    expect(reopened.getDomain(domain.id)?.status).toBe("pending");
    f.ready();
    expect((await resumed.verify(domain.id)).external).toMatchObject({
      phase: "deployment", dnsMode: "cname", records: expect.arrayContaining([{ type: "CNAME", name: domain.hostname, value: target }])
    });
    expect(f.calls.filter(c => c.method === "POST")).toHaveLength(1);
    reopened.close();
  });

  it("quarantines failed deletion, retries cleanup and never deletes customer DNS", async () => {
    const f = await fixture(); f.makeProject("app"); f.ready();
    const domain = f.service.create("app", "delete.customer.example"); f.prove(domain); await f.service.verify(domain.id);
    f.failDeletion(true);
    await expect(f.service.remove(domain.id)).rejects.toThrow();
    expect(fs.readFileSync(f.config.traefikConfigPath, "utf8")).not.toContain("delete.customer.example");
    expect(f.service.present(f.database.getDomain(domain.id)!).external?.phase).toBe("removing");
    f.failDeletion(false); await f.service.remove(domain.id);
    expect(f.database.getDomain(domain.id)).toBeUndefined();
    expect(f.calls.some(c => c.method === "DELETE" && c.path.includes("dns_records"))).toBe(false);
  });

  it("does not adopt a foreign hostname or delete one whose origin has changed", async () => {
    const f = await fixture(); f.makeProject("app"); f.ready();
    f.hostnames.set("foreign", { id: "foreign", hostname: "foreign.customer.example", status: "active", ssl: { status: "active" } });
    const foreign = f.service.create("app", "foreign.customer.example"); f.prove(foreign);
    expect((await f.service.verify(foreign.id)).status).toBe("error");
    expect(f.calls.some(c => c.method === "POST")).toBe(false);
    const own = f.service.create("app", "own.customer.example"); f.prove(own); await f.service.verify(own.id);
    const provider = [...f.hostnames.values()].find(h => h.hostname === own.hostname)!;
    provider.custom_origin_server = "another-origin.example";
    await expect(f.service.remove(own.id)).rejects.toMatchObject({ code: "CUSTOM_HOSTNAME_DRIFT" });
    expect(f.hostnames.has(provider.id)).toBe(true);
  });

  it("cleans up a project with unverified domains and serializes against an active verification", async () => {
    const f = await fixture(); f.makeProject("app");
    const domain = f.service.create("app", "pending.customer.example");
    const deletion = new ProjectDeletionService(f.config, f.database, f.cloudflare, f.service);
    f.database.sqlite.prepare("UPDATE external_domains SET locked_until = ? WHERE domain_id = ?").run(Date.now() + 10000, domain.id);
    await expect(deletion.request("app", "app")).rejects.toMatchObject({ code: "DOMAIN_MUTATION_ACTIVE" });
    f.database.sqlite.prepare("UPDATE external_domains SET locked_until = 0 WHERE domain_id = ?").run(domain.id);
    await expect(deletion.request("app", "app")).resolves.toEqual({ status: "queued" });
    expect(f.database.getDomain(domain.id)).toBeUndefined();
  });

  it("exposes authenticated DNS instructions and rejects cross-project verification and CSRF", async () => {
    const f = await fixture(); f.makeProject("app"); f.makeProject("other");
    const url = "/api/projects/app/domains";
    expect((await f.app.inject({ method: "POST", url, payload: { hostname: "api.customer.example", connection: "external" } })).statusCode).toBe(401);
    expect((await f.app.inject({ method: "POST", url, headers: { cookie: f.headers.cookie }, payload: { hostname: "api.customer.example", connection: "external" } })).statusCode).toBe(403);
    const created = await f.app.inject({ method: "POST", url, headers: f.headers, payload: { hostname: "api.customer.example", connection: "external" } });
    expect(created.statusCode).toBe(202);
    const domain = created.json().domain;
    expect(domain.external.records).toHaveLength(2);
    expect((await f.app.inject({ method: "GET", url, headers: f.headers })).json().domains[0].id).toBe(domain.id);
    const wrong = await f.app.inject({ method: "POST", url: `/api/projects/other/domains/${domain.id}/verify`, headers: f.headers });
    expect(wrong.statusCode).toBe(404);
    expect((await f.app.inject({ method: "DELETE", url: `${url}/${domain.id}`, headers: f.headers })).statusCode).toBe(200);
  });
  it.each(["co.uk", "com", "*.customer.example", "https://portal.customer.example/path", "127.0.0.1"])("rejects unsupported hostnames: %s", async hostname => {
    const f = await fixture(); f.makeProject("app");
    expect(() => f.service.create("app", hostname)).toThrow();
    expect(f.database.listDomains("app")).toHaveLength(0);
    expect(f.calls).toHaveLength(0);
  });

  it("activates a flattened customer apex only after TXT proof, matching addresses and a valid certificate", async () => {
    const f = await fixture();
    f.makeProject("apex");
    const hostname = "customer.co.uk";
    const url = "/api/projects/apex/domains";
    const created = await f.app.inject({ method: "POST", url, headers: f.headers, payload: { hostname, connection: "external" } });
    expect(created.statusCode).toBe(202);
    const domain = created.json().domain;
    expect(domain.external).toMatchObject({ dnsMode: "apex", records: [
      { type: "ALIAS", name: hostname, value: target },
      { type: "TXT", name: "_shelter-verification.customer.co.uk", value: expect.any(String) }
    ] });
    const recheck = async () => (await f.app.inject({ method: "POST", url: `${url}/${domain.id}/verify`, headers: f.headers })).json().domain;
    f.dns4.set(target, ["192.0.2.1", "192.0.2.2"]);
    f.dns4.set(hostname, ["192.0.2.2", "192.0.2.1"]);
    f.dns6.set(target, ["2001:db8::1"]);
    f.dns6.set(hostname, ["2001:db8::2"]);
    expect((await recheck()).external.phase).toBe("ownership");
    f.prove(domain);
    expect((await recheck()).external).toMatchObject({ phase: "dns", dnsReady: false });
    expect(f.hostnames.size).toBe(0);
    f.dns6.set(hostname, ["2001:db8::1"]);
    expect(await recheck()).toMatchObject({ status: "pending", external: { phase: "certificate", dnsReady: true } });
    const customHostname = [...f.hostnames.values()][0]!;
    const challenge = { type: "txt", name: "_cf-custom-hostname.customer.co.uk", value: "mock-provider-proof" };
    customHostname.ownership_verification = challenge;
    customHostname.status = "pending";
    f.ready();
    const awaitingHostname = await recheck();
    expect(awaitingHostname.status).toBe("pending");
    expect(awaitingHostname.external.records).toContainEqual({ ...challenge, type: "TXT" });
    expect(fs.readFileSync(f.config.traefikConfigPath, "utf8")).not.toContain(hostname);
    customHostname.status = "active";
    expect(await recheck()).toMatchObject({ status: "active", external: { phase: "active", tlsStatus: "active" } });
    expect(fs.readFileSync(f.config.traefikConfigPath, "utf8")).toContain(hostname);
    f.dns4.delete(hostname);
    expect((await recheck()).status).toBe("active"); // A matching IPv6-only ALIAS is valid.
    f.dns6.delete(hostname);
    expect(await recheck()).toMatchObject({ status: "pending", external: { phase: "dns" } });
    expect(fs.readFileSync(f.config.traefikConfigPath, "utf8")).not.toContain(hostname);
  });

  it("keeps established routing during a temporary DNS outage", async () => {
    const f = await fixture(); f.makeProject("app"); f.ready();
    const domain = f.service.create("app", "stable.customer.example"); f.prove(domain);
    await f.service.verify(domain.id);
    vi.spyOn(Resolver.prototype, "resolveCname").mockRejectedValue(Object.assign(new Error("temporary failure"), { code: "ESERVFAIL" }));
    const observed = await f.service.verify(domain.id);
    expect(observed.status).toBe("active");
    expect(observed.external?.error).toContain("DNS could not be checked");
    expect(fs.readFileSync(f.config.traefikConfigPath, "utf8")).toContain(domain.hostname);
  });

  it("validates the configured fallback without writing to Cloudflare and locks changes while in use", async () => {
    const f = await fixture(); f.makeProject("app");
    expect((await f.cloudflare.configureExternalDomains(zoneId, target)).configured).toBe(true);
    expect(f.calls.every(call => call.method === "GET")).toBe(true);
    const created = f.service.create("app", "pending.customer.example");
    expect(f.service.create("app", "pending.customer.example").id).toBe(created.id);
    await expect(f.cloudflare.setup({ accountId: "c".repeat(32) })).rejects.toMatchObject({ code: "EXTERNAL_DOMAINS_IN_USE" });
    await expect(f.cloudflare.configureExternalDomains(zoneId, "different.provider.example")).rejects.toMatchObject({ code: "EXTERNAL_DOMAINS_IN_USE" });
  });

  it("uses the configured primary domain as the suggested and verified customer CNAME target", async () => {
    const f = await fixture(); f.makeProject("app"); f.ready();
    f.database.setSetting("cloudflare.panel_domain", target);
    f.database.setSetting("cloudflare.panel_zone_id", zoneId);
    f.database.deleteSetting("cloudflare.saas_zone_id");
    f.database.deleteSetting("cloudflare.saas_cname_target");
    const settings = await f.app.inject({ method: "GET", url: "/api/settings/external-domains", headers: f.headers });
    expect(settings.json().externalDomains).toMatchObject({ configured: false, suggestedCnameTarget: target, suggestedZoneId: zoneId });
    const configured = await f.app.inject({ method: "PUT", url: "/api/settings/external-domains", headers: f.headers, payload: { zoneId, cnameTarget: target } });
    expect(configured.statusCode).toBe(200);
    expect(f.calls.every(call => call.method === "GET")).toBe(true);
    const domain = f.service.create("app", "primary.customer.example");
    expect(domain.external?.records.find(record => record.type === "CNAME")?.value).toBe(target);
    expect(() => f.service.create("app", target)).toThrow();
    f.prove(domain);
    expect((await f.service.verify(domain.id)).status).toBe("active");
    expect(fs.readFileSync(f.config.traefikConfigPath, "utf8")).toContain("primary.customer.example");
    f.database.setSetting("cloudflare.account_id", "b".repeat(32));
    f.database.setSetting("cloudflare.tunnel_name", "shelter-vps");
    const provider = f.provider.getMockImplementation()!;
    f.provider.mockImplementation(async (input, init) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname.endsWith("/user/tokens/verify")) return Response.json({ success: true, result: { status: "active" } });
      if (pathname.endsWith("/cfd_tunnel/owned-tunnel")) return Response.json({ success: true, result: { id: "owned-tunnel", name: "shelter-vps" } });
      if (pathname.endsWith("/configurations")) return Response.json({ success: true, result: {} });
      if (pathname.endsWith("/token")) return Response.json({ success: true, result: "test-tunnel-token" });
      return provider(input, init);
    });
    await expect(f.cloudflare.setup({ accountId: "b".repeat(32), panelDomain: target })).resolves.toMatchObject({ panelDomain: target });
    expect(f.cloudflare.externalDomainSettings().cnameTarget).toBe(target);
  });

  it.each([
    { name: "a different tunnel", record: { content: "another-tunnel.cfargotunnel.com" } },
    { name: "an unproxied record", record: { proxied: false } },
    { name: "a different hostname", record: { name: "unrelated.provider.example" } },
  ])("rejects the primary domain when its DNS points to $name", async ({ record }) => {
    const f = await fixture();
    f.database.setSetting("cloudflare.panel_domain", target);
    const provider = f.provider.getMockImplementation()!;
    f.provider.mockImplementation(async (input, init) => {
      if (new URL(String(input)).pathname.endsWith("/dns_records")) return Response.json({ success: true, result: [{ id: "fallback", name: target, type: "CNAME", content: "owned-tunnel.cfargotunnel.com", proxied: true, ...record }] });
      return provider(input, init);
    });
    await expect(f.cloudflare.configureExternalDomains(zoneId, target)).rejects.toMatchObject({ code: "SAAS_TARGET_INVALID" });
  });

  it("reports missing OAuth certificate permission before making a SaaS request", async () => {
    const f = await fixture();
    f.database.setSetting("cloudflare.auth_method", "oauth");
    f.database.setSetting("cloudflare.oauth_credentials", encryptString(JSON.stringify({
      accessToken: "legacy-access", refreshToken: "legacy-refresh", tokenType: "Bearer",
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      scopes: ["account-settings.read", "zone.read", "dns.write", "argotunnel.write", "offline_access"],
      clientId: "client-id", redirectUri: "https://panel.example.com/api/settings/cloudflare/oauth/callback",
      accounts: [{ id: "b".repeat(32), name: "Account" }]
    }), f.config.APP_SECRET));
    const state = await f.app.inject({ method: "GET", url: "/api/settings/cloudflare", headers: f.headers });
    expect(state.json().cloudflare).toMatchObject({ reconnectRequired: true, oauthMissingScopes: ["ssl-and-certificates.write"] });
    const result = await f.app.inject({ method: "PUT", url: "/api/settings/external-domains", headers: f.headers, payload: { zoneId, cnameTarget: target } });
    expect(result.statusCode).toBe(400);
    expect(result.json().code).toBe("CLOUDFLARE_OAUTH_SCOPE_MISSING");
    expect(result.body).not.toContain("legacy-access");
    expect(f.calls).toEqual([]);
  });

  it("explains missing SaaS permissions for a restricted API token", async () => {
    const f = await fixture();
    const provider = f.provider.getMockImplementation()!;
    f.provider.mockImplementation(async (input, init) => new URL(String(input)).pathname.endsWith("/fallback_origin")
      ? Response.json({ success: false, errors: [{ message: "Authentication error" }] }, { status: 403 })
      : provider(input, init));
    await expect(f.cloudflare.configureExternalDomains(zoneId, target)).rejects.toMatchObject({ statusCode: 400, code: "CLOUDFLARE_SAAS_PERMISSION_REQUIRED" });
  });

  it("limits a domain integration token to the selected project's domain endpoints", async () => {
    const f = await fixture(); f.makeProject("app"); f.makeProject("other");
    const issued = await f.app.inject({ method: "POST", url: "/api/settings/api-tokens", headers: f.headers,
      payload: { name: "Customer domain integration", access: "domains", projectId: "app", currentPassword: "test admin password" } });
    expect(issued.statusCode).toBe(201);
    expect(issued.json().apiToken).toMatchObject({ scopes: ["domains:write"], projectId: "app" });
    const headers = { authorization: `Bearer ${issued.json().secret}` };
    expect((await f.app.inject({ method: "GET", url: "/api/settings/external-domains", headers })).statusCode).toBe(200);
    expect((await f.app.inject({ method: "GET", url: "/api/projects/app/domains", headers })).statusCode).toBe(200);
    expect((await f.app.inject({ method: "GET", url: "/api/projects/other/domains", headers })).statusCode).toBe(403);
    expect((await f.app.inject({ method: "GET", url: "/api/projects", headers })).statusCode).toBe(403);
    expect((await f.app.inject({ method: "GET", url: "/api/settings/cloudflare/zones", headers })).statusCode).toBe(403);
    expect((await f.app.inject({ method: "POST", url: planPath, headers, payload: setupPayload })).statusCode).toBe(403);
    expect((await f.app.inject({ method: "POST", url: "/api/projects/app/deploy", headers })).statusCode).toBe(403);
    const created = await f.app.inject({ method: "POST", url: "/api/projects/app/domains", headers,
      payload: { hostname: "token.customer.example", connection: "external" } });
    expect(created.statusCode).toBe(202);
    const id = created.json().domain.id;
    expect((await f.app.inject({ method: "POST", url: `/api/projects/app/domains/${id}/verify`, headers })).statusCode).toBe(200);
    expect((await f.app.inject({ method: "DELETE", url: `/api/projects/app/domains/${id}`, headers })).statusCode).toBe(200);
  });

});
