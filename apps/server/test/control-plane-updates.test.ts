import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { Database } from "../src/lib/database.js";
import { installedVersion } from "../src/services/control-plane-updates.js";

const password = "correct horse battery staple";
const target = `${Number(installedVersion.split(".")[0]) + 1}.0.0`;
const tag = `v${target}`;
const contexts: Array<{ app: Awaited<ReturnType<typeof createApp>>; directory: string }> = [];
const release = () => ({ tag_name: tag, draft: false, prerelease: false, immutable: true,
  published_at: "2026-10-08T00:00:00Z", body: "A verified release", assets: [{ name: `shelter-${tag}.tar.gz`, state: "uploaded" }] });

async function context() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shelter-updates-test-"));
  const config = loadConfig({ NODE_ENV: "test", DATA_DIR: directory, WEB_DIST: path.join(directory, "missing"),
    ADMIN_EMAIL: "admin@example.com", ADMIN_PASSWORD: password, APP_SECRET: "c".repeat(64), LOG_LEVEL: "silent",
    CONTROL_PLANE_IMAGE: `shelter/control-plane:release-${"a".repeat(64)}` });
  fs.mkdirSync(config.UPDATE_REQUESTS_DIR, { recursive: true });
  fs.mkdirSync(config.UPDATE_STATUS_DIR, { recursive: true });
  fs.writeFileSync(path.join(config.UPDATE_STATUS_DIR, "ready.json"), JSON.stringify({ checkedAt: new Date().toISOString() }));
  const db = new Database(config);
  const app = await createApp(config, db);
  contexts.push({ app, directory });
  db.setSetting("worker.heartbeat", new Date().toISOString());
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@example.com", password } });
  const headers = { cookie: `shelter_session=${login.cookies[0]!.value}`, "x-csrf-token": login.json().csrfToken as string };
  const fetcher = vi.fn(async () => new Response(JSON.stringify(release())));
  vi.stubGlobal("fetch", fetcher);
  const start = (payload: Record<string, unknown> = {}) => app.inject({ method: "POST", url: "/api/settings/updates", headers,
    payload: { tag, fromVersion: installedVersion, currentPassword: password, backupConfirmed: true, ...payload } });
  return { app, db, config, headers, fetcher, start };
}

afterEach(async () => {
  for (const { app, directory } of contexts.splice(0)) { await app.close(); fs.rmSync(directory, { recursive: true, force: true }); }
  vi.unstubAllGlobals();
});

describe("panel release update boundary", () => {
  it("requires a browser session, CSRF, current password and explicit backup before requesting host work", async () => {
    const c = await context();
    expect((await c.app.inject({ url: "/api/settings/updates" })).statusCode).toBe(401);
    expect((await c.app.inject({ method: "POST", url: "/api/settings/updates", headers: { cookie: c.headers.cookie }, payload: {} })).statusCode).toBe(403);
    expect((await c.start({ currentPassword: "wrong" })).json().code).toBe("CURRENT_PASSWORD_INVALID");
    expect((await c.start({ backupConfirmed: false })).statusCode).toBe(400);
    expect(c.fetcher).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(c.config.UPDATE_REQUESTS_DIR, "request.json"))).toBe(false);
    const token = await c.app.inject({ method: "POST", url: "/api/settings/api-tokens", headers: c.headers,
      payload: { name: "fixture", access: "read", currentPassword: password } });
    expect(token.statusCode).toBe(201);
    expect((await c.app.inject({ url: "/api/settings/updates", headers: { authorization: `Bearer ${token.json().secret}` } })).statusCode).toBe(403);
  });

  it.each([
    { immutable: false }, { draft: true }, { prerelease: true }, { tag_name: "v1.0.0-beta" },
    { assets: [] }, { assets: [{ name: `shelter-${tag}.tar.gz`, state: "new" }] }, { body: "x".repeat(512_001) }
  ])("never admits an unverified or incomplete stable release: %j", async (invalid) => {
    const c = await context();
    c.fetcher.mockImplementation(async () => new Response(JSON.stringify({ ...release(), ...invalid })));
    const response = await c.start();
    expect(response.statusCode).toBe(502);
    expect(response.json().code).toBe("UPDATE_CHECK_FAILED");
    expect(fs.existsSync(path.join(c.config.UPDATE_REQUESTS_DIR, "request.json"))).toBe(false);
  });

  it("revalidates the exact release and admits one credential-free atomic request, with correlated persistent progress", async () => {
    const c = await context();
    const checked = await c.app.inject({ method: "POST", url: "/api/settings/updates/check", headers: c.headers });
    expect(checked.json()).toMatchObject({ currentVersion: installedVersion, updateAvailable: true, updaterReady: true });
    expect(checked.headers["cache-control"]).toBe("no-store");
    c.fetcher.mockClear();
    const started = await c.start();
    expect(started.statusCode).toBe(202);
    expect(c.fetcher).toHaveBeenCalledTimes(1);
    const [url, options] = c.fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/raum-so/shelter/releases/latest");
    expect(options.redirect).toBe("error");
    expect(new Headers(options.headers).has("authorization")).toBe(false);
    const file = path.join(c.config.UPDATE_REQUESTS_DIR, "request.json");
    const request = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(request).toEqual({ id: expect.stringMatching(/^[a-f0-9]{32}$/), tag, fromVersion: installedVersion });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect((await c.start()).json().code).toBe("UPDATE_BUSY");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(request);
    const writeStatus = (id: string, phase: string) => fs.writeFileSync(path.join(c.config.UPDATE_STATUS_DIR, "job.json"),
      JSON.stringify({ ...request, id, phase, updatedAt: new Date().toISOString() }));
    writeStatus("b".repeat(32), "succeeded");
    expect((await c.app.inject({ url: "/api/settings/updates", headers: c.headers })).json().job.phase).toBe("queued");
    writeStatus(request.id, "installing");
    expect((await c.app.inject({ url: "/api/settings/updates", headers: c.headers })).json().job.phase).toBe("installing");
    const mutation = await c.app.inject({ method: "POST", url: "/api/projects/git", headers: c.headers, payload: {} });
    expect(mutation.json().code).toBe("UPDATE_BUSY");
    writeStatus(request.id, "succeeded"); fs.unlinkSync(file);
    expect((await c.app.inject({ url: "/api/settings/updates", headers: c.headers })).json().job.phase).toBe("succeeded");
  });

  it.each(["worker", "ready", "source", "release", "deployment", "deletion"])("refuses update when %s is incompatible or busy", async (reason) => {
    const c = await context();
    const expected = { worker: "UPDATE_WORKER_OFFLINE", ready: "UPDATER_UNAVAILABLE", source: "UPDATER_UNAVAILABLE", release: "UPDATE_RELEASE_CHANGED",
      deployment: "UPDATE_PROJECTS_BUSY", deletion: "UPDATE_PROJECTS_BUSY" }[reason];
    if (reason === "worker") c.db.setSetting("worker.heartbeat", "2000-01-01T00:00:00Z");
    if (reason === "ready") fs.unlinkSync(path.join(c.config.UPDATE_STATUS_DIR, "ready.json"));
    if (reason === "source") c.config.CONTROL_PLANE_IMAGE = "shelter/control-plane:local";
    if (reason === "release") c.fetcher.mockImplementation(async () => new Response(JSON.stringify({ ...release(), tag_name: `v${installedVersion}`, assets: [{ name: `shelter-v${installedVersion}.tar.gz`, state: "uploaded" }] })));
    if (reason === "deployment" || reason === "deletion") {
      c.db.sqlite.prepare("INSERT INTO projects (id,name,slug,source_type,created_at,updated_at) VALUES ('p','p','p','git','now','now')").run();
      if (reason === "deployment") c.db.sqlite.prepare("INSERT INTO deployments (id,project_id,status,created_at) VALUES ('d','p','building','now')").run();
      else c.db.sqlite.prepare("INSERT INTO project_deletions (project_id,status,requested_at,updated_at) VALUES ('p','running','now','now')").run();
    }
    expect((await c.start()).json().code).toBe(expected);
    expect(fs.existsSync(path.join(c.config.UPDATE_REQUESTS_DIR, "request.json"))).toBe(false);
  });

  it("rejects stale version and tag selections after checking release metadata again", async () => {
    const c = await context();
    expect((await c.start({ fromVersion: "0.0.0" })).json().code).toBe("UPDATE_RELEASE_CHANGED");
    expect((await c.start({ tag: `v${installedVersion}` })).json().code).toBe("UPDATE_RELEASE_CHANGED");
    expect(fs.existsSync(path.join(c.config.UPDATE_REQUESTS_DIR, "request.json"))).toBe(false);
  });

  it.each(["symlink", "malformed"])("fails closed on %s IPC state without exposing file contents", async (kind) => {
    const c = await context();
    const file = path.join(c.config.UPDATE_REQUESTS_DIR, "request.json");
    if (kind === "symlink") { const privateFile = path.join(c.config.DATA_DIR, "private-fixture"); fs.writeFileSync(privateFile, "private-fixture-content"); fs.symlinkSync(privateFile, file); }
    else fs.writeFileSync(file, "not JSON");
    const response = await c.app.inject({ url: "/api/settings/updates", headers: c.headers });
    expect(response.statusCode).toBe(409); expect(response.json().code).toBe("UPDATE_STATE_INVALID");
    expect(response.body).not.toContain("private-fixture-content");
    expect((await c.app.inject({ method: "POST", url: "/api/projects/git", headers: c.headers, payload: {} })).json().code).toBe("UPDATE_BUSY");
  });
});
