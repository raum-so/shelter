import type { ApiTokenScope, UserRow } from "./models.js";

export interface SessionAuthentication {
  kind: "session";
  user: UserRow;
  sessionTokenHash: string;
  csrfHash: string;
  csrfToken: string | null;
}

export interface ApiTokenAuthentication {
  projectId?: string | null;
  kind: "apiToken";
  user: UserRow;
  apiTokenId: string;
  apiTokenName: string;
  scopes: ApiTokenScope[];
}

declare module "fastify" {
  interface FastifyRequest {
    auth: SessionAuthentication | ApiTokenAuthentication | null;
  }
}

export {};
