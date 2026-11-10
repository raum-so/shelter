import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { Database } from "../lib/database.js";
import {
  requireSessionAuth,
  requireSessionMutationAuth,
  sessionAuthentication,
} from "../services/auth.js";
import { SmtpInput, SmtpService, SupabaseSmtpInput } from "../services/smtp.js";
import { SupabaseMailService } from "../services/supabase-mail.js";

export function registerSmtpRoutes(
  app: FastifyInstance,
  config: AppConfig,
  db: Database,
) {
  const smtp = new SmtpService(config, db),
    mail = new SupabaseMailService(config, db);
  app.get(
    "/api/settings/smtp",
    { preHandler: requireSessionAuth },
    async (_request, reply) => {
      reply.header("cache-control", "no-store");
      return { ...smtp.state(), instances: mail.targets() };
    },
  );
  app.put(
    "/api/settings/smtp",
    { preHandler: requireSessionMutationAuth },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      return {
        ...smtp.save(SmtpInput.parse(request.body)),
        instances: mail.targets(),
      };
    },
  );
  app.post(
    "/api/settings/smtp/verify",
    {
      preHandler: requireSessionMutationAuth,
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const { revision } = z
        .object({ revision: z.uuid() })
        .strict()
        .parse(request.body);
      reply.header("cache-control", "no-store");
      return { ...(await smtp.verify(revision)), instances: mail.targets() };
    },
  );
  app.post(
    "/api/settings/smtp/test-email",
    {
      preHandler: requireSessionMutationAuth,
      config: { rateLimit: { max: 3, timeWindow: "10 minutes" } },
    },
    async (request, reply) => {
      const { revision } = z
        .object({ revision: z.uuid() })
        .strict()
        .parse(request.body);
      reply.header("cache-control", "no-store");
      return smtp.sendTest(revision, sessionAuthentication(request).user.email);
    },
  );
  app.post(
    "/api/settings/smtp/apply",
    { preHandler: requireSessionMutationAuth },
    async (request, reply) => {
      const { revision } = z
        .object({ revision: z.uuid().nullable() })
        .strict()
        .parse(request.body);
      reply.header("cache-control", "no-store");
      return reply.code(202).send(mail.applyGlobal(revision));
    },
  );
  app.put(
    "/api/supabase/:id/smtp",
    {
      preHandler: requireSessionMutationAuth,
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const { id } = z
        .object({ id: z.string().regex(/^sb_[a-f0-9]{32}$/) })
        .parse(request.params);
      const input = SupabaseSmtpInput.parse(request.body);
      reply.header("cache-control", "no-store");
      return reply.code(202).send(await mail.selectSource(id, input));
    },
  );
}
