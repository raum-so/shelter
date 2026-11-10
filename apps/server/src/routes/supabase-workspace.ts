import {
  BackupPolicyInput,
  SupabaseBackupPolicy,
} from "../services/supabase-backup-policy.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { Database } from "../lib/database.js";
import {
  requireSessionAuth,
  requireSessionMutationAuth,
} from "../services/auth.js";
import { SupabaseStore } from "../services/supabase-store.js";
import { SupabaseWorkspace } from "../services/supabase-workspace.js";

const name = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,62}$/)
  .refine((n) => n !== "main");
const params = z.object({
  id: z.string().regex(/^sb_[a-f0-9]{32}$/),
  name: name.optional(),
  jobId: z
    .string()
    .regex(/^sbj_[a-f0-9]{32}$/)
    .optional(),
});
const expectedHash = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .nullable()
  .optional();
export function registerSupabaseWorkspaceRoutes(
  app: FastifyInstance,
  config: AppConfig,
  db: Database,
) {
  const workspace = new SupabaseWorkspace(config, db),
    store = new SupabaseStore(db);
  app.addHook("onSend", async (request, reply, payload) => {
    if (request.url.startsWith("/api/supabase/"))
      reply.header("cache-control", "no-store");
    return payload;
  });
  app.get(
    "/api/supabase/:id/functions",
    { preHandler: requireSessionAuth },
    async (request) => {
      const instance = store.get(params.parse(request.params).id);
      return workspace.catalog(instance);
    },
  );
  app.post(
    "/api/supabase/:id/functions/refresh",
    { preHandler: requireSessionMutationAuth },
    async (request, reply) => {
      const { id } = params.parse(request.params);
      return reply
        .code(202)
        .send({ jobId: workspace.enqueue(id, "functions-sync").id });
    },
  );
  app.get(
    "/api/supabase/:id/functions/:name",
    { preHandler: requireSessionAuth },
    async (request) => {
      const input = params.extend({ name }).parse(request.params),
        instance = store.get(input.id);
      const versionId = z
        .object({
          versionId: z
            .string()
            .regex(/^sfv_[a-f0-9]{32}$/)
            .optional(),
        })
        .parse(request.query).versionId;
      const head = workspace.head(instance, input.name);
      const selected = versionId
        ? workspace.version(input.id, input.name, versionId)
        : head;
      return {
        name: input.name,
        source: selected ? workspace.source(selected) : null,
        hash: head?.source_hash ?? null,
        versionId: selected?.id ?? null,
        versions: workspace.versions(input.id, input.name).map((v) => ({
          id: v.id,
          hash: v.source_hash,
          origin: v.origin,
          createdAt: v.created_at,
          active: v.id === head?.id,
        })),
      };
    },
  );
  app.post(
    "/api/supabase/:id/functions",
    { preHandler: requireSessionMutationAuth, bodyLimit: 300_000 },
    async (request, reply) => {
      const { id } = params.parse(request.params);
      const input = z
        .object({
          name: name.optional(),
          source: z
            .string()
            .min(1)
            .max(262144)
            .refine((s) => Buffer.byteLength(s) <= 262144)
            .optional(),
          expectedHash,
        })
        .strict()
        .refine((v) => Boolean(v.name) === Boolean(v.source))
        .parse(request.body);
      if (!input.name || !input.source) {
        const instance = store.get(id),
          settings = JSON.parse(instance.settings_json) as Record<
            string,
            unknown
          >;
        settings.functionsEnabled = true;
        settings.functionsPending = true;
        const job = db.sqlite.transaction(() => {
          const j = store.enqueue(id, "start");
          store.update(id, { settings_json: JSON.stringify(settings) });
          return j;
        })();
        return reply.code(202).send({ jobId: job.id });
      }
      workspace.checkExpected(store.get(id), input.name, input.expectedHash);
      return reply
        .code(202)
        .send({ jobId: workspace.enqueue(id, "function-deploy", input).id });
    },
  );
  app.delete(
    "/api/supabase/:id/functions/:name",
    { preHandler: requireSessionMutationAuth },
    async (request, reply) => {
      const { id, name: fn } = params.extend({ name }).parse(request.params);
      const input = z
        .object({ expectedHash: z.string().regex(/^[a-f0-9]{64}$/) })
        .strict()
        .parse(request.body);
      workspace.checkExpected(store.get(id), fn, input.expectedHash);
      return reply.code(202).send({
        jobId: workspace.enqueue(id, "function-delete", {
          name: fn,
          ...input,
        }).id,
      });
    },
  );
  app.post(
    "/api/supabase/:id/functions/:name/invoke",
    {
      preHandler: requireSessionMutationAuth,
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      bodyLimit: 70_000,
    },
    async (request, reply) => {
      const { id, name: fn } = params.extend({ name }).parse(request.params);
      const input = z
        .object({
          method: z
            .enum(["GET", "POST", "PUT", "PATCH", "DELETE"])
            .default("POST"),
          body: z.string().max(65536).optional(),
          query: z.string().max(2048).default(""),
          auth: z.enum(["anon", "none"]).default("anon"),
        })
        .strict()
        .parse(request.body);
      return reply.code(202).send({
        jobId: workspace.enqueue(id, "function-invoke", {
          name: fn,
          ...input,
        }).id,
      });
    },
  );
  app.get(
    "/api/supabase/:id/operations/:jobId/result",
    { preHandler: requireSessionAuth },
    async (request) => {
      const { id, jobId } = params
        .extend({ jobId: z.string().regex(/^sbj_[a-f0-9]{32}$/) })
        .parse(request.params);
      return { result: workspace.readResult(id, jobId) };
    },
  );
  app.post(
    "/api/supabase/:id/connections/:projectId/check",
    { preHandler: requireSessionMutationAuth },
    async (request, reply) => {
      const { id, projectId } = z
        .object({ id: params.shape.id, projectId: z.string().min(1).max(128) })
        .parse(request.params);
      return reply.code(202).send({
        jobId: workspace.enqueue(id, "connection-check", { projectId }).id,
      });
    },
  );
  app.post(
    "/api/supabase/:id/backups/:backupId/verify",
    { preHandler: requireSessionMutationAuth },
    async (request, reply) => {
      const { id, backupId } = z
        .object({
          id: params.shape.id,
          backupId: z.string().regex(/^sbb_[a-f0-9]{32}$/),
        })
        .parse(request.params);
      return reply.code(202).send({
        jobId: workspace.enqueue(id, "backup-verify", { backupId }).id,
      });
    },
  );
  app.get(
    "/api/supabase/:id/backup-policy",
    { preHandler: requireSessionAuth },
    async (request) => {
      const { id } = params.parse(request.params);
      store.get(id);
      return new SupabaseBackupPolicy(config, db).get(id);
    },
  );
  app.put(
    "/api/supabase/:id/backup-policy",
    { preHandler: requireSessionMutationAuth },
    async (request) => {
      const { id } = params.parse(request.params);
      return new SupabaseBackupPolicy(config, db).set(
        id,
        BackupPolicyInput.parse(request.body),
      );
    },
  );
  app.post(
    "/api/supabase/:id/backup-policy/check",
    { preHandler: requireSessionMutationAuth },
    async (request, reply) => {
      const { id } = params.parse(request.params);
      return reply
        .code(202)
        .send({ jobId: workspace.enqueue(id, "backup-destination-check").id });
    },
  );
  app.post(
    "/api/supabase/:id/backups/:backupId/upload",
    { preHandler: requireSessionMutationAuth },
    async (request, reply) => {
      const { id, backupId } = z
        .object({
          id: params.shape.id,
          backupId: z.string().regex(/^sbb_[a-f0-9]{32}$/),
        })
        .parse(request.params);
      return reply
        .code(202)
        .send({
          jobId: workspace.enqueue(id, "backup-upload", { backupId }).id,
        });
    },
  );
}
