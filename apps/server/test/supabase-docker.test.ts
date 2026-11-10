import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { runCommand } from "../src/lib/command.js";
import type { SupabaseInstance } from "../src/services/supabase-store.js";
import {
  createSupabaseSecrets,
  supabaseNames,
  type SupabaseSecrets,
} from "../src/services/supabase-template.js";
import { SupabaseRuntime } from "../src/services/supabase-runtime.js";
import {
  encryptSupabaseBackup,
  decryptSupabaseBackup,
} from "../src/services/supabase-backup.js";

const nodeImage =
  "node:26-alpine@sha256:e88a35be04478413b7c71c455cd9865de9b9360e1f43456be5951032d7ac1a66";
// Opt-in: real nine-container stack, network isolation and data restore; never touches provider resources.
it.runIf(process.env.SHELTER_TEST_SUPABASE_DOCKER === "1")(
  "protects Studio and administrative APIs, enforces RLS, and restores persistent data with real Docker",
  async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "shelter-supabase-docker-"),
    );
    const config = loadConfig({
      NODE_ENV: "test",
      DATA_DIR: directory,
      APP_SECRET: randomBytes(32).toString("hex"),
    });
    const instance: SupabaseInstance = {
      id: `sb_${randomBytes(16).toString("hex")}`,
      generation: `gen_${randomBytes(16).toString("hex")}`,
      name: "Disposable integration",
      version: "self-hosted/v0.8.3",
      api_hostname: "api.integration.invalid",
      studio_hostname: "studio.integration.invalid",
      settings_json: JSON.stringify({
        functionsEnabled: true,
        siteUrl: "https://app.integration.invalid",
        redirectUrls: [],
        // Confirmed administrator-created users do not send mail; this enables the email provider for the revocation test.
        smtp: {
          host: "mail.example.invalid",
          port: 587,
          user: "fixture",
          sender: "Fixture",
          adminEmail: "sender@example.invalid",
        },
      }),
      encrypted_secrets: "",
      status: "queued",
      database_port: null,
      error: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const secrets = createSupabaseSecrets();
    const runtime = new SupabaseRuntime(config);
    const restored = {
      ...instance,
      generation: `gen_${randomBytes(16).toString("hex")}`,
    };
    const names = supabaseNames(instance);
    const docker = (args: string[]) =>
      runCommand("docker", args, {
        timeoutMs: 120_000,
        maxOutputChars: 100_000,
      });
    async function request(
      host: string,
      requestPath: string,
      extra: {
        key?: string;
        basic?: boolean;
        origin?: string;
        basicPassword?: string;
        method?: string;
        body?: string;
        websocket?: boolean;
      } = {},
    ) {
      const env = path.join(directory, "request.env");
      fs.writeFileSync(
        env,
        [
          `TARGET=${names.container("api-gw")}`,
          `REQUEST_HOST=${host}`,
          `REQUEST_PATH=${requestPath}`,
          `APIKEY=${extra.key ?? ""}`,
          `AUTHORIZATION=${extra.basic ? `Basic ${Buffer.from(`supabase:${extra.basicPassword ?? secrets.studioPassword}`).toString("base64")}` : extra.key ? `Bearer ${extra.key}` : ""}`,
          `METHOD=${extra.method ?? "GET"}`,
          `BODY=${extra.body ?? ""}`,
          `WEBSOCKET=${extra.websocket ? "1" : ""}`,
          `ORIGIN=${extra.origin ?? ""}`,
        ].join("\n"),
        { mode: 0o600 },
      );
      const script = `const http=require('http');const e=process.env;const headers={host:e.REQUEST_HOST};if(e.ORIGIN)headers.origin=e.ORIGIN;if(e.APIKEY)headers.apikey=e.APIKEY;if(e.AUTHORIZATION)headers.authorization=e.AUTHORIZATION;if(e.BODY)headers['content-type']='application/json';if(e.WEBSOCKET){Object.assign(headers,{Connection:'Upgrade',Upgrade:'websocket','Sec-WebSocket-Version':'13','Sec-WebSocket-Key':'dGhlIHNhbXBsZSBub25jZQ=='});}const r=http.request({host:e.TARGET,port:8000,path:e.REQUEST_PATH,method:e.METHOD,headers},s=>{let body='';s.on('data',c=>body+=c);s.on('end',()=>console.log(JSON.stringify({status:s.statusCode,body})));});r.on('upgrade',s=>{console.log(JSON.stringify({status:s.statusCode}));s.socket.destroy();});r.on('error',()=>process.exit(2));r.setTimeout(20000,()=>r.destroy());r.end(e.BODY||undefined);`;
      try {
        return JSON.parse(
          (
            await docker([
              "run",
              "--rm",
              "--network",
              names.frontend,
              "--memory",
              "128m",
              "--cpus",
              "0.5",
              "--pids-limit",
              "32",
              "--read-only",
              "--cap-drop",
              "ALL",
              "--security-opt",
              "no-new-privileges:true",
              "--env-file",
              env,
              nodeImage,
              "node",
              "-e",
              script,
            ])
          ).stdout,
        ) as { status: number; body: string };
      } finally {
        fs.rmSync(env, { force: true });
      }
    }
    async function sql(query: string) {
      return docker([
        "exec",
        names.container("db"),
        "psql",
        "-U",
        "postgres",
        "-d",
        "postgres",
        "-v",
        "ON_ERROR_STOP=1",
        "-tAc",
        query,
      ]);
    }
    try {
      await docker(["pull", nodeImage]);
      const port = await runtime.start(instance, secrets, false);
      expect(port).toBeGreaterThan(0);
      for (const service of [
        "db",
        "auth",
        "rest",
        "realtime",
        "imgproxy",
        "storage",
        "meta",
        "studio",
        "api-gw",
      ] as const) {
        const inspection = JSON.parse(
          (await docker(["inspect", names.container(service)])).stdout,
        )[0];
        const ports = Object.values(inspection.NetworkSettings.Ports ?? {})
          .flat()
          .filter(Boolean) as { HostIp: string }[];
        expect(
          ports.every(
            (binding) => service === "db" && binding.HostIp === "127.0.0.1",
          ),
        ).toBe(true);
        expect(inspection.HostConfig.Privileged).toBe(false);
        expect(
          inspection.Mounts.some((mount: { Source: string }) =>
            mount.Source.endsWith("docker.sock"),
          ),
        ).toBe(false);
      }
      const beforeSmtp = JSON.parse(
        (
          await docker([
            "inspect",
            names.container("db"),
            names.container("auth"),
            names.container("rest"),
          ])
        ).stdout,
      ) as { Id: string }[];
      const settings = JSON.parse(instance.settings_json);
      settings.smtp.port = 465;
      settings.smtp.sender = "Updated sender";
      instance.settings_json = JSON.stringify(settings);
      // Recreate the only service that owns SMTP configuration; the database and REST service retain their containers.
      await runtime.removeAuth(instance);
      await runtime.start(instance, secrets, false);
      const afterSmtp = JSON.parse(
        (
          await docker([
            "inspect",
            names.container("db"),
            names.container("auth"),
            names.container("rest"),
          ])
        ).stdout,
      ) as { Id: string; Config: { Env: string[] } }[];
      expect(afterSmtp[0]!.Id).toBe(beforeSmtp[0]!.Id);
      expect(afterSmtp[2]!.Id).toBe(beforeSmtp[2]!.Id);
      expect(afterSmtp[1]!.Id).not.toBe(beforeSmtp[1]!.Id);
      expect(afterSmtp[1]!.Config.Env).toContain("GOTRUE_SMTP_PORT=465");
      expect(afterSmtp[1]!.Config.Env).toContain(
        "GOTRUE_SMTP_SENDER_NAME=Updated sender",
      );
      expect(
        (await request(instance.studio_hostname, "/api/platform/profile"))
          .status,
      ).toBe(401);
      expect(
        (
          await request(instance.studio_hostname, "/api/platform/profile", {
            key: secrets.serviceKey,
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await request(instance.studio_hostname, "/api/platform/profile", {
            basic: true,
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await request(instance.studio_hostname, "/api/platform/profile", {
            basic: true,
            method: "POST",
            body: "{}",
          })
        ).status,
      ).toBe(403);
      const query = await request(
        instance.studio_hostname,
        "/api/platform/pg-meta/default/query",
        {
          basic: true,
          origin: `https://${instance.studio_hostname}`,
          method: "POST",
          body: '{"query":"SELECT 42 AS studio_probe"}',
        },
      );
      expect(query.status).toBe(200);
      expect(query.body).toContain("studio_probe");
      const candidateJob = `sbj_${randomBytes(16).toString("hex")}`;
      await runtime.validateFunction(
        instance,
        'Deno.serve(()=>Response.json({message:"valid"}));',
        candidateJob,
        secrets,
      );
      await expect(
        runtime.validateFunction(
          instance,
          "Deno.serve(() => { invalid syntax",
          `sbj_${randomBytes(16).toString("hex")}`,
          secrets,
        ),
      ).rejects.toThrow("FUNCTION_VALIDATION_FAILED");
      await runtime.writeFunction(
        instance,
        "shelter-probe",
        'Deno.serve(() => Response.json({message:"function-retained"}));',
        `sbj_${randomBytes(16).toString("hex")}`,
      );
      const functionResult = await request(
        instance.api_hostname,
        "/functions/v1/shelter-probe",
        { key: secrets.anonKey },
      );
      expect(functionResult.status).toBe(200);
      expect(functionResult.body).toContain("function-retained");
      expect(
        (await runtime.functionFiles(instance)).get("shelter-probe"),
      ).toContain("function-retained");
      const functionProbe = await runtime.request(instance, {
        url: "http://functions:9000/shelter-probe",
        token: secrets.anonKey,
      });
      expect(functionProbe.status).toBe(200);
      expect(functionProbe.body).toContain("function-retained");
      expect(
        (
          await runtime.request(instance, {
            url: "http://functions:9000/__shelter_validate",
            token: secrets.anonKey,
            method: "POST",
            validation: candidateJob,
          })
        ).status,
      ).toBe(403);

      expect(
        (await request(instance.api_hostname, "/functions/v1/shelter-probe"))
          .status,
      ).toBe(401);
      expect(
        (
          await request(instance.api_hostname, "/functions/v1/shelter-probe", {
            key: secrets.anonKey.slice(0, -5) + "wrong",
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await request(instance.api_hostname, "/functions/v1/main", {
            key: secrets.anonKey,
          })
        ).status,
      ).toBe(404);
      for (const route of [
        "/",
        "/pg/health",
        "/api/platform/profile",
        "/mcp",
        "/realtime/v1/api/tenants",
        "//pg/health",
        "/rest/v1/../../pg/health",
        "/rest/v1/%2e%2e/%2e%2e/pg/health",
        "/rest/v1/%2f..%2fpg/health",
      ]) {
        const result = await request(instance.api_hostname, route, {
          key: secrets.serviceKey,
        });
        expect([400, 403, 404], route).toContain(result.status);
      }
      expect(
        (
          await request("unassigned.invalid", "/rest/v1/", {
            key: secrets.serviceKey,
          })
        ).status,
      ).toBe(404);
      expect(
        (await request(instance.api_hostname, "/auth/v1/health")).status,
      ).toBe(401);
      expect(
        (
          await request(instance.api_hostname, "/auth/v1/health", {
            key: secrets.anonKey,
          })
        ).status,
      ).toBe(200);
      await sql(
        "CREATE TABLE public.shelter_probe(id integer PRIMARY KEY, value text); INSERT INTO public.shelter_probe VALUES(1,'retained'); ALTER TABLE public.shelter_probe ENABLE ROW LEVEL SECURITY; GRANT SELECT ON public.shelter_probe TO anon; NOTIFY pgrst, 'reload schema';",
      );
      // Schema reload is asynchronous. Establish table visibility before testing RLS denial.
      let probe = await request(
        instance.api_hostname,
        "/rest/v1/shelter_probe",
        { key: secrets.serviceKey },
      );
      for (
        let attempt = 0;
        attempt < 10 &&
        probe.status === 404 &&
        probe.body.includes('"PGRST205"');
        attempt++
      ) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        probe = await request(instance.api_hostname, "/rest/v1/shelter_probe", {
          key: secrets.serviceKey,
        });
      }
      expect(probe.status).toBe(200);
      expect(probe.body).toContain("retained");
      expect(
        (
          await request(instance.api_hostname, "/rest/v1/shelter_probe", {
            key: secrets.anonKey,
          })
        ).body,
      ).toBe("[]");

      await sql(
        "CREATE POLICY public_read ON public.shelter_probe FOR SELECT TO anon USING (true);",
      );
      expect(
        (
          await request(instance.api_hostname, "/rest/v1/shelter_probe", {
            key: secrets.anonKey,
          })
        ).body,
      ).toContain("retained");
      const ws = await request(
        instance.api_hostname,
        `/realtime/v1/websocket?apikey=${secrets.anonKey}&vsn=1.0.0`,
        { websocket: true },
      );
      expect(ws.status).toBe(101);
      expect(
        (
          await request(instance.api_hostname, "/storage/v1/bucket", {
            key: secrets.serviceKey,
            method: "POST",
            body: '{"id":"probe","name":"probe","public":false}',
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await request(
            instance.api_hostname,
            "/storage/v1/object/probe/retained.json",
            {
              key: secrets.serviceKey,
              method: "POST",
              body: '{"stored":"retained-object"}',
            },
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await request(
            instance.api_hostname,
            "/storage/v1/object/probe/retained.json",
            { key: secrets.serviceKey },
          )
        ).body,
      ).toContain("retained-object");
      expect(
        (
          await request(instance.api_hostname, "/auth/v1/admin/users", {
            key: secrets.serviceKey,
            method: "POST",
            body: '{"email":"probe@example.invalid","password":"disposable-test-password","email_confirm":true}',
          })
        ).status,
      ).toBe(200);
      const session = await request(
        instance.api_hostname,
        "/auth/v1/token?grant_type=password",
        {
          key: secrets.anonKey,
          method: "POST",
          body: '{"email":"probe@example.invalid","password":"disposable-test-password"}',
        },
      );
      expect(session.status).toBe(200);
      const refreshToken = (
        JSON.parse(session.body) as { refresh_token: string }
      ).refresh_token;
      await runtime.revokeSessions(instance);
      const oldKey = secrets.serviceKey;
      const replacement = createSupabaseSecrets();
      secrets.jwtSecret = replacement.jwtSecret;
      secrets.anonKey = replacement.anonKey;
      secrets.serviceKey = replacement.serviceKey;
      await runtime.stop(instance, true);
      await runtime.start(instance, secrets, false);
      expect([401, 403]).toContain(
        (
          await request(instance.api_hostname, "/rest/v1/shelter_probe", {
            key: oldKey,
          })
        ).status,
      );
      expect(
        (
          await request(instance.api_hostname, "/rest/v1/shelter_probe", {
            key: secrets.serviceKey,
          })
        ).body,
      ).toContain("retained");
      expect(
        (
          await request(
            instance.api_hostname,
            "/auth/v1/token?grant_type=refresh_token",
            {
              key: secrets.anonKey,
              method: "POST",
              body: JSON.stringify({ refresh_token: refreshToken }),
            },
          )
        ).status,
      ).toBe(400);
      const oldPassword = secrets.studioPassword;
      secrets.studioPassword = randomBytes(24).toString("hex");
      await runtime.removeGateway(instance);
      await runtime.start(instance, secrets, false);
      expect(
        (
          await request(instance.studio_hostname, "/api/platform/profile", {
            basic: true,
            basicPassword: oldPassword,
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await request(instance.studio_hostname, "/api/platform/profile", {
            basic: true,
          })
        ).status,
      ).toBe(200);
      await runtime.stop(instance);
      const archive = path.join(directory, "snapshot.tgz"),
        encrypted = path.join(directory, "snapshot.enc"),
        plain = path.join(directory, "restored.tgz");
      await runtime.snapshot(instance, archive);
      await encryptSupabaseBackup(
        archive,
        encrypted,
        config.APP_SECRET,
        instance.id,
      );
      await decryptSupabaseBackup(
        encrypted,
        plain,
        config.APP_SECRET,
        instance.id,
      );
      await runtime.stop(instance, true);
      await runtime.snapshot(restored, plain, true);
      await runtime.start(restored, secrets, false);
      expect(
        (
          await request(instance.api_hostname, "/functions/v1/shelter-probe", {
            key: secrets.anonKey,
          })
        ).body,
      ).toContain("function-retained");
      expect(
        (await sql("SELECT value FROM public.shelter_probe WHERE id=1")).stdout,
      ).toBe("retained");
      expect(
        (
          await request(
            instance.api_hostname,
            "/storage/v1/object/probe/retained.json",
            { key: secrets.serviceKey },
          )
        ).body,
      ).toContain("retained-object");
      expect(
        (await request(instance.studio_hostname, "/api/platform/profile"))
          .status,
      ).toBe(401);
      expect(
        (
          await request(instance.api_hostname, "/rest/v1/shelter_probe", {
            key: secrets.anonKey,
          })
        ).body,
      ).toContain("retained");
    } finally {
      await runtime.stop(instance, true);
      await runtime.discardVolumes(instance);
      await runtime.discardVolumes(restored);
      for (const network of [names.frontend, names.backend])
        await docker(["network", "rm", network]);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
  1200_000,
);

it.runIf(process.env.SHELTER_TEST_SUPABASE_DOCKER === "1")(
  "recovers interrupted function uploads and rejects a symlink entrypoint with real Docker",
  async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "shelter-function-recovery-"),
    );
    const config = loadConfig({
      NODE_ENV: "test",
      DATA_DIR: directory,
      APP_SECRET: randomBytes(32).toString("hex"),
    });
    const instance: SupabaseInstance = {
      id: `sb_${randomBytes(16).toString("hex")}`,
      generation: `gen_${randomBytes(16).toString("hex")}`,
      name: "Recovery",
      version: "self-hosted/v0.8.3",
      api_hostname: "api.invalid",
      studio_hostname: "studio.invalid",
      settings_json: "{}",
      encrypted_secrets: "",
      status: "stopped",
      database_port: null,
      error: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const runtime = new SupabaseRuntime(config),
      volume = supabaseNames(instance).volume("functions"),
      jobId = `sbj_${randomBytes(16).toString("hex")}`;
    const edit = async (script: string) =>
      runCommand("docker", [
        "run",
        "--rm",
        "--network",
        "none",
        "--cap-drop",
        "ALL",
        "--mount",
        `type=volume,source=${volume},target=/functions`,
        "-e",
        `STAGED_NAME=.${jobId}.tmp`,
        nodeImage,
        "node",
        "-e",
        script,
      ]);
    try {
      await runtime.ensureTestNetworks(instance);
      for (const network of [
        supabaseNames(instance).backend,
        supabaseNames(instance).frontend,
      ])
        expect(
          (
            await runCommand("docker", [
              "network",
              "inspect",
              "--format",
              "{{.Internal}}",
              network,
            ])
          ).stdout.trim(),
        ).toBe("true");
      await runtime.ensureVolumes(instance);
      await edit(
        "const fs=require('fs');fs.mkdirSync('/functions/recovery-probe');fs.writeFileSync('/functions/recovery-probe/'+process.env.STAGED_NAME,'incomplete');",
      );
      const source = "Deno.serve(()=>new Response('recovered'));";
      await runtime.writeFunction(instance, "recovery-probe", source, jobId);
      expect(
        (
          await edit(
            "console.log(require('fs').readFileSync('/functions/recovery-probe/index.ts','utf8'))",
          )
        ).stdout,
      ).toBe(source);
      await edit(
        "const fs=require('fs');fs.writeFileSync('/functions/sentinel','untouched');fs.unlinkSync('/functions/recovery-probe/index.ts');fs.symlinkSync('../sentinel','/functions/recovery-probe/index.ts');",
      );
      await expect(
        runtime.writeFunction(
          instance,
          "recovery-probe",
          "replacement",
          `sbj_${randomBytes(16).toString("hex")}`,
        ),
      ).rejects.toThrow();
      expect(
        (
          await edit(
            "console.log(require('fs').readFileSync('/functions/sentinel','utf8'))",
          )
        ).stdout,
      ).toBe("untouched");
    } finally {
      await runtime.discardVolumes(instance);
      await runtime.discardNetworks(instance);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
  60000,
);

it.runIf(process.env.SHELTER_TEST_SUPABASE_DOCKER === "1")(
  "starts an isolated recovery stack without requiring a published database port",
  async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "shelter-isolated-recovery-"),
    );
    const config = loadConfig({
      NODE_ENV: "test",
      DATA_DIR: directory,
      APP_SECRET: randomBytes(32).toString("hex"),
    });
    const instance: SupabaseInstance = {
      id: `sb_${randomBytes(16).toString("hex")}`,
      generation: `gen_${randomBytes(16).toString("hex")}`,
      name: "Isolated recovery",
      version: "self-hosted/v0.8.3",
      api_hostname: "api.recovery.invalid",
      studio_hostname: "studio.recovery.invalid",
      settings_json: JSON.stringify({
        siteUrl: "https://app.recovery.invalid",
        redirectUrls: [],
        functionsEnabled: false,
      }),
      encrypted_secrets: "",
      status: "stopped",
      database_port: null,
      error: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const runtime = new SupabaseRuntime(config),
      secrets = createSupabaseSecrets();
    try {
      await runtime.startIsolated(instance, secrets);
      expect(
        (
          await runtime.request(instance, {
            url: "http://auth:9999/health",
            token: secrets.anonKey,
          })
        ).status,
      ).toBe(200);
      for (const network of [
        supabaseNames(instance).backend,
        supabaseNames(instance).frontend,
      ])
        expect(
          (
            await runCommand("docker", [
              "network",
              "inspect",
              "--format",
              "{{.Internal}}",
              network,
            ])
          ).stdout.trim(),
        ).toBe("true");
      const db = await runtime.inspect(instance, "db");
      expect(
        Object.values(db!.NetworkSettings.Ports).flat().filter(Boolean),
      ).toEqual([]);
    } finally {
      await runtime.stop(instance, true);
      await runtime.discardVolumes(instance);
      await runtime.discardNetworks(instance);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
  300000,
);
