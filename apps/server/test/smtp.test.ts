import tls from "node:tls";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import nodemailer from "nodemailer";
import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { Database } from "../src/lib/database.js";
import { encryptString, decryptString, newId } from "../src/lib/security.js";
import {
  SupabaseStore,
  type SupabaseSettings,
} from "../src/services/supabase-store.js";
import { SupabaseWorker } from "../src/services/supabase-worker.js";
import { createSupabaseSecrets } from "../src/services/supabase-template.js";

const apps: Awaited<ReturnType<typeof createApp>>[] = [];
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const app of apps.splice(0)) await app.close();
  for (const dir of directories.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});
const input = {
  expectedRevision: null,
  enabled: true,
  provider: "resend",
  host: "smtp.resend.com",
  port: 465,
  user: "resend",
  password: "fake-smtp-credential",
  fromEmail: "sender@example.com",
  fromName: "Example",
};
async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shelter-smtp-"));
  directories.push(dir);
  const config = loadConfig({
    NODE_ENV: "test",
    DATA_DIR: dir,
    WEB_DIST: path.join(dir, "missing"),
    APP_SECRET: "m".repeat(64),
    ADMIN_EMAIL: "admin@example.com",
    ADMIN_PASSWORD: "correct horse battery staple",
    LOG_LEVEL: "silent",
  });
  const db = new Database(config);
  const app = await createApp(config, db);
  apps.push(app);
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: config.ADMIN_EMAIL, password: config.ADMIN_PASSWORD },
  });
  const headers = {
    cookie: `shelter_session=${login.cookies.find((c) => c.name === "shelter_session")!.value}`,
    "x-csrf-token": login.json().csrfToken as string,
  };
  const transport = {
    verify: vi.fn().mockResolvedValue(true),
    sendMail: vi.fn().mockResolvedValue({ accepted: ["admin@example.com"] }),
    close: vi.fn(),
  };
  vi.spyOn(nodemailer, "createTransport").mockReturnValue(
    transport as unknown as ReturnType<typeof nodemailer.createTransport>,
  );
  return { app, db, config, headers, transport };
}
it("protects SMTP configuration, encrypts credentials and limits test mail to the authenticated administrator", async () => {
  const { app, db, headers, transport } = await fixture();
  expect((await app.inject({ url: "/api/settings/smtp" })).statusCode).toBe(
    401,
  );
  expect(
    (
      await app.inject({
        method: "PUT",
        url: "/api/settings/smtp",
        headers: { cookie: headers.cookie },
        payload: input,
      })
    ).statusCode,
  ).toBe(403);
  const token = await app.inject({
    method: "POST",
    url: "/api/settings/api-tokens",
    headers,
    payload: {
      name: "automation",
      access: "write",
      currentPassword: "correct horse battery staple",
    },
  });
  expect(
    (
      await app.inject({
        url: "/api/settings/smtp",
        headers: { authorization: `Bearer ${token.json().secret}` },
      })
    ).statusCode,
  ).toBe(403);
  const saved = await app.inject({
    method: "PUT",
    url: "/api/settings/smtp",
    headers,
    payload: input,
  });
  expect(saved.statusCode).toBe(200);
  const revision = saved.json().revision as string;
  expect(saved.body).not.toContain(input.password);
  expect(db.getSetting("smtp.configuration")).not.toContain(input.password);
  expect(saved.json().verified).toBe(false);
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/settings/smtp/apply",
        headers,
        payload: { revision },
      })
    ).json().code,
  ).toBe("SMTP_NOT_VERIFIED");
  const verified = await app.inject({
    method: "POST",
    url: "/api/settings/smtp/verify",
    headers,
    payload: { revision },
  });
  expect(verified.json().verified).toBe(true);
  expect(transport.sendMail).not.toHaveBeenCalled();
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/settings/smtp/test-email",
        headers,
        payload: { revision, to: "other@example.com" },
      })
    ).statusCode,
  ).toBe(400);
  const sent = await app.inject({
    method: "POST",
    url: "/api/settings/smtp/test-email",
    headers,
    payload: { revision },
  });
  expect(sent.json()).toEqual({ accepted: true });
  expect(transport.sendMail.mock.calls[0]?.[0]).toMatchObject({
    to: "admin@example.com",
    from: { address: input.fromEmail },
  });
  const status = await app.inject({ url: "/api/settings/smtp", headers });
  expect(status.body).not.toContain(input.password);
  expect(status.headers["cache-control"]).toBe("no-store");
});
it("rejects stale verification, unsafe transport settings and retaining a password for a changed server", async () => {
  const { app, headers, transport } = await fixture();
  expect(
    (
      await app.inject({
        method: "PUT",
        url: "/api/settings/smtp",
        headers,
        payload: { ...input, port: 587 },
      })
    ).statusCode,
  ).toBe(400);
  const saved = await app.inject({
    method: "PUT",
    url: "/api/settings/smtp",
    headers,
    payload: input,
  });
  const revision = saved.json().revision as string;
  let finish!: () => void;
  let started!: () => void;
  const beginning = new Promise<void>((resolve) => {
    started = resolve;
  });
  transport.verify.mockImplementationOnce(() => {
    started();
    return new Promise<boolean>((resolve) => {
      finish = () => resolve(true);
    });
  });
  const verifying = app.inject({
    method: "POST",
    url: "/api/settings/smtp/verify",
    headers,
    payload: { revision },
  });
  await beginning;
  const next = await app.inject({
    method: "PUT",
    url: "/api/settings/smtp",
    headers,
    payload: { ...input, expectedRevision: revision, fromName: "Changed" },
  });
  finish();
  expect((await verifying).statusCode).toBe(409);
  expect(next.json().verified).toBe(false);
  expect(
    (
      await app.inject({
        method: "PUT",
        url: "/api/settings/smtp",
        headers,
        payload: {
          ...input,
          password: undefined,
          host: "smtp.zeptomail.com",
          user: "emailapikey",
          expectedRevision: next.json().revision,
        },
      })
    ).json().code,
  ).toBe("SMTP_PASSWORD_REQUIRED");
  transport.verify.mockRejectedValueOnce(
    Object.assign(new Error("server echoed fake-smtp-credential"), {
      code: "EAUTH",
    }),
  );
  const failed = await app.inject({
    method: "POST",
    url: "/api/settings/smtp/verify",
    headers,
    payload: { revision: next.json().revision },
  });
  expect(failed.json().code).toBe("SMTP_AUTH_FAILED");
  expect(failed.body).not.toContain(input.password);
});
it("applies global settings atomically, preserves custom SMTP and updates stopped instances without starting them", async () => {
  const { app, db, config, headers } = await fixture();
  const store = new SupabaseStore(db);
  const create = (
    name: string,
    settings: SupabaseSettings,
    status: "running" | "stopped",
  ) => {
    const id = newId("sb"),
      now = new Date().toISOString();
    const secrets = createSupabaseSecrets("own-credential");
    store.create({
      id,
      name,
      version: "self-hosted/v0.8.3",
      api_hostname: `api-${name}.example.com`,
      studio_hostname: `studio-${name}.example.com`,
      settings_json: JSON.stringify(settings),
      encrypted_secrets: encryptString(
        JSON.stringify(secrets),
        config.APP_SECRET,
      ),
      generation: newId("gen"),
      status: "queued",
      database_port: null,
      error: null,
      created_at: now,
      updated_at: now,
    });
    store.finish(store.claim()!);
    store.update(id, { status });
    return id;
  };
  const stopped = create(
    "stopped",
    {
      siteUrl: "https://app.example.com",
      redirectUrls: [],
      smtpSource: "global",
      smtpAppliedRevision: null,
    },
    "stopped",
  );
  const custom = create(
    "custom",
    {
      siteUrl: "https://app.example.com",
      redirectUrls: [],
      smtp: {
        host: "own.example.com",
        port: 587,
        user: "own",
        sender: "Own",
        adminEmail: "own@example.com",
      },
    },
    "running",
  );
  const original = store.get(custom).encrypted_secrets;
  const saved = await app.inject({
    method: "PUT",
    url: "/api/settings/smtp",
    headers,
    payload: input,
  });
  const revision = saved.json().revision as string;
  await app.inject({
    method: "POST",
    url: "/api/settings/smtp/verify",
    headers,
    payload: { revision },
  });
  const applied = await app.inject({
    method: "POST",
    url: "/api/settings/smtp/apply",
    headers,
    payload: { revision },
  });
  expect(applied.statusCode).toBe(202);
  expect(applied.json().queued).toHaveLength(1);
  expect(store.get(custom).encrypted_secrets).toBe(original);
  const desired = store.get(stopped);
  expect(JSON.parse(desired.settings_json)).toMatchObject({
    smtpPending: true,
    smtp: { host: input.host, port: 465 },
  });
  expect(
    JSON.parse(decryptString(desired.encrypted_secrets, config.APP_SECRET))
      .smtpPassword,
  ).toBe(input.password);
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/settings/smtp/apply",
        headers,
        payload: { revision },
      })
    ).statusCode,
  ).toBe(409);
  const calls: string[][] = [];
  const worker = new SupabaseWorker(config, db, async (_command, args) => {
    calls.push(args);
    return {
      stdout: "",
      stderr: "Error response from daemon: No such container",
      exitCode: 1,
    };
  });
  expect(await worker.processNext()).toBe(true);
  expect(store.get(stopped).status).toBe("stopped");
  expect(JSON.parse(store.get(stopped).settings_json)).toMatchObject({
    smtpPending: false,
    smtpAppliedRevision: revision,
  });
  expect(
    calls.every((args) => args[0] === "container" && args[1] === "inspect"),
  ).toBe(true);
  const disabled = await app.inject({
    method: "PUT",
    url: "/api/settings/smtp",
    headers,
    payload: {
      ...input,
      expectedRevision: revision,
      enabled: false,
      password: undefined,
    },
  });
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/settings/smtp/apply",
        headers,
        payload: { revision: disabled.json().revision },
      })
    ).statusCode,
  ).toBe(202);
  expect(JSON.parse(store.get(stopped).settings_json).smtp).toBeUndefined();
  expect(
    JSON.parse(
      decryptString(store.get(stopped).encrypted_secrets, config.APP_SECRET),
    ).smtpPassword,
  ).toBe("");
});

async function instanceFixture() {
  const context = await fixture();
  const { db, config } = context;
  const store = new SupabaseStore(db);
  const id = newId("sb"),
    now = new Date().toISOString();
  store.create({
    id,
    name: "Own email",
    version: "self-hosted/v0.8.3",
    api_hostname: "own-api.example.com",
    studio_hostname: "own-studio.example.com",
    settings_json: JSON.stringify({
      siteUrl: "https://app.example.com",
      redirectUrls: [],
      smtpSource: "global",
    }),
    encrypted_secrets: encryptString(
      JSON.stringify(createSupabaseSecrets("global-password")),
      config.APP_SECRET,
    ),
    generation: newId("gen"),
    status: "queued",
    database_port: null,
    error: null,
    created_at: now,
    updated_at: now,
  });
  store.finish(store.claim()!);
  store.update(id, { status: "stopped" });
  return { ...context, store, id };
}

it("verifies isolated instance overrides and preserves matching credentials", async () => {
  const context = await instanceFixture();
  const { app, config, headers, transport, store, id } = context;
  const url = `/api/supabase/${id}/smtp`;
  const custom = {
    host: "own.example.com",
    port: 465,
    user: "own",
    fromEmail: "own@example.com",
    fromName: "Own app",
  };
  const update = (smtp: object) =>
    app.inject({
      method: "PUT",
      url,
      headers,
      payload: { source: "custom", smtp },
    });
  expect((await update(custom)).json().code).toBe("SMTP_PASSWORD_REQUIRED");
  transport.verify.mockRejectedValueOnce(
    Object.assign(new Error("provider-secret"), { code: "EAUTH" }),
  );
  const failed = await update({ ...custom, password: "own-password" });
  expect(failed.json().code).toBe("SMTP_AUTH_FAILED");
  expect(failed.body).not.toContain("provider-secret");
  expect(store.jobs(id).filter((job) => job.status === "queued")).toHaveLength(
    0,
  );
  expect(
    (await update({ ...custom, password: "own-password" })).statusCode,
  ).toBe(202);
  expect(transport.sendMail).not.toHaveBeenCalled();
  const stored = store.get(id);
  expect(stored.encrypted_secrets).not.toContain("own-password");
  expect(JSON.parse(stored.settings_json)).toMatchObject({
    smtpSource: "custom",
    smtp: { host: custom.host, adminEmail: custom.fromEmail },
  });
  expect(
    JSON.parse(decryptString(stored.encrypted_secrets, config.APP_SECRET))
      .smtpPassword,
  ).toBe("own-password");
  store.finish(store.claim()!);
  expect((await update({ ...custom, fromName: "Updated" })).statusCode).toBe(
    202,
  );
  expect(
    JSON.parse(
      decryptString(store.get(id).encrypted_secrets, config.APP_SECRET),
    ).smtpPassword,
  ).toBe("own-password");
  store.finish(store.claim()!);
  expect(
    (await update({ ...custom, host: "other.example.com" })).json().code,
  ).toBe("SMTP_PASSWORD_REQUIRED");
  // A global edit must neither switch this instance nor replace its credential.
  const before = store.get(id).encrypted_secrets;
  const saved = await app.inject({
    method: "PUT",
    url: "/api/settings/smtp",
    headers,
    payload: input,
  });
  const revision = saved.json().revision;
  await app.inject({
    method: "POST",
    url: "/api/settings/smtp/verify",
    headers,
    payload: { revision },
  });
  const applied = await app.inject({
    method: "POST",
    url: "/api/settings/smtp/apply",
    headers,
    payload: { revision },
  });
  expect(applied.json()).toEqual({ queued: [] });
  expect(store.get(id).encrypted_secrets).toBe(before);
});

it("rejects an instance change made while SMTP credentials are being verified", async () => {
  const { app, headers, transport, store, id } = await instanceFixture();
  const before = store.get(id).encrypted_secrets;
  transport.verify.mockImplementationOnce(async () => {
    store.update(id, { status: "running" });
    return true;
  });
  const response = await app.inject({
    method: "PUT",
    url: `/api/supabase/${id}/smtp`,
    headers,
    payload: {
      source: "custom",
      smtp: {
        host: input.host,
        port: input.port,
        user: input.user,
        fromEmail: input.fromEmail,
        fromName: input.fromName,
        password: input.password,
      },
    },
  });
  expect(response.json().code).toBe("SMTP_CHANGED");
  expect(store.get(id).encrypted_secrets).toBe(before);
});

it("rejects an untrusted certificate over a real TLS connection", async () => {
  const { app, config, headers } = await fixture();
  vi.mocked(nodemailer.createTransport).mockRestore();
  const keyPath = path.join(config.DATA_DIR, "local-test-key.pem");
  const certPath = path.join(config.DATA_DIR, "local-test-cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-subj",
      "/CN=smtp.resend.com",
      "-days",
      "1",
    ],
    { stdio: "ignore" },
  );
  let authenticatedConnections = 0;
  const server = tls.createServer(
    { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) },
    (socket) => {
      authenticatedConnections++;
      socket.end("421 fixture closing\r\n");
    },
  );
  server.on("tlsClientError", () => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing test port");
  const connect = tls.connect;
  // Redirect only the network destination. The production certificate-verification options stay intact.
  vi.spyOn(tls, "connect").mockImplementation(((
    options: tls.ConnectionOptions,
    callback?: () => void,
  ) =>
    connect(
      { ...options, host: "127.0.0.1", port: address.port },
      callback,
    )) as typeof tls.connect);
  try {
    const saved = await app.inject({
      method: "PUT",
      url: "/api/settings/smtp",
      headers,
      payload: input,
    });
    const result = await app.inject({
      method: "POST",
      url: "/api/settings/smtp/verify",
      headers,
      payload: { revision: saved.json().revision },
    });
    expect(result.json().code).toBe("SMTP_TLS_FAILED");
    expect(authenticatedConnections).toBe(0);
    expect(
      (await app.inject({ url: "/api/settings/smtp", headers })).json()
        .verified,
    ).toBe(false);
  } finally {
    vi.mocked(tls.connect).mockRestore();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it("upgrades legacy backup metadata additively and remains repeatable", async () => {
  const { app, db, config, store, id } = await instanceFixture();
  const backupId = newId("sbb");
  const row = store.get(id);
  store.addBackup({
    id: backupId,
    instance_id: id,
    version: row.version,
    generation: row.generation,
    status: "ready",
    encrypted_secrets: row.encrypted_secrets,
    size_bytes: 42,
    sha256: "fixture",
    created_at: new Date().toISOString(),
  });
  db.sqlite.exec("ALTER TABLE supabase_backups DROP COLUMN settings_json");
  apps.splice(apps.indexOf(app), 1);
  await app.close();
  for (let count = 0; count < 2; count++) {
    const upgraded = new Database(config);
    try {
      const backups = new SupabaseStore(upgraded).backups(id);
      expect(backups).toHaveLength(1);
      expect(backups[0]).toMatchObject({
        id: backupId,
        size_bytes: 42,
        settings_json: null,
        encrypted_secrets: row.encrypted_secrets,
      });
    } finally {
      upgraded.close();
    }
  }
});
