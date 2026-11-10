import { supabaseReadiness } from "../services/supabase-readiness.js";
import { registerSupabaseWorkspaceRoutes } from "./supabase-workspace.js";
import {
  SupabaseConnections,
  SupabaseConnectionInput,
  SupabaseSiteUrl,
} from "../services/supabase-connections.js";
import { SmtpService, InstanceSmtpInput } from "../services/smtp.js";
import { withGlobalSmtp } from "../services/supabase-mail.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { Database } from "../lib/database.js";
import { badRequest, conflict } from "../lib/errors.js";
import {
  decryptString,
  encryptString,
  newId,
  normalizeHostname,
  verifyPassword,
} from "../lib/security.js";
import {
  requireScopedAuth,
  requireScopedMutation,
  requireSessionMutationAuth,
  sessionAuthentication,
} from "../services/auth.js";
import { CloudflareService } from "../services/cloudflare.js";
import { panelHostnames } from "../services/panel-domains.js";
import {
  SupabaseStore,
  presentSupabase,
  type SupabaseInstance,
  type SupabaseSettings,
} from "../services/supabase-store.js";
import {
  createSupabaseSecrets,
  SUPABASE_VERSION,
  type SupabaseSecrets,
} from "../services/supabase-template.js";

const line = z
  .string()
  .max(512)
  .refine((value) => !/[\r\n\0]/.test(value));
const httpsUrl = SupabaseSiteUrl;
const params = z.object({ id: z.string().regex(/^sb_[a-f0-9]{32}$/) });
const createSchema = z
  .object({
    name: line.min(2).max(80),
    apiHostname: z.string().min(1).max(253),
    studioHostname: z.string().min(1).max(253),
    siteUrl: httpsUrl.optional(),
    connection: SupabaseConnectionInput.optional(),
    redirectUrls: z.array(httpsUrl).max(20).default([]),
    smtpSource: z.enum(["global", "custom", "disabled"]).optional(),
    smtp: z
      .object({
        host: InstanceSmtpInput.shape.host,
        port: InstanceSmtpInput.shape.port,
        user: InstanceSmtpInput.shape.user,
        sender: InstanceSmtpInput.shape.fromName,
        adminEmail: InstanceSmtpInput.shape.fromEmail,
        password: InstanceSmtpInput.shape.password.unwrap(),
      })
      .strict()
      .optional(),
  })
  .strict();

export function registerSupabaseRoutes(
  app: FastifyInstance,
  config: AppConfig,
  db: Database,
) {
  const store = new SupabaseStore(db);
  const cloudflare = new CloudflareService(config, db);
  const connections = new SupabaseConnections(config, db);
  registerSupabaseWorkspaceRoutes(app, config, db);
  app.get("/api/supabase/readiness", { preHandler: requireScopedAuth("projects:read") }, async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return supabaseReadiness(db);
  });
  app.get(
    "/api/supabase",
    { preHandler: requireScopedAuth("projects:read") },
    async (_request, reply) => {
      reply.header("cache-control", "no-store");
      return {
        instances: store.list().map((row) => presentSupabase(row, store)),
      };
    },
  );
  app.get(
    "/api/supabase/connections",
    { preHandler: requireScopedAuth("projects:read") },
    async (_request, reply) => {
      reply.header("cache-control", "no-store");
      return {
        connections: connections.list(),
        projects: connections.options(),
      };
    },
  );
  app.delete(
    "/api/supabase/:id/connections/:projectId",
    {
      preHandler: [
        requireScopedMutation("environment:write"),
        requireScopedAuth("projects:write"),
      ],
    },
    async (request, reply) => {
      const input = z
        .object({ id: params.shape.id, projectId: z.string().min(1).max(128) })
        .parse(request.params);
      reply.header("cache-control", "no-store");
      return connections.disconnect(input.id, input.projectId);
    },
  );
  app.get(
    "/api/supabase/:id",
    { preHandler: requireScopedAuth("projects:read") },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      return {
        instance: presentSupabase(
          store.get(params.parse(request.params).id),
          store,
        ),
      };
    },
  );
  app.post(
    "/api/supabase",
    {
      preHandler: [
        requireScopedMutation("projects:write"),
        requireScopedAuth("domains:write"),
      ],
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const input = createSchema.parse(request.body);
      if (input.connection) {
        await requireScopedAuth("environment:write")(request, reply);
        if (reply.sent) return;
      }
      const siteUrl =
        input.siteUrl ??
        (input.connection
          ? connections
              .options()
              .find((project) => project.id === input.connection!.projectId)
              ?.website
          : null);
      if (!siteUrl)
        throw badRequest("Choose the app website", "SITE_URL_REQUIRED");
      const checkedSiteUrl = httpsUrl.parse(siteUrl);
      const api = normalizeHostname(input.apiHostname),
        studio = normalizeHostname(input.studioHostname);
      if (api === studio)
        throw badRequest(
          "API and Studio need different hostnames",
          "HOSTNAME_COLLISION",
        );
      for (const host of [api, studio]) {
        if (panelHostnames(db).includes(host))
          throw conflict("The panel hostname is reserved", "DOMAIN_EXISTS");
        const available = await cloudflare.checkHostname(host);
        if (!available.availability)
          throw conflict("Hostname is unavailable", "DOMAIN_EXISTS");
      }
      if (!db.getSetting("cloudflare.tunnel_id"))
        throw conflict(
          "Configure the Cloudflare tunnel first",
          "TUNNEL_NOT_CONFIGURED",
        );
      if (supabaseReadiness(db).status === "blocked") throw conflict("Server setup or capacity needs attention", "SUPABASE_PREFLIGHT_BLOCKED");
      const source = input.smtpSource ?? (input.smtp ? "custom" : "global");
      if (source === "custom" && !input.smtp)
        throw badRequest(
          "Custom SMTP credentials are required",
          "SMTP_PASSWORD_REQUIRED",
        );
      if (source !== "custom" && input.smtp)
        throw badRequest("SMTP credentials require custom mode", "VALIDATION");
      const { password, ...smtp } = input.smtp ?? { password: undefined };
      let settings: SupabaseSettings = {
        functionsEnabled: true,
        siteUrl: checkedSiteUrl,
        redirectUrls: input.redirectUrls,
        smtpSource: source,
        ...(source === "custom"
          ? { smtp: smtp as NonNullable<SupabaseSettings["smtp"]> }
          : {}),
      };
      let smtpPassword = password;
      if (source === "global") {
        const global = new SmtpService(config, db).snapshot();
        settings = withGlobalSmtp(settings, global);
        settings.smtpAppliedRevision = settings.smtpRevision ?? null;
        smtpPassword = global?.enabled ? global.password : undefined;
      }
      if (source === "custom" && input.smtp) {
        await new SmtpService(config, db).verifyConnection(input.smtp);
      }
      const secrets = createSupabaseSecrets(smtpPassword);
      const now = new Date().toISOString();
      const instance: SupabaseInstance = {
        id: newId("sb"),
        name: input.name,
        version: SUPABASE_VERSION,
        api_hostname: api,
        studio_hostname: studio,
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
      };
      const job = db.sqlite
        .transaction(() => {
          const job = store.create(instance);
          if (input.connection)
            connections.reserve(instance.id, {
              ...input.connection,
              siteUrl: checkedSiteUrl,
            });
          return job;
        })
        .immediate();
      reply.header("cache-control", "no-store");
      return reply
        .code(202)
        .send({ instance: presentSupabase(instance, store), jobId: job.id });
    },
  );
  app.post(
    "/api/supabase/:id/actions",
    { preHandler: requireScopedMutation("deployments:write") },
    async (request, reply) => {
      const { id } = params.parse(request.params);
      const input = z
        .object({
          action: z.enum([
            "start",
            "stop",
            "backup",
            "restore",
            "rotate",
            "rotate-keys",
            "archive",
          ]),
          backupId: z
            .string()
            .regex(/^sbb_[a-f0-9]{32}$/)
            .optional(),
          confirmation: z.string().max(80).optional(),
        })
        .strict()
        .parse(request.body);
      const instance = store.get(id);
      if (
        ["restore", "archive", "rotate-keys"].includes(input.action) &&
        input.confirmation !== instance.name
      )
        throw badRequest("Confirm the instance name", "CONFIRMATION_REQUIRED");
      const job = store.enqueue(id, input.action, input.backupId);
      return reply.code(202).send({ jobId: job.id });
    },
  );
  app.post(
    "/api/supabase/:id/credentials",
    {
      preHandler: requireSessionMutationAuth,
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const { currentPassword } = z
        .object({ currentPassword: z.string().min(1).max(1024) })
        .strict()
        .parse(request.body);
      if (
        !(await verifyPassword(
          currentPassword,
          sessionAuthentication(request).user.password_hash,
        ))
      )
        throw badRequest(
          "The current password is incorrect",
          "CURRENT_PASSWORD_INVALID",
        );
      const instance = store.get(params.parse(request.params).id);
      if (
        store
          .jobs(instance.id)
          .some((job) => ["queued", "running"].includes(job.status))
      )
        throw conflict(
          "Wait for the current operation before revealing credentials",
          "INSTANCE_BUSY",
        );
      const secrets = JSON.parse(
        decryptString(instance.encrypted_secrets, config.APP_SECRET),
      ) as SupabaseSecrets;
      reply.header("cache-control", "no-store").header("pragma", "no-cache");
      return {
        apiUrl: `https://${instance.api_hostname}`,
        anonKey: secrets.anonKey,
        serviceRoleKey: secrets.serviceKey,
        studioUsername: "supabase",
        studioPassword: secrets.studioPassword,
        databaseUser: "postgres",
        databaseName: "postgres",
        databasePassword: secrets.databasePassword,
        databasePort: instance.database_port,
      };
    },
  );
  app.post(
    "/api/supabase/:id/connections",
    {
      preHandler: [
        requireScopedMutation("environment:write"),
        requireScopedAuth("projects:write"),
        requireScopedAuth("deployments:write"),
      ],
    },
    async (request, reply) => {
      const input = SupabaseConnectionInput.parse(request.body);
      reply.header("cache-control", "no-store");
      const connection = connections.connect(
        params.parse(request.params).id,
        input,
      );
      return {
        connection,
        environmentKeys: [connection.urlVariable, connection.keyVariable],
        redeployRequired: connection.status !== "ready",
      };
    },
  );
}
