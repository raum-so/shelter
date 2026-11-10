import { SupabaseConnections } from "../src/services/supabase-connections.js";
import { createSupabaseSecrets } from "../src/services/supabase-template.js";
import nodemailer from "nodemailer";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { Database } from "../src/lib/database.js";
import { decryptString, encryptString, newId } from "../src/lib/security.js";
import { CloudflareService } from "../src/services/cloudflare.js";
import { SupabaseWorker } from "../src/services/supabase-worker.js";
import { SupabaseRuntime } from "../src/services/supabase-runtime.js";
import { SupabaseStore } from "../src/services/supabase-store.js";
import {
  decryptSupabaseBackup,
  encryptSupabaseBackup,
} from "../src/services/supabase-backup.js";

const directories: string[] = [];
const applications: Awaited<ReturnType<typeof createApp>>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const app of applications.splice(0)) await app.close();
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});
async function fixture() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "shelter-supabase-test-"),
  );
  directories.push(directory);
  const config = loadConfig({
    NODE_ENV: "test",
    DATA_DIR: directory,
    WEB_DIST: path.join(directory, "missing"),
    APP_SECRET: "s".repeat(64),
    ADMIN_PASSWORD: "correct horse battery staple",
    LOG_LEVEL: "silent",
  });
  const db = new Database(config);
  const app = await createApp(config, db);
  applications.push(app);
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: {
      email: config.ADMIN_EMAIL,
      password: "correct horse battery staple",
    },
  });
  const headers = {
    cookie: `shelter_session=${login.cookies.find((c) => c.name === "shelter_session")!.value}`,
    "x-csrf-token": login.json().csrfToken as string,
  };
  db.setSetting("cloudflare.tunnel_id", "test-tunnel");
  vi.spyOn(CloudflareService.prototype, "checkHostname").mockImplementation(
    async (hostname) => ({
      hostname,
      availability: true,
      reason: "AVAILABLE",
      zone: null,
    }),
  );
  vi.spyOn(nodemailer, "createTransport").mockReturnValue({
    verify: vi.fn().mockResolvedValue(true),
    close: vi.fn(),
  } as unknown as ReturnType<typeof nodemailer.createTransport>);
  const input = {
    name: "Database",
    apiHostname: "api.example.com",
    studioHostname: "studio.example.com",
    siteUrl: "https://app.example.com",
    smtp: {
      host: "smtp.example.com",
      port: 465,
      user: "mailuser",
      sender: "My app",
      adminEmail: "admin@example.com",
      password: "smtp-sensitive-fixture",
    },
  };
  return { app, db, config, headers, input };
}

describe("managed Supabase API", () => {
  it("defaults to verified global SMTP while keeping disabled instances independent", async () => {
    const { app, db, config, headers, input } = await fixture();
    const { smtp: _smtp, ...base } = input;
    const before = await app.inject({
      method: "POST",
      url: "/api/supabase",
      headers,
      payload: base,
    });
    expect(before.statusCode).toBe(202);
    expect(before.json().instance.settings.smtpSource).toBe("global");
    expect(before.json().instance.settings.smtp).toBeUndefined();
    const saved = await app.inject({
      method: "PUT",
      url: "/api/settings/smtp",
      headers,
      payload: {
        expectedRevision: null,
        host: input.smtp.host,
        port: 465,
        user: input.smtp.user,
        password: input.smtp.password,
        fromEmail: input.smtp.adminEmail,
        fromName: input.smtp.sender,
      },
    });
    const revision = saved.json().revision;
    const next = {
      ...base,
      apiHostname: "api2.example.com",
      studioHostname: "studio2.example.com",
    };
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/supabase",
          headers,
          payload: next,
        })
      ).json().code,
    ).toBe("SMTP_NOT_VERIFIED");
    await app.inject({
      method: "POST",
      url: "/api/settings/smtp/verify",
      headers,
      payload: { revision },
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/supabase",
      headers,
      payload: next,
    });
    expect(created.statusCode).toBe(202);
    expect(created.body).not.toContain(input.smtp.password);
    const row = new SupabaseStore(db).get(created.json().instance.id);
    expect(JSON.parse(row.settings_json)).toMatchObject({
      smtpSource: "global",
      smtpAppliedRevision: revision,
      smtp: { host: input.smtp.host },
    });
    expect(
      JSON.parse(decryptString(row.encrypted_secrets, config.APP_SECRET))
        .smtpPassword,
    ).toBe(input.smtp.password);
    const disabled = await app.inject({
      method: "POST",
      url: "/api/supabase",
      headers,
      payload: {
        ...base,
        apiHostname: "api3.example.com",
        studioHostname: "studio3.example.com",
        smtpSource: "disabled",
      },
    });
    expect(disabled.statusCode).toBe(202);
    expect(disabled.json().instance.settings.smtp).toBeUndefined();
  });

  it("rechecks hostname ownership after asynchronous provider validation", async () => {
    const { app, db, headers, input } = await fixture();
    vi.spyOn(CloudflareService.prototype, "checkHostname").mockImplementation(
      async (hostname) => {
        if (hostname === input.studioHostname)
          db.setSetting("cloudflare.panel_domain", input.apiHostname);
        return {
          hostname,
          availability: true,
          reason: "AVAILABLE",
          zone: null,
        };
      },
    );
    const response = await app.inject({
      method: "POST",
      url: "/api/supabase",
      headers,
      payload: input,
    });
    expect(response.statusCode).toBe(409);
    expect(new SupabaseStore(db).list()).toEqual([]);
  });

  it("links only public credentials while preserving application variables and their safety limits", async () => {
    const { app, db, config, headers, input } = await fixture();
    const created = await app.inject({
      method: "POST",
      url: "/api/supabase",
      headers,
      payload: input,
    });
    const id = created.json().instance.id as string;
    const store = new SupabaseStore(db);
    store.finish(store.claim()!);
    store.update(id, { status: "running" });
    const projectResponse = await app.inject({
      method: "POST",
      url: "/api/projects/git",
      headers,
      payload: {
        name: "Connected app",
        repositoryUrl: "https://github.com/example/app.git",
      },
    });
    expect(projectResponse.statusCode).toBe(201);
    const projectId = projectResponse.json().project.id as string;
    db.updateDeployment(projectResponse.json().deployment.id, {
      status: "cancelled",
    });
    const envUrl = `/api/projects/${projectId}/environment`;
    expect(
      (
        await app.inject({
          method: "PUT",
          url: envUrl,
          headers,
          payload: {
            variables: [{ key: "EXISTING", value: "keep this value" }],
          },
        })
      ).statusCode,
    ).toBe(200);
    const url = `/api/supabase/${id}/connections`;
    const reserved = await app.inject({
      method: "POST",
      url,
      headers,
      payload: { projectId, urlVariable: "PORT", keyVariable: "PUBLIC_KEY" },
    });
    expect(reserved.statusCode).toBe(400);
    const connected = await app.inject({
      method: "POST",
      url,
      headers,
      payload: { projectId },
    });
    expect(connected.statusCode).toBe(200);
    const values = Object.fromEntries(
      db
        .listEnvironment(projectId)
        .map((row) => [
          row.key,
          decryptString(row.encrypted_value, config.APP_SECRET),
        ]),
    );
    const secrets = JSON.parse(
      decryptString(store.get(id).encrypted_secrets, config.APP_SECRET),
    );
    expect(values).toEqual({
      EXISTING: "keep this value",
      SUPABASE_URL: `https://${input.apiHostname}`,
      SUPABASE_ANON_KEY: secrets.anonKey,
    });
    expect(JSON.stringify(values)).not.toContain(secrets.serviceKey);
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          headers,
          payload: { projectId },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          headers,
          payload: { projectId, replace: true },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: envUrl,
          headers,
          payload: {
            variables: [0, 1, 2, 3].map((i) => ({
              key: `E${i}`,
              value: "x".repeat(65500),
            })),
          },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          headers,
          payload: { projectId },
        })
      ).statusCode,
    ).toBe(400);
    expect(db.listEnvironment(projectId)).toHaveLength(4);
  });

  it("checks shell-less PostgREST readiness using its native executable and rejects failed probes", async () => {
    const { app, db, config, headers, input } = await fixture();
    const response = await app.inject({
      method: "POST",
      url: "/api/supabase",
      headers,
      payload: input,
    });
    const instance = new SupabaseStore(db).get(response.json().instance.id);
    let ready = true;
    const runtime = new SupabaseRuntime(config, async (_command, args) => {
      if (args[0] === "exec") {
        if (args.slice(2).join(" ") !== "postgrest --ready")
          throw new Error("No shell in this image");
        return { stdout: "", stderr: "", exitCode: ready ? 0 : 1 };
      }
      return {
        stdout: JSON.stringify([
          {
            Id: "postgrest-container",
            Config: {
              Labels: {
                "shelter.managed": "true",
                "shelter.supabase": instance.id,
                "shelter.purpose": "supabase-rest",
              },
            },
            State: {
              Running: true,
              Status: "running",
              Health: { Status: "unhealthy" },
            },
          },
        ]),
        stderr: "",
        exitCode: 0,
      };
    });
    expect(
      (await runtime.inspect(instance, "rest"))?.State.Health?.Status,
    ).toBe("healthy");
    ready = false;
    expect(
      (await runtime.inspect(instance, "rest"))?.State.Health?.Status,
    ).toBe("unhealthy");
  });

  it("uses the reserved network pool when Docker defaults are exhausted and skips occupied subnets", async () => {
    const { app, db, config, headers, input } = await fixture();
    const response = await app.inject({
      method: "POST",
      url: "/api/supabase",
      headers,
      payload: input,
    });
    const instance = new SupabaseStore(db).get(response.json().instance.id);
    const networks = new Map<
      string,
      { Labels: Record<string, string>; subnet: string }
    >();
    let collision = true;
    const runtime = new SupabaseRuntime(
      { ...config, SUPABASE_NETWORK_POOL: "10.252.0.0/16" },
      async (_command, args, options) => {
        if (args[0] === "volume")
          throw new Error("Reached volume provisioning");
        const name = args.at(-1)!;
        if (args[1] === "inspect") {
          return networks.has(name)
            ? {
                stdout: JSON.stringify([networks.get(name)]),
                stderr: "",
                exitCode: 0,
              }
            : { stdout: "", stderr: "network not found", exitCode: 1 };
        }
        const subnetIndex = args.indexOf("--subnet");
        if (subnetIndex === -1) {
          if (!options?.allowFailure)
            throw new Error(
              "all predefined address pools have been fully subnetted",
            );
          return {
            stdout: "",
            stderr: "all predefined address pools have been fully subnetted",
            exitCode: 1,
          };
        }
        if (collision) {
          collision = false;
          return {
            stdout: "",
            stderr: "Pool overlaps with other one on this address space",
            exitCode: 1,
          };
        }
        const labels = Object.fromEntries(
          args.flatMap((arg, index) =>
            arg === "--label" ? [args[index + 1]!.split("=")] : [],
          ),
        );
        networks.set(name, { Labels: labels, subnet: args[subnetIndex + 1]! });
        return { stdout: name, stderr: "", exitCode: 0 };
      },
    );
    await expect(
      runtime.start(instance, createSupabaseSecrets()),
    ).rejects.toThrow("Reached volume provisioning");
    expect(networks.size).toBe(2);
    for (const network of networks.values()) {
      expect(network.subnet).toMatch(/^10\.252\.\d+\.0\/24$/);
      expect(network.Labels["shelter.supabase"]).toBe(instance.id);
    }
    expect(
      new Set([...networks.values()].map((network) => network.subnet)).size,
    ).toBe(2);
    for (const invalid of [
      "10.252.1.0/16",
      "192.168.0.0/16",
      "10.256.0.0/16",
      "10.252.0.0/8",
    ]) {
      expect(() =>
        loadConfig({ ...process.env, SUPABASE_NETWORK_POOL: invalid }),
      ).toThrow();
    }
  });

  it("keeps failed installations unrouted, retains their identity, and hides subprocess secrets", async () => {
    const { app, db, config, headers, input } = await fixture();
    const response = await app.inject({
      method: "POST",
      url: "/api/supabase",
      headers,
      payload: input,
    });
    const store = new SupabaseStore(db);
    const instance = store.get(response.json().instance.id);
    const worker = new SupabaseWorker(config, db, async () => {
      throw new Error("postgres://private-fixture-credential@db");
    });
    expect(await worker.processNext()).toBe(true);
    expect(store.get(instance.id)).toMatchObject({
      status: "error",
      generation: instance.generation,
      encrypted_secrets: instance.encrypted_secrets,
    });
    expect(store.jobs(instance.id)[0]?.status).toBe("failed");
    const visible = await app.inject({ url: "/api/supabase", headers });
    expect(visible.body).not.toContain("private-fixture-credential");
    expect(fs.readFileSync(config.traefikConfigPath, "utf8")).not.toContain(
      instance.api_hostname,
    );
    const called: string[] = [];
    const runtime = new SupabaseRuntime(config, async (_command, args) => {
      called.push(args[0]!);
      return {
        stdout: JSON.stringify([
          { Config: { Labels: { "shelter.supabase": "other-instance" } } },
        ]),
        stderr: "",
        exitCode: 0,
      };
    });
    await expect(runtime.stop(instance, true)).rejects.toThrow("ownership");
    expect(called).toEqual(["container"]);
  });

  it("queues a durable isolated instance, encrypts credentials, and excludes secrets from status and discovery", async () => {
    const { app, db, config, headers, input } = await fixture();
    const created = await app.inject({
      method: "POST",
      url: "/api/supabase",
      headers,
      payload: input,
    });
    expect(created.statusCode).toBe(202);
    const id = created.json().instance.id as string;
    const store = new SupabaseStore(db);
    const row = store.get(id);
    expect(store.jobs(id)).toMatchObject([
      { action: "start", status: "queued" },
    ]);
    expect(row.encrypted_secrets).not.toContain(input.smtp.password);
    expect(row.settings_json).not.toContain(input.smtp.password);
    const secrets = JSON.parse(
      decryptString(row.encrypted_secrets, config.APP_SECRET),
    );
    expect(secrets.studioPassword).toHaveLength(48);
    const status = await app.inject({ url: "/api/supabase", headers });
    expect(status.statusCode).toBe(200);
    for (const secret of [
      secrets.studioPassword,
      secrets.databasePassword,
      secrets.serviceKey,
      input.smtp.password,
    ])
      expect(status.body + created.body).not.toContain(secret);
    expect(status.headers["cache-control"]).toBe("no-store");
    expect(
      (await app.inject({ url: "/api/openapi.json" })).json().paths,
    ).toHaveProperty("/api/supabase/{id}/credentials");
    const duplicate = await app.inject({
      method: "POST",
      url: "/api/supabase",
      headers,
      payload: { ...input, name: "Another" },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(store.list()).toHaveLength(1);
  });
  it("requires authentication, mutation CSRF, and password reauthentication for credential disclosure", async () => {
    const { app, db, headers, input } = await fixture();
    expect((await app.inject({ url: "/api/supabase" })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/supabase",
          headers: { cookie: headers.cookie },
          payload: input,
        })
      ).statusCode,
    ).toBe(403);
    const created = await app.inject({
      method: "POST",
      url: "/api/supabase",
      headers,
      payload: input,
    });
    const endpoint = `/api/supabase/${created.json().instance.id}/credentials`;
    expect(
      (
        await app.inject({
          method: "POST",
          url: endpoint,
          headers,
          payload: { currentPassword: "wrong" },
        })
      ).statusCode,
    ).toBe(400);
    const token = await app.inject({
      method: "POST",
      url: "/api/settings/api-tokens",
      headers,
      payload: {
        name: "read automation",
        access: "read",
        currentPassword: "correct horse battery staple",
      },
    });
    const bearer = { authorization: `Bearer ${token.json().secret}` };
    expect(
      (await app.inject({ url: "/api/supabase", headers: bearer })).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/supabase",
          headers: bearer,
          payload: input,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: endpoint,
          headers: bearer,
          payload: { currentPassword: "correct horse battery staple" },
        })
      ).json().code,
    ).toBe("SESSION_REQUIRED");
    expect(
      (
        await app.inject({
          method: "POST",
          url: endpoint,
          headers,
          payload: { currentPassword: "correct horse battery staple" },
        })
      ).statusCode,
    ).toBe(409);
    const store = new SupabaseStore(db);
    const pending = store.claim()!;
    store.finish(pending);
    const result = await app.inject({
      method: "POST",
      url: endpoint,
      headers,
      payload: { currentPassword: "correct horse battery staple" },
    });
    expect(result.statusCode).toBe(200);
    expect(result.json().studioPassword).toHaveLength(48);
    expect(result.headers["cache-control"]).toBe("no-store");
  });
  it("rejects unsafe configuration, serializes operations, and requires owned completed backups and named confirmation", async () => {
    const { app, db, headers, input } = await fixture();
    for (const change of [
      { studioHostname: input.apiHostname },
      { siteUrl: "http://app.example.com" },
      { siteUrl: "https://user:secret@app.example.com" },
      { smtp: { ...input.smtp, password: "first\nINJECT=value" } },
    ]) {
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/supabase",
            headers,
            payload: { ...input, ...change },
          })
        ).statusCode,
      ).toBe(400);
    }
    const created = await app.inject({
      method: "POST",
      url: "/api/supabase",
      headers,
      payload: input,
    });
    const id = created.json().instance.id as string;
    const endpoint = `/api/supabase/${id}/actions`;
    expect(
      (
        await app.inject({
          method: "POST",
          url: endpoint,
          headers,
          payload: { action: "stop" },
        })
      ).statusCode,
    ).toBe(409);
    const store = new SupabaseStore(db);
    const job = store.claim()!;
    store.finish(job);
    store.update(id, { status: "running" });
    expect(
      (
        await app.inject({
          method: "POST",
          url: endpoint,
          headers,
          payload: { action: "archive" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: endpoint,
          headers,
          payload: {
            action: "restore",
            confirmation: input.name,
            backupId: "sbb_" + "a".repeat(32),
          },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: "POST",
          url: endpoint,
          headers,
          payload: { action: "backup" },
        })
      ).statusCode,
    ).toBe(202);
    const generation = store.get(id).generation;
    const backupJob = store.claim()!;
    expect(backupJob.resume_running).toBe(1);
    store.recover();
    expect(store.claim()!.id).toBe(backupJob.id);
    expect(store.get(id).generation).toBe(generation);
  });
});

it("authenticates complete backups and their instance identity before exposing plaintext for restore", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "shelter-backup-auth-"),
  );
  directories.push(directory);
  const source = path.join(directory, "source"),
    encrypted = path.join(directory, "encrypted"),
    restored = path.join(directory, "restored");
  fs.writeFileSync(source, "Database pages and private storage objects");
  await encryptSupabaseBackup(
    source,
    encrypted,
    "backup-secret",
    "instance:version:backup",
  );
  await decryptSupabaseBackup(
    encrypted,
    restored,
    "backup-secret",
    "instance:version:backup",
  );
  expect(fs.readFileSync(restored, "utf8")).toBe(
    "Database pages and private storage objects",
  );
  fs.unlinkSync(restored);
  await expect(
    decryptSupabaseBackup(
      encrypted,
      restored,
      "backup-secret",
      "other-instance:version:backup",
    ),
  ).rejects.toThrow("authentication");
  expect(fs.existsSync(restored)).toBe(false);
  const bytes = fs.readFileSync(encrypted);
  bytes[25] = bytes[25]! ^ 1;
  fs.writeFileSync(encrypted, bytes);
  await expect(
    decryptSupabaseBackup(
      encrypted,
      restored,
      "backup-secret",
      "instance:version:backup",
    ),
  ).rejects.toThrow("authentication");
  expect(fs.existsSync(restored)).toBe(false);
});

async function connectionProject(
  context: Awaited<ReturnType<typeof fixture>>,
  name = "App",
  website?: string,
) {
  const { app, db, headers } = context;
  const response = await app.inject({
    method: "POST",
    url: "/api/projects/git",
    headers,
    payload: { name, repositoryUrl: "https://github.com/example/app.git" },
  });
  expect(response.statusCode).toBe(201);
  const id = response.json().project.id as string;
  db.updateDeployment(response.json().deployment.id, { status: "cancelled" });
  if (website)
    db.createDomain({
      id: newId("dom"),
      project_id: id,
      hostname: website,
      zone_id: null,
      dns_record_id: null,
      status: "active",
      error: null,
      created_at: new Date().toISOString(),
    });
  return id;
}
async function connectionInstance(
  context: Awaited<ReturnType<typeof fixture>>,
) {
  const { app, db, headers, input } = context;
  const response = await app.inject({
    method: "POST",
    url: "/api/supabase",
    headers,
    payload: input,
  });
  expect(response.statusCode).toBe(202);
  const store = new SupabaseStore(db),
    id = response.json().instance.id as string;
  store.finish(store.claim()!);
  store.update(id, { status: "running" });
  return id;
}
it("reserves an app at creation and installs framework-specific public variables only after Supabase is ready", async () => {
  const context = await fixture();
  const { app, db, config, headers, input } = context;
  const projectId = await connectionProject(
    context,
    "Vite app",
    "vite.example.com",
  );
  const root = db.getProject(projectId)!.root_directory;
  db.sqlite
    .prepare("UPDATE projects SET source_analysis_json=? WHERE id=?")
    .run(
      JSON.stringify({
        fingerprint: "fixture",
        recommendedApplicationId: "app",
        applications: [
          { id: "app", rootDirectory: root, framework: "vite", evidence: [] },
        ],
      }),
      projectId,
    );
  const { siteUrl: _siteUrl, ...base } = input;
  const created = await app.inject({
    method: "POST",
    url: "/api/supabase",
    headers,
    payload: { ...base, connection: { projectId } },
  });
  expect(created.statusCode).toBe(202);
  expect(created.json().instance.settings.siteUrl).toBe(
    "https://vite.example.com",
  );
  expect(db.listEnvironment(projectId)).toHaveLength(0);
  const service = new SupabaseConnections(config, db);
  expect(service.list()[0]).toMatchObject({
    projectId,
    status: "pending",
    urlVariable: "VITE_SUPABASE_URL",
    keyVariable: "VITE_SUPABASE_ANON_KEY",
  });
  const store = new SupabaseStore(db);
  store.finish(store.claim()!);
  store.update(created.json().instance.id, { status: "running" });
  new SupabaseConnections(config, db).reconcile();
  const values = Object.fromEntries(
    db
      .listEnvironment(projectId)
      .map((entry) => [
        entry.key,
        decryptString(entry.encrypted_value, config.APP_SECRET),
      ]),
  );
  expect(values.VITE_SUPABASE_URL).toBe("https://api.example.com");
  const secrets = JSON.parse(
    decryptString(
      store.get(created.json().instance.id).encrypted_secrets,
      config.APP_SECRET,
    ),
  );
  expect(values.VITE_SUPABASE_ANON_KEY).toBe(secrets.anonKey);
  expect(JSON.stringify(values)).not.toContain(secrets.serviceKey);
  expect(service.list()[0]?.status).toBe("redeploy_required");
  const catalog = await app.inject({
    url: "/api/supabase/connections",
    headers,
  });
  expect(
    catalog
      .json()
      .projects.find((project: { id: string }) => project.id === projectId),
  ).toMatchObject({
    website: "https://vite.example.com",
    urlVariable: "VITE_SUPABASE_URL",
  });
  expect(catalog.body).not.toContain(secrets.anonKey);
});
it("rolls back creation on app-variable conflicts and checks the additional environment scope", async () => {
  const context = await fixture();
  const { app, db, headers, input } = context;
  const projectId = await connectionProject(context);
  await app.inject({
    method: "PUT",
    url: `/api/projects/${projectId}/environment`,
    headers,
    payload: {
      variables: [
        { key: "SUPABASE_URL", value: "https://external.example.com" },
      ],
    },
  });
  const response = await app.inject({
    method: "POST",
    url: "/api/supabase",
    headers,
    payload: { ...input, connection: { projectId } },
  });
  expect(response.json().code).toBe("ENV_EXISTS");
  expect(new SupabaseStore(db).list()).toHaveLength(0);
  expect(
    db.sqlite.prepare("SELECT count(*) AS n FROM supabase_connections").get(),
  ).toEqual({ n: 0 });
  const token = await app.inject({
    method: "POST",
    url: "/api/settings/api-tokens",
    headers,
    payload: {
      name: "limited",
      access: "write",
      currentPassword: "correct horse battery staple",
    },
  });
  db.sqlite
    .prepare("UPDATE api_tokens SET scopes_json=? WHERE id=?")
    .run(
      JSON.stringify(["projects:write", "domains:write"]),
      token.json().apiToken.id,
    );
  const denied = await app.inject({
    method: "POST",
    url: "/api/supabase",
    headers: { authorization: `Bearer ${token.json().secret}` },
    payload: { ...input, connection: { projectId, replace: true } },
  });
  expect(denied.statusCode).toBe(403);
  expect(new SupabaseStore(db).list()).toHaveLength(0);
});
it("does not overwrite app edits made while provisioning a pending connection", async () => {
  const context = await fixture();
  const { app, db, config, headers, input } = context;
  const projectId = await connectionProject(context);
  const created = await app.inject({
    method: "POST",
    url: "/api/supabase",
    headers,
    payload: { ...input, connection: { projectId } },
  });
  expect(created.statusCode).toBe(202);
  await app.inject({
    method: "PUT",
    url: `/api/projects/${projectId}/environment`,
    headers,
    payload: {
      variables: [{ key: "SUPABASE_URL", value: "https://edited.example.com" }],
    },
  });
  const store = new SupabaseStore(db);
  store.finish(store.claim()!);
  store.update(created.json().instance.id, { status: "running" });
  const service = new SupabaseConnections(config, db);
  service.reconcile();
  expect(service.list()[0]).toMatchObject({
    status: "error",
    errorCode: "ENV_CHANGED",
  });
  expect(
    decryptString(
      db.listEnvironment(projectId)[0]!.encrypted_value,
      config.APP_SECRET,
    ),
  ).toBe("https://edited.example.com");
});
it("adds an exact app sign-in destination through the worker before applying its variables", async () => {
  const context = await fixture();
  const { app, db, config, headers } = context;
  const id = await connectionInstance(context);
  const projectId = await connectionProject(
    context,
    "Second app",
    "second.example.com",
  );
  const response = await app.inject({
    method: "POST",
    url: `/api/supabase/${id}/connections`,
    headers,
    payload: { projectId },
  });
  expect(response.statusCode).toBe(200);
  expect(response.json().connection.status).toBe("pending");
  expect(db.listEnvironment(projectId)).toHaveLength(0);
  const store = new SupabaseStore(db);
  expect(JSON.parse(store.get(id).settings_json).redirectUrls).toContain(
    "https://second.example.com",
  );
  vi.spyOn(SupabaseRuntime.prototype, "removeAuth").mockResolvedValue();
  vi.spyOn(SupabaseRuntime.prototype, "start").mockResolvedValue(54321);
  await new SupabaseWorker(config, db).processNext();
  expect(new SupabaseConnections(config, db).list()[0]?.status).toBe(
    "redeploy_required",
  );
  expect(db.listEnvironment(projectId)).toHaveLength(2);
});
it("tracks redeploy and key changes, and preserves manually edited values when disconnecting", async () => {
  const context = await fixture();
  const { app, db, config, headers } = context;
  const id = await connectionInstance(context);
  const projectId = await connectionProject(context);
  const url = `/api/supabase/${id}/connections`;
  expect(
    (await app.inject({ method: "POST", url, headers, payload: { projectId } }))
      .statusCode,
  ).toBe(200);
  const service = new SupabaseConnections(config, db);
  expect(service.list()[0]?.status).toBe("redeploy_required");
  const deployment = await app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/deploy`,
    headers,
    payload: {},
  });
  expect(deployment.statusCode).toBe(202);
  const deploymentId = deployment.json().deployment.id;
  db.updateDeployment(deploymentId, { status: "ready" });
  db.updateProject(projectId, { active_deployment_id: deploymentId });
  expect(service.list()[0]?.status).toBe("ready");
  service.recordCheck(projectId, deploymentId, false);
  expect(service.list()[0]?.verification?.ok).toBe(false);
  service.recordCheck(projectId, deploymentId, true);
  expect(service.list()[0]?.verification?.ok).toBe(true);
  db.sqlite
    .prepare("UPDATE deployments SET trigger='rollback' WHERE id=?")
    .run(deploymentId);
  expect(service.list()[0]?.status).toBe("redeploy_required");
  expect(service.list()[0]?.verification).toBeNull();
  db.sqlite
    .prepare("UPDATE deployments SET trigger='manual' WHERE id=?")
    .run(deploymentId);
  const store = new SupabaseStore(db),
    old = JSON.parse(
      decryptString(store.get(id).encrypted_secrets, config.APP_SECRET),
    );
  const fresh = createSupabaseSecrets();
  old.anonKey = fresh.anonKey;
  old.serviceKey = fresh.serviceKey;
  old.jwtSecret = fresh.jwtSecret;
  store.update(id, {
    encrypted_secrets: encryptString(JSON.stringify(old), config.APP_SECRET),
  });
  expect(service.list()[0]).toMatchObject({
    status: "needs_update",
    errorCode: "KEYS_CHANGED",
  });
  expect(
    (await app.inject({ method: "POST", url, headers, payload: { projectId } }))
      .statusCode,
  ).toBe(200);
  expect(service.list()[0]?.status).toBe("redeploy_required");
  await app.inject({
    method: "PUT",
    url: `/api/projects/${projectId}/environment`,
    headers,
    payload: {
      variables: [
        { key: "SUPABASE_URL", value: "https://manual.example.com" },
        { key: "KEEP", value: "untouched" },
      ],
    },
  });
  const removed = await app.inject({
    method: "DELETE",
    url: `${url}/${projectId}`,
    headers,
  });
  expect(removed.statusCode).toBe(200);
  expect(removed.json().environmentRetained).toBe(true);
  expect(service.list()).toHaveLength(0);
  expect(db.listEnvironment(projectId)).toHaveLength(2);
});
it("removes only unchanged managed variables on disconnect", async () => {
  const context = await fixture();
  const { app, db, headers } = context;
  const id = await connectionInstance(context);
  const projectId = await connectionProject(context);
  await app.inject({
    method: "PUT",
    url: `/api/projects/${projectId}/environment`,
    headers,
    payload: { variables: [{ key: "KEEP", value: "untouched" }] },
  });
  await app.inject({
    method: "POST",
    url: `/api/supabase/${id}/connections`,
    headers,
    payload: { projectId },
  });
  const removed = await app.inject({
    method: "DELETE",
    url: `/api/supabase/${id}/connections/${projectId}`,
    headers,
  });
  expect(removed.json()).toEqual({
    environmentRetained: false,
    redeployRequired: true,
  });
  expect(db.listEnvironment(projectId).map((entry) => entry.key)).toEqual([
    "KEEP",
  ]);
});

it.each([
  ["next", [], "NEXT_PUBLIC_"],
  ["astro", [], "PUBLIC_"],
  ["react", ["Create React App build detected"], "REACT_APP_"],
] as const)(
  "suggests %s connection variables from the selected application's analysis",
  async (framework, evidence, prefix) => {
    const context = await fixture();
    const projectId = await connectionProject(context);
    const { db, app, headers } = context;
    db.sqlite
      .prepare("UPDATE projects SET source_analysis_json=? WHERE id=?")
      .run(
        JSON.stringify({
          fingerprint: "analysis",
          recommendedApplicationId: "app",
          applications: [
            {
              id: "app",
              rootDirectory: db.getProject(projectId)!.root_directory,
              framework,
              evidence,
            },
          ],
        }),
        projectId,
      );
    const response = await app.inject({
      url: "/api/supabase/connections",
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(
      response
        .json()
        .projects.find((project: { id: string }) => project.id === projectId),
    ).toMatchObject({
      urlVariable: `${prefix}SUPABASE_URL`,
      keyVariable: `${prefix}SUPABASE_ANON_KEY`,
    });
  },
);
it("waits for an active application deployment without changing its variables or cancelling it", async () => {
  const context = await fixture();
  const { app, db, config, headers } = context;
  const id = await connectionInstance(context),
    projectId = await connectionProject(context);
  const deployment = await app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/deploy`,
    headers,
    payload: {},
  });
  expect(deployment.statusCode).toBe(202);
  const response = await app.inject({
    method: "POST",
    url: `/api/supabase/${id}/connections`,
    headers,
    payload: { projectId },
  });
  expect(response.json().connection.status).toBe("pending");
  expect(db.listEnvironment(projectId)).toHaveLength(0);
  expect(db.getDeployment(deployment.json().deployment.id)?.status).toBe(
    "queued",
  );
  db.updateDeployment(deployment.json().deployment.id, { status: "cancelled" });
  new SupabaseConnections(config, db).reconcile();
  expect(db.listEnvironment(projectId)).toHaveLength(2);
});
it("requires explicit consent before moving an app to a different Supabase instance", async () => {
  const context = await fixture();
  const { app, db, headers, input, config } = context;
  const first = await connectionInstance(context),
    projectId = await connectionProject(context);
  const second = await app.inject({
    method: "POST",
    url: "/api/supabase",
    headers,
    payload: {
      ...input,
      apiHostname: "other-api.example.com",
      studioHostname: "other-studio.example.com",
    },
  });
  expect(second.statusCode).toBe(202);
  const store = new SupabaseStore(db);
  store.finish(store.claim()!);
  store.update(second.json().instance.id, { status: "running" });
  await app.inject({
    method: "POST",
    url: `/api/supabase/${first}/connections`,
    headers,
    payload: { projectId },
  });
  const endpoint = `/api/supabase/${second.json().instance.id}/connections`;
  expect(
    (
      await app.inject({
        method: "POST",
        url: endpoint,
        headers,
        payload: { projectId },
      })
    ).json().code,
  ).toBe("CONNECTION_EXISTS");
  expect(
    (
      await app.inject({
        method: "POST",
        url: endpoint,
        headers,
        payload: { projectId, replace: true },
      })
    ).statusCode,
  ).toBe(200);
  expect(new SupabaseConnections(config, db).list()[0]?.instanceId).toBe(
    second.json().instance.id,
  );
});

it("keeps an app's existing variable convention ahead of framework suggestions", async () => {
  const context = await fixture();
  const { app, db, headers } = context;
  const projectId = await connectionProject(context);
  db.sqlite
    .prepare("UPDATE projects SET source_analysis_json=? WHERE id=?")
    .run(
      JSON.stringify({
        fingerprint: "next",
        recommendedApplicationId: "app",
        applications: [
          {
            id: "app",
            rootDirectory: db.getProject(projectId)!.root_directory,
            framework: "next",
            evidence: [],
          },
        ],
      }),
      projectId,
    );
  await app.inject({
    method: "PUT",
    url: `/api/projects/${projectId}/environment`,
    headers,
    payload: {
      variables: [
        { key: "SUPABASE_URL", value: "https://existing.example.com" },
      ],
    },
  });
  const response = await app.inject({
    url: "/api/supabase/connections",
    headers,
  });
  expect(
    response
      .json()
      .projects.find((project: { id: string }) => project.id === projectId),
  ).toMatchObject({
    urlVariable: "SUPABASE_URL",
    keyVariable: "SUPABASE_ANON_KEY",
  });
});

async function studioFixture() {
  const context = await fixture();
  context.db.setSetting("cloudflare.panel_domain", "panel.example.com");
  const created = await context.app.inject({
    method: "POST",
    url: "/api/supabase",
    headers: context.headers,
    payload: context.input,
  });
  const store = new SupabaseStore(context.db);
  const instance = store.get(created.json().instance.id);
  store.update(instance.id, { status: "running" });
  const panelHeaders = { ...context.headers, host: "panel.example.com" };
  const studioHeaders = {
    host: instance.studio_hostname,
    "x-forwarded-proto": "https",
  };
  const issue = async () => {
    const launch = await context.app.inject({
      method: "POST",
      url: `/api/supabase/${instance.id}/studio-session`,
      headers: panelHeaders,
      payload: {},
    });
    expect(launch.statusCode).toBe(200);
    const startUrl = new URL(launch.json().url);
    const start = await context.app.inject({
      url: startUrl.pathname + startUrl.search,
      headers: studioHeaders,
      remoteAddress: context.config.TRUSTED_PROXY_IP,
    });
    expect(start.statusCode).toBe(303);
    const state = new URL(start.headers.location!).searchParams.get("state")!;
    const stateCookie = start.cookies.find(
      (cookie) => cookie.name === "__Host-shelter_studio_state",
    )!;
    const granted = await context.app.inject({
      method: "POST",
      url: `/api/supabase/${instance.id}/studio-session`,
      headers: panelHeaders,
      payload: { state },
    });
    expect(granted.statusCode).toBe(200);
    return {
      ticket: new URL(granted.json().url).hash.slice(1),
      cookie: `${stateCookie.name}=${stateCookie.value}`,
    };
  };
  return { ...context, store, instance, panelHeaders, studioHeaders, issue };
}

it("opens Studio with a browser-bound one-use grant, keeps passwords internal, and revokes access on Shelter logout", async () => {
  const { app, db, config, instance, panelHeaders, studioHeaders, issue } =
    await studioFixture();
  const endpoint = `/api/supabase/${instance.id}/studio-session`;
  expect(
    (
      await app.inject({
        method: "POST",
        url: endpoint,
        headers: { host: "panel.example.com" },
        payload: {},
      })
    ).statusCode,
  ).toBe(401);
  expect(
    (
      await app.inject({
        method: "POST",
        url: endpoint,
        headers: { ...panelHeaders, "x-csrf-token": "wrong" },
        payload: {},
      })
    ).statusCode,
  ).toBe(403);
  const grant = await issue();
  const exchange = (
    cookie = grant.cookie,
    origin = `https://${instance.studio_hostname}`,
  ) =>
    app.inject({
      method: "POST",
      url: "/_shelter/studio/exchange",
      remoteAddress: config.TRUSTED_PROXY_IP,
      headers: { ...studioHeaders, cookie, origin },
      payload: { ticket: grant.ticket },
    });
  expect((await exchange("__Host-shelter_studio_state=wrong")).statusCode).toBe(
    403,
  );
  expect(
    (await exchange(grant.cookie, "https://attacker.example")).statusCode,
  ).toBe(403);
  const attempts = await Promise.all([exchange(), exchange()]);
  expect(attempts.map((response) => response.statusCode).sort()).toEqual([
    200, 403,
  ]);
  const redeemed = attempts.find((response) => response.statusCode === 200)!;
  expect(redeemed.statusCode).toBe(200);
  expect(redeemed.headers["referrer-policy"]).toBe("no-referrer");
  expect((await exchange()).statusCode).toBe(403);
  const cookie = redeemed.cookies.find(
    (cookie) => cookie.name === "__Host-shelter_studio",
  )!;
  expect(cookie).toMatchObject({
    secure: true,
    httpOnly: true,
    sameSite: "Strict",
    path: "/",
  });
  expect(cookie.domain).toBeUndefined();
  const authorizeHeaders = {
    host: "api:7080",
    "x-forwarded-host": instance.studio_hostname,
    "x-forwarded-proto": "https",
    cookie: `${cookie.name}=${cookie.value}`,
  };
  const authorizeUrl = `/api/supabase/${instance.id}/studio-authorize`;
  const allowed = await app.inject({
    url: authorizeUrl,
    headers: authorizeHeaders,
    remoteAddress: config.TRUSTED_PROXY_IP,
  });
  expect(allowed.statusCode).toBe(204);
  const secrets = JSON.parse(
    decryptString(instance.encrypted_secrets, config.APP_SECRET),
  );
  expect(allowed.headers.authorization).toBe(
    `Basic ${Buffer.from(`supabase:${secrets.studioPassword}`).toString("base64")}`,
  );
  const manual = await app.inject({
    url: authorizeUrl,
    headers: {
      ...authorizeHeaders,
      cookie: "",
      authorization: allowed.headers.authorization!,
    },
    remoteAddress: config.TRUSTED_PROXY_IP,
  });
  expect(manual.statusCode).toBe(204);
  expect(manual.headers.authorization).toBe(allowed.headers.authorization);
  expect(redeemed.body + grant.ticket + cookie.value).not.toContain(
    secrets.studioPassword,
  );
  for (const headers of [
    { ...authorizeHeaders, host: "panel.example.com" },
    { ...authorizeHeaders, "x-forwarded-host": "wrong.example.com" },
  ]) {
    const denied = await app.inject({
      url: authorizeUrl,
      headers,
      remoteAddress: config.TRUSTED_PROXY_IP,
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.headers.authorization).toBeUndefined();
  }
  expect(
    (await app.inject({ url: authorizeUrl, headers: authorizeHeaders }))
      .statusCode,
  ).toBe(403);
  const logout = await app.inject({
    method: "POST",
    url: "/api/auth/logout",
    headers: panelHeaders,
  });
  expect(logout.statusCode).toBe(200);
  expect(
    (
      await app.inject({
        url: authorizeUrl,
        headers: authorizeHeaders,
        remoteAddress: config.TRUSTED_PROXY_IP,
      })
    ).statusCode,
  ).toBe(401);
  expect(
    db.sqlite.prepare("SELECT count(*) AS n FROM supabase_studio_access").get(),
  ).toEqual({ n: 0 });
});

it.each(["expired", "credentials rotated", "instance stopped"])(
  "rejects a Studio grant when %s without setting a browser session",
  async (reason) => {
    const { app, db, config, instance, store, studioHeaders, issue } =
      await studioFixture();
    const grant = await issue();
    if (reason === "expired")
      db.sqlite
        .prepare("UPDATE supabase_studio_access SET expires_at = ?")
        .run(new Date(0).toISOString());
    if (reason === "credentials rotated")
      store.update(instance.id, {
        encrypted_secrets: encryptString(
          JSON.stringify(createSupabaseSecrets()),
          config.APP_SECRET,
        ),
      });
    if (reason === "instance stopped")
      store.update(instance.id, { status: "stopped" });
    const response = await app.inject({
      method: "POST",
      url: "/_shelter/studio/exchange",
      remoteAddress: config.TRUSTED_PROXY_IP,
      headers: {
        ...studioHeaders,
        origin: `https://${instance.studio_hostname}`,
        cookie: grant.cookie,
      },
      payload: { ticket: grant.ticket },
    });
    expect(response.statusCode).toBe(403);
    expect(
      response.cookies.some(
        (cookie) => cookie.name === "__Host-shelter_studio",
      ),
    ).toBe(false);
  },
);

it("keeps function versions encrypted, reloads deployed code and refuses stale or unauthenticated edits", async () => {
  const { app, db, config, headers, input } = await fixture();
  const created = await app.inject({
    method: "POST",
    url: "/api/supabase",
    headers,
    payload: input,
  });
  const store = new SupabaseStore(db),
    id = created.json().instance.id as string;
  store.finish(store.claim()!);
  store.update(id, { status: "running" });
  const endpoint = `/api/supabase/${id}/functions`,
    source = "Deno.serve(()=>new Response('private-function-source'));";
  const files = new Map<string, string>();
  vi.spyOn(SupabaseRuntime.prototype, "functionFiles").mockImplementation(
    async () => new Map(files),
  );
  vi.spyOn(SupabaseRuntime.prototype, "validateFunction").mockResolvedValue();
  vi.spyOn(SupabaseRuntime.prototype, "start").mockResolvedValue(54321);
  vi.spyOn(SupabaseRuntime.prototype, "healthy").mockResolvedValue();
  vi.spyOn(SupabaseRuntime.prototype, "writeFunction").mockImplementation(
    async (_instance, name, source) => {
      files.set(name, source);
    },
  );
  const dns = vi
    .spyOn(CloudflareService.prototype, "ensurePreviewDnsRecord")
    .mockRejectedValue(new Error("Provider credentials expired"));
  expect((await app.inject({ url: endpoint })).statusCode).toBe(401);
  expect(
    (
      await app.inject({
        method: "POST",
        url: endpoint,
        headers: { ...headers, "x-csrf-token": "invalid" },
        payload: { name: "hello", source },
      })
    ).statusCode,
  ).toBe(403);
  for (const name of ["../escape", "main", "hello/other"])
    expect(
      (
        await app.inject({
          method: "POST",
          url: endpoint,
          headers,
          payload: { name, source },
        })
      ).statusCode,
    ).toBe(400);
  const queued = await app.inject({
    method: "POST",
    url: endpoint,
    headers,
    payload: { name: "hello", source, expectedHash: null },
  });
  expect(queued.statusCode).toBe(202);
  const pending = db.sqlite
    .prepare("SELECT encrypted_input FROM supabase_operations WHERE job_id=?")
    .get(queued.json().jobId) as { encrypted_input: string };
  expect(pending.encrypted_input).not.toContain("private-function-source");
  expect(decryptString(pending.encrypted_input, config.APP_SECRET)).toContain(
    "private-function-source",
  );
  expect(
    (
      await app.inject({
        method: "POST",
        url: endpoint,
        headers,
        payload: { name: "other", source },
      })
    ).statusCode,
  ).toBe(409);
  await new SupabaseWorker(config, db).processNext();
  expect(dns).not.toHaveBeenCalled();
  expect(store.get(id).status).toBe("running");
  const loaded = (
    await app.inject({ url: `${endpoint}/hello`, headers })
  ).json();
  expect(loaded.source).toBe(source);
  expect(loaded.versions).toHaveLength(1);
  expect((await app.inject({ url: endpoint, headers })).body).not.toContain(
    "private-function-source",
  );
  expect(
    (
      await app.inject({
        method: "POST",
        url: endpoint,
        headers,
        payload: { name: "hello", source, expectedHash: null },
      })
    ).statusCode,
  ).toBe(409);
  const next = "Deno.serve(()=>new Response('version two'));";
  const changed = await app.inject({
    method: "POST",
    url: endpoint,
    headers,
    payload: { name: "hello", source: next, expectedHash: loaded.hash },
  });
  expect(changed.statusCode).toBe(202);
  await new SupabaseWorker(config, db).processNext();
  const updated = (
    await app.inject({ url: `${endpoint}/hello`, headers })
  ).json();
  expect(updated.source).toBe(next);
  expect(updated.versions).toHaveLength(2);
  const previous = (
    await app.inject({
      url: `${endpoint}/hello?versionId=${loaded.versionId}`,
      headers,
    })
  ).json();
  expect(previous.source).toBe(source);
  const encrypted = db.sqlite
    .prepare("SELECT encrypted_source FROM supabase_function_versions")
    .all() as { encrypted_source: string }[];
  expect(
    encrypted.every((row) => !row.encrypted_source.includes("Deno.serve")),
  ).toBe(true);
});

it("retains the active function and healthy instance when runtime validation fails, and restores code after activation fails", async () => {
  const { app, db, config, headers, input } = await fixture();
  const created = await app.inject({
    method: "POST",
    url: "/api/supabase",
    headers,
    payload: input,
  });
  const store = new SupabaseStore(db),
    id = created.json().instance.id as string;
  store.finish(store.claim()!);
  store.update(id, { status: "running" });
  const files = new Map([["hello", "old source"]]);
  vi.spyOn(SupabaseRuntime.prototype, "functionFiles").mockImplementation(
    async () => new Map(files),
  );
  vi.spyOn(SupabaseRuntime.prototype, "start").mockResolvedValue(54321);
  const validate = vi
    .spyOn(SupabaseRuntime.prototype, "validateFunction")
    .mockRejectedValue(new Error("private-diagnostic-secret"));
  const write = vi
    .spyOn(SupabaseRuntime.prototype, "writeFunction")
    .mockImplementation(async (_instance, name, source) => {
      files.set(name, source);
    });
  const sync = await app.inject({
    method: "POST",
    url: `/api/supabase/${id}/functions/refresh`,
    headers,
  });
  expect(sync.statusCode).toBe(202);
  const worker = new SupabaseWorker(config, db);
  await worker.processNext();
  const current = (
    await app.inject({ url: `/api/supabase/${id}/functions/hello`, headers })
  ).json();
  const deploy = () =>
    app.inject({
      method: "POST",
      url: `/api/supabase/${id}/functions`,
      headers,
      payload: {
        name: "hello",
        source: "invalid candidate",
        expectedHash: current.hash,
      },
    });
  expect((await deploy()).statusCode).toBe(202);
  await worker.processNext();
  expect(write).not.toHaveBeenCalled();
  expect(files.get("hello")).toBe("old source");
  expect(store.get(id).status).toBe("running");
  expect(store.jobs(id)[0]?.error).toBe("FUNCTION_VALIDATION_FAILED");
  expect(
    (await app.inject({ url: `/api/supabase/${id}`, headers })).body,
  ).not.toContain("private-diagnostic-secret");
  validate.mockResolvedValue();
  vi.spyOn(SupabaseRuntime.prototype, "healthy")
    .mockRejectedValueOnce(new Error("unhealthy"))
    .mockResolvedValue();
  expect((await deploy()).statusCode).toBe(202);
  await worker.processNext();
  expect(files.get("hello")).toBe("old source");
  expect(store.get(id).status).toBe("running");
  expect(store.jobs(id)[0]?.error).toBe("FUNCTION_ACTIVATION_FAILED");
});

it("persists a backup schedule without exposing storage credentials and queues one due backup", async () => {
  const { app, db, config, headers, input } = await fixture();
  const created = await app.inject({
    method: "POST",
    url: "/api/supabase",
    headers,
    payload: input,
  });
  const store = new SupabaseStore(db),
    id = created.json().instance.id as string;
  store.finish(store.claim()!);
  store.update(id, { status: "running" });
  const endpoint = `/api/supabase/${id}/backup-policy`;
  const payload = {
    enabled: true,
    hourUtc: 3,
    destination: "s3",
    s3: {
      endpoint: "https://s3.example.com",
      region: "eu-central-1",
      bucket: "backups",
      accessKeyId: "fixture-access",
      secretAccessKey: "fixture-storage-secret",
    },
  };
  expect(
    (
      await app.inject({
        method: "PUT",
        url: endpoint,
        headers: { ...headers, "x-csrf-token": "wrong" },
        payload,
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await app.inject({
        method: "PUT",
        url: endpoint,
        headers,
        payload: {
          ...payload,
          s3: { ...payload.s3, endpoint: "https://127.0.0.1" },
        },
      })
    ).statusCode,
  ).toBe(400);
  const saved = await app.inject({
    method: "PUT",
    url: endpoint,
    headers,
    payload,
  });
  expect(saved.statusCode).toBe(200);
  expect(saved.body).not.toContain("fixture-storage-secret");
  const read = await app.inject({ url: endpoint, headers });
  expect(read.json().s3.hasSecret).toBe(true);
  expect(read.body).not.toContain("fixture-storage-secret");
  const raw = db.sqlite
    .prepare(
      "SELECT encrypted_destination FROM supabase_backup_policies WHERE instance_id=?",
    )
    .get(id) as { encrypted_destination: string };
  expect(raw.encrypted_destination).not.toContain("fixture-storage-secret");
  expect(decryptString(raw.encrypted_destination, config.APP_SECRET)).toContain(
    "fixture-storage-secret",
  );
  db.sqlite
    .prepare(
      "UPDATE supabase_backup_policies SET next_at=? WHERE instance_id=?",
    )
    .run(new Date(0).toISOString(), id);
  const { SupabaseBackupPolicy } =
    await import("../src/services/supabase-backup-policy.js");
  const policy = new SupabaseBackupPolicy(config, db);
  policy.schedule();
  policy.schedule();
  expect(store.jobs(id).filter((j) => j.action === "backup")).toHaveLength(1);
  expect(new Date(policy.get(id).nextAt!).getTime()).toBeGreaterThan(
    Date.now(),
  );
});

it("does not replay a mutating function test after worker recovery", async () => {
  const { app, db, config, headers, input } = await fixture();
  const created = await app.inject({
    method: "POST",
    url: "/api/supabase",
    headers,
    payload: input,
  });
  const store = new SupabaseStore(db),
    id = created.json().instance.id as string;
  store.finish(store.claim()!);
  store.update(id, { status: "running" });
  const queued = await app.inject({
    method: "POST",
    url: `/api/supabase/${id}/functions/hello/invoke`,
    headers,
    payload: { method: "POST", body: '{"charge":true}', auth: "anon" },
  });
  expect(queued.statusCode).toBe(202);
  store.claim();
  vi.spyOn(SupabaseRuntime.prototype, "recoverHelpers").mockResolvedValue();
  await new SupabaseWorker(config, db).recover();
  expect(store.jobs(id)[0]?.status).toBe("failed");
  expect(store.jobs(id)[0]?.error).toBe("REQUEST_INTERRUPTED");
  expect(store.claim()).toBeUndefined();
});

it("verifies a backup using separate container, network and volume identities without stopping the live instance", async () => {
  const { app, db, config, headers, input } = await fixture();
  const created = await app.inject({
    method: "POST",
    url: "/api/supabase",
    headers,
    payload: input,
  });
  const store = new SupabaseStore(db),
    id = created.json().instance.id as string;
  store.finish(store.claim()!);
  store.update(id, { status: "running" });
  const instance = store.get(id),
    backupId = newId("sbb"),
    directory = path.join(config.DATA_DIR, "supabase-backups", id);
  fs.mkdirSync(directory, { recursive: true });
  const plain = path.join(directory, "test-source"),
    encrypted = path.join(directory, `${backupId}.enc`);
  fs.writeFileSync(plain, "opaque fixture snapshot");
  await encryptSupabaseBackup(
    plain,
    encrypted,
    config.APP_SECRET,
    `${id}:${instance.version}:${backupId}`,
  );
  const { supabaseBackupHash } =
    await import("../src/services/supabase-backup.js");
  store.addBackup({
    id: backupId,
    instance_id: id,
    version: instance.version,
    generation: instance.generation,
    status: "ready",
    encrypted_secrets: instance.encrypted_secrets,
    settings_json: instance.settings_json,
    size_bytes: fs.statSync(encrypted).size,
    sha256: await supabaseBackupHash(encrypted),
    created_at: new Date().toISOString(),
  });
  vi.spyOn(SupabaseRuntime.prototype, "preflight").mockResolvedValue();
  vi.spyOn(SupabaseRuntime.prototype, "diskBudget").mockResolvedValue();
  const stop = vi.spyOn(SupabaseRuntime.prototype, "stop").mockResolvedValue();
  const snapshot = vi
    .spyOn(SupabaseRuntime.prototype, "snapshot")
    .mockResolvedValue();
  const start = vi
    .spyOn(SupabaseRuntime.prototype, "startIsolated")
    .mockResolvedValue();
  vi.spyOn(SupabaseRuntime.prototype, "discardVolumes").mockResolvedValue();
  vi.spyOn(SupabaseRuntime.prototype, "discardNetworks").mockResolvedValue();
  vi.spyOn(SupabaseRuntime.prototype, "ensureTestNetworks").mockResolvedValue();
  const restoreProbe = vi
    .spyOn(SupabaseRuntime.prototype, "request")
    .mockResolvedValue({
      status: 200,
      body: "{}",
      durationMs: 1,
    });
  const queued = await app.inject({
    method: "POST",
    url: `/api/supabase/${id}/backups/${backupId}/verify`,
    headers,
  });
  expect(queued.statusCode).toBe(202);
  await new SupabaseWorker(config, db).processNext();
  expect(store.jobs(id)[0]?.status).toBe("ready");
  expect(store.get(id).generation).toBe(instance.generation);
  expect(store.get(id).status).toBe("running");
  for (const target of [
    ...stop.mock.calls,
    ...snapshot.mock.calls,
    ...start.mock.calls,
  ].map((call) => call[0])) {
    expect(target.id).not.toBe(id);
    expect(target.generation).not.toBe(instance.generation);
  }
  expect(restoreProbe).toHaveBeenCalledWith(
    expect.any(Object),
    expect.objectContaining({ url: "http://auth:9999/health" }),
  );
  expect(start).toHaveBeenCalledWith(
    expect.objectContaining({
      id: queued.json().jobId.replace(/^sbj_/, "sb_"),
    }),
    expect.any(Object),
  );
  expect(
    (await app.inject({ url: `/api/supabase/${id}`, headers })).json().instance
      .backups[0].verification.restoredAt,
  ).toBeTruthy();
});
