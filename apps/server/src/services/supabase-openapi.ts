const read = [{ bearerAuth: [] }, { sessionCookie: [] }];
const session = [{ sessionCookie: [] }];
const errors = {
  "400": { description: "Invalid input" },
  "401": { description: "Authentication required" },
  "403": { description: "Missing scope or session" },
  "409": { description: "Resource conflict" },
};
const id = {
  name: "id",
  in: "path",
  required: true,
  schema: { type: "string", pattern: "^sb_[a-f0-9]{32}$" },
};
const body = (schema: unknown) => ({
  required: true,
  content: { "application/json": { schema } },
});
const workspacePath = (summary: string, method = "post") => ({
  parameters: [id],
  [method]: {
    tags: ["Supabase"],
    summary,
    security: session,
    responses: {
      [method === "get" ? "200" : "202"]: {
        description: method === "get" ? "Result" : "Queued operation",
      },
      ...errors,
    },
  },
});
export const supabaseOpenApiPaths = {
  "/api/supabase/{id}/functions": {
    ...workspacePath("List function metadata", "get"),
    post: {
      tags: ["Supabase"],
      summary: "Validate and deploy a versioned function",
      security: session,
      description:
        "Browser session and CSRF required. Supply name, source (up to 256 KiB UTF-8) and expectedHash (null to create, current hash to update). Existing functions are never overwritten without a matching hash.",
      responses: { "202": { description: "Queued operation" }, ...errors },
    },
  },
  "/api/supabase/{id}/functions/refresh": workspacePath(
    "Refresh the bounded function catalog from disk",
  ),
  "/api/supabase/{id}/functions/{name}": {
    parameters: [
      id,
      { name: "name", in: "path", required: true, schema: { type: "string" } },
    ],
    get: {
      tags: ["Supabase"],
      summary: "Read current source or a versionId and history",
      security: session,
      responses: {
        "200": { description: "Source and version metadata" },
        ...errors,
      },
    },
    delete: {
      tags: ["Supabase"],
      summary: "Remove an endpoint while retaining versions",
      security: session,
      responses: {
        "202": { description: "Queued removal; expectedHash required" },
        ...errors,
      },
    },
  },
  "/api/supabase/{id}/backup-policy": {
    parameters: [id],
    get: {
      tags: ["Supabase"],
      summary: "Read schedule and redacted storage settings",
      security: session,
      responses: { "200": { description: "Policy" }, ...errors },
    },
    put: {
      tags: ["Supabase"],
      summary: "Configure daily UTC backups and optional weekly restore tests",
      security: session,
      responses: {
        "200": { description: "Saved policy; secret never returned" },
        ...errors,
      },
    },
  },
  "/api/supabase": {
    get: {
      tags: ["Supabase"],
      summary: "List managed instances without credentials",
      security: read,
      responses: {
        "200": { description: "Instances with job and backup metadata" },
        ...errors,
      },
    },
    post: {
      tags: ["Supabase"],
      summary: "Create a managed Supabase instance",
      description:
        "Requires projects:write and domains:write. Worker installs the pinned stack asynchronously. Hostnames must be distinct and available in connected Cloudflare zones.",
      security: read,
      requestBody: body({
        type: "object",
        additionalProperties: false,
        required: ["name", "apiHostname", "studioHostname"],
        anyOf: [{ required: ["siteUrl"] }, { required: ["connection"] }],
        properties: {
          name: { type: "string", minLength: 2, maxLength: 80 },
          apiHostname: { type: "string" },
          studioHostname: { type: "string" },
          siteUrl: {
            type: "string",
            format: "uri",
            description: "Defaults to the connected app website when available",
          },
          connection: {
            type: "object",
            additionalProperties: false,
            required: ["projectId"],
            properties: {
              projectId: { type: "string" },
              urlVariable: { type: "string" },
              keyVariable: { type: "string" },
              replace: { type: "boolean", default: false },
            },
          },
          redirectUrls: {
            type: "array",
            maxItems: 20,
            items: { type: "string", format: "uri" },
          },
          smtpSource: {
            type: "string",
            enum: ["global", "custom", "disabled"],
          },
          smtp: {
            type: "object",
            additionalProperties: false,
            required: [
              "host",
              "port",
              "user",
              "sender",
              "adminEmail",
              "password",
            ],
            properties: {
              host: { type: "string" },
              port: { type: "integer", const: 465 },
              user: { type: "string" },
              sender: { type: "string" },
              adminEmail: { type: "string", format: "email" },
              password: { type: "string", writeOnly: true },
            },
          },
        },
      }),
      responses: {
        "202": { description: "Instance and queued job ID" },
        ...errors,
      },
    },
  },
  "/api/supabase/{id}": {
    parameters: [id],
    get: {
      tags: ["Supabase"],
      summary: "Read instance status",
      security: read,
      responses: {
        "200": { description: "Instance with job and backup metadata" },
        "404": { description: "Instance not found" },
        ...errors,
      },
    },
  },
  "/api/supabase/{id}/actions": {
    parameters: [id],
    post: {
      tags: ["Supabase"],
      summary: "Queue a Supabase operation",
      description:
        "Requires deployments:write. Restore requires a completed same-version backupId. Restore, archive and API-key rotation require confirmation exactly matching the instance name. Archive retains data. Backup briefly stops this instance.",
      security: read,
      requestBody: body({
        type: "object",
        additionalProperties: false,
        required: ["action"],
        properties: {
          action: {
            type: "string",
            enum: [
              "start",
              "stop",
              "backup",
              "restore",
              "rotate",
              "rotate-keys",
              "archive",
            ],
          },
          backupId: { type: "string" },
          confirmation: { type: "string" },
        },
      }),
      responses: { "202": { description: "Queued job ID" }, ...errors },
    },
  },
  "/api/supabase/{id}/credentials": {
    parameters: [id],
    post: {
      tags: ["Supabase"],
      summary: "Reveal credentials after password reauthentication",
      description:
        "Administrator browser session and CSRF token required. Never accepts API tokens. Response is not cached.",
      security: session,
      requestBody: body({
        type: "object",
        additionalProperties: false,
        required: ["currentPassword"],
        properties: { currentPassword: { type: "string", writeOnly: true } },
      }),
      responses: {
        "200": {
          description: "Sensitive credentials and loopback database port",
        },
        ...errors,
      },
    },
  },
  "/api/supabase/connections": {
    get: {
      tags: ["Supabase"],
      summary: "List app connections and eligible app options",
      security: read,
      responses: {
        "200": {
          description:
            "Connection states, suggested variable names and app websites; no credentials",
        },
        ...errors,
      },
    },
  },
  "/api/supabase/{id}/connections/{projectId}": {
    parameters: [
      id,
      {
        name: "projectId",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
    ],
    delete: {
      tags: ["Supabase"],
      summary: "Disconnect an app and remove unchanged managed variables",
      description:
        "Requires projects:write and environment:write. Edited variables and Supabase data are retained. A redeployment may be required.",
      security: read,
      responses: {
        "200": { description: "environmentRetained and redeployRequired" },
        ...errors,
      },
    },
  },
  "/api/supabase/{id}/connections": {
    parameters: [id],
    post: {
      tags: ["Supabase"],
      summary: "Link public connection variables to an application",
      description:
        "Requires environment:write, projects:write and deployments:write. Persists an app connection and prepares only the public API URL and anon key. Exact app sign-in destinations may queue an Auth restart. Existing values require explicit replacement; deployment is a separate action.",
      security: read,
      requestBody: body({
        type: "object",
        additionalProperties: false,
        required: ["projectId"],
        properties: {
          projectId: { type: "string" },
          urlVariable: {
            type: "string",
            description: "Defaults to the app framework convention",
          },
          keyVariable: {
            type: "string",
            description: "Defaults to the app framework convention",
          },
          siteUrl: { type: "string", format: "uri" },
          replace: { type: "boolean", default: false },
        },
      }),
      responses: {
        "200": {
          description:
            "Persisted connection status, variable names and redeployRequired",
        },
        ...errors,
      },
    },
  },
};
