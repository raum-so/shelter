import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Resolver } from "node:dns/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { Database } from "../src/lib/database.js";
import { encryptString } from "../src/lib/security.js";
import { CloudflareService } from "../src/services/cloudflare.js";
import { ExternalDomains } from "../src/services/external-domains.js";
import { ProjectDeletionService } from "../src/services/project-deletion.js";
import type { ProjectRow } from "../src/types/models.js";

const cleanups: Array<() => Promise<void> | void> = [];
const zoneId = "a".repeat(32);
const target = "connect.provider.example";

async function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shelter-external-"));
  const config = loadConfig({ NODE_ENV: "test", DATA_DIR: directory, WEB_DIST: path.join(directory, "web"),
    APP_SECRET: "x".repeat(64), ADMIN_EMAIL: "admin@example.com", ADMIN_PASSWORD: "test admin password",
    CLOUDFLARE_ACCOUNT_ID: "b".repeat(32), CLOUDFLARE_API_TOKEN: "test-provider-token", LOG_LEVEL: "silent" });
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
  vi.spyOn(Resolver.prototype, "resolveTxt").mockImplementation(async name => dnsTxt.has(name) ? [[dnsTxt.get(name)!]] : []);
  vi.spyOn(Resolver.prototype, "resolveCname").mockImplementation(async name => dnsCname.has(name) ? [dnsCname.get(name)!] : []);
  const hostnames = new Map<string, { id: string; hostname: string; status: string; ssl: { status: string }; custom_origin_server?: string }>();
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
      else dnsCname.set(record.name, record.value);
    }
  };
  return { config, database, app, headers, cloudflare, service, makeProject, prove, dnsTxt, dnsCname, provider, calls, hostnames,
    ready: () => { tls = "active"; }, failDeletion: (value: boolean) => { failDelete = value; } };
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe("external customer domain lifecycle", () => {
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

  it("resumes pending verification after reopening the database without recreating the certificate", async () => {
    const f = await fixture(); f.makeProject("app", false);
    const domain = f.service.create("app", "pending.customer.example"); f.prove(domain);
    await f.service.verify(domain.id);
    const reopened = new Database(f.config);
    const resumed = new ExternalDomains(f.config, reopened, new CloudflareService(f.config, reopened));
    reopened.recoverPendingDomains();
    expect(reopened.getDomain(domain.id)?.status).toBe("pending");
    f.ready();
    expect((await resumed.verify(domain.id)).external?.phase).toBe("deployment");
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
  it.each(["customer.co.uk", "customer.example", "*.customer.example", "https://portal.customer.example/path", "127.0.0.1"])("rejects unsupported hostnames: %s", async hostname => {
    const f = await fixture(); f.makeProject("app");
    expect(() => f.service.create("app", hostname)).toThrow();
    expect(f.database.listDomains("app")).toHaveLength(0);
    expect(f.calls).toHaveLength(0);
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
    expect((await f.app.inject({ method: "POST", url: "/api/projects/app/deploy", headers })).statusCode).toBe(403);
    const created = await f.app.inject({ method: "POST", url: "/api/projects/app/domains", headers,
      payload: { hostname: "token.customer.example", connection: "external" } });
    expect(created.statusCode).toBe(202);
    const id = created.json().domain.id;
    expect((await f.app.inject({ method: "POST", url: `/api/projects/app/domains/${id}/verify`, headers })).statusCode).toBe(200);
    expect((await f.app.inject({ method: "DELETE", url: `/api/projects/app/domains/${id}`, headers })).statusCode).toBe(200);
  });

});
