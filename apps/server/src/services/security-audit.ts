import type { Database } from "../lib/database.js";
import type { FastifyInstance } from "fastify";
import { newId } from "../lib/security.js";
export function recordSecurityEvent(
  db: Database,
  userId: string | null,
  event: string,
  resource: string | null = null,
  status = 200,
) {
  db.sqlite
    .prepare(
      "INSERT INTO security_events(id,user_id,event,resource_id,created_at,status) VALUES(?,?,?,?,?,?)",
    )
    .run(
      newId("evt"),
      userId,
      event,
      resource,
      new Date().toISOString(),
      status,
    );
  db.sqlite
    .prepare(
      "DELETE FROM security_events WHERE id IN (SELECT id FROM security_events ORDER BY created_at DESC,id DESC LIMIT -1 OFFSET 10000)",
    )
    .run();
}
export function installSecurityAudit(app: FastifyInstance, db: Database) {
  app.addHook("onResponse", async (request, reply) => {
    const route = request.routeOptions.url;
    if (
      !request.auth ||
      !route ||
      ["GET", "HEAD", "OPTIONS"].includes(request.method) ||
      !route.startsWith("/api/")
    )
      return;
    // Only fixed route templates and validated identifiers are persisted, never bodies, URLs, codes or credentials.
    const params = request.params as Record<string, unknown> | undefined;
    const resource =
      typeof params?.id === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(params.id)
        ? params.id
        : null;
    recordSecurityEvent(
      db,
      request.auth.user.id,
      `${request.method} ${route}`,
      resource,
      reply.statusCode,
    );
  });
}
