import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "../lib/database.js";
import { notFound } from "../lib/errors.js";
import { requireScopedAuth, requireScopedMutation, requireSessionMutationAuth } from "../services/auth.js";
import type { CloudflareService } from "../services/cloudflare.js";
import type { ExternalDomains } from "../services/external-domains.js";

export function registerExternalDomainRoutes(app: FastifyInstance, database: Database, cloudflare: CloudflareService, external: ExternalDomains): void {
  app.get("/api/settings/external-domains", { preHandler: requireScopedAuth("domains:write") }, async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return { externalDomains: cloudflare.externalDomainSettings() };
  });
  app.put<{ Body: unknown }>("/api/settings/external-domains", {
    preHandler: requireSessionMutationAuth,
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const input = z.object({ zoneId: z.string().regex(/^[a-f0-9]{32}$/i), cnameTarget: z.string().min(3).max(253) }).strict().parse(request.body);
    reply.header("cache-control", "no-store");
    return { externalDomains: await cloudflare.configureExternalDomains(input.zoneId, input.cnameTarget) };
  });
  app.get<{ Params: { id: string } }>("/api/projects/:id/domains", { preHandler: requireScopedAuth("domains:write") }, async (request, reply) => {
    if (!database.getProject(request.params.id)) throw notFound("Project not found");
    reply.header("cache-control", "no-store");
    return { domains: database.listDomains(request.params.id).map(domain => external.present(domain)) };
  });
  app.get<{ Params: { id: string; domainId: string } }>("/api/projects/:id/domains/:domainId", { preHandler: requireScopedAuth("domains:write") }, async (request, reply) => {
    const domain = database.getDomain(request.params.domainId);
    if (!domain || domain.project_id !== request.params.id || !database.getProject(request.params.id)) throw notFound("Domain not found");
    reply.header("cache-control", "no-store");
    return { domain: external.present(domain) };
  });
  app.post<{ Params: { id: string; domainId: string } }>("/api/projects/:id/domains/:domainId/verify", {
    preHandler: requireScopedMutation("domains:write"),
    config: { rateLimit: { max: 15, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const domain = database.getDomain(request.params.domainId);
    if (!domain || domain.project_id !== request.params.id || domain.connection !== "external") throw notFound("External domain not found");
    reply.header("cache-control", "no-store");
    return { domain: await external.verify(domain.id) };
  });
}
