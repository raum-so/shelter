import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { Database } from "../lib/database.js";
import { badRequest, conflict } from "../lib/errors.js";
import { verifyPassword } from "../lib/security.js";
import { requireSessionAuth, requireSessionMutationAuth, sessionAuthentication } from "../services/auth.js";
import { ControlPlaneUpdates, StableVersion, updatePending } from "../services/control-plane-updates.js";

export function registerUpdateRoutes(app: FastifyInstance, config: AppConfig, database: Database): void {
  const updates = new ControlPlaneUpdates(config, database);
  app.addHook("onRequest", async (request) => {
    const pathname = request.url.split("?")[0]!;
    if (request.auth && !["GET", "HEAD", "OPTIONS"].includes(request.method)
      && /^\/api\/(projects|deployments|uploads|settings)(\/|$)/.test(pathname)
      && !pathname.startsWith("/api/settings/updates") && updatePending(config)) {
      throw conflict("A Shelter update is active. Try again after it finishes.", "UPDATE_BUSY");
    }
  });
  app.get("/api/settings/updates", { preHandler: requireSessionAuth }, async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return updates.state();
  });
  app.post("/api/settings/updates/check", {
    preHandler: requireSessionMutationAuth, config: { rateLimit: { max: 5, timeWindow: "1 minute" } }
  }, async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return updates.check();
  });
  app.post<{ Body: unknown }>("/api/settings/updates", {
    preHandler: requireSessionMutationAuth, config: { rateLimit: { max: 3, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const input = z.object({
      tag: z.string().max(40), fromVersion: StableVersion, currentPassword: z.string().min(1).max(1024), backupConfirmed: z.literal(true)
    }).strict().parse(request.body);
    if (!await verifyPassword(input.currentPassword, sessionAuthentication(request).user.password_hash)) {
      throw badRequest("The current password is incorrect.", "CURRENT_PASSWORD_INVALID");
    }
    reply.header("cache-control", "no-store");
    return reply.code(202).send(await updates.start(input.tag, input.fromVersion));
  });
}
