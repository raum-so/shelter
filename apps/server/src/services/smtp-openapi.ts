const session = [{ sessionCookie: [] }];
const password = {
  type: "string",
  minLength: 1,
  maxLength: 4096,
  writeOnly: true,
};
const fields = {
  host: { type: "string", maxLength: 253 },
  port: { type: "integer", const: 465 },
  user: { type: "string", minLength: 1, maxLength: 4096 },
  password,
  fromEmail: { type: "string", format: "email", maxLength: 320 },
  fromName: { type: "string", minLength: 1, maxLength: 160 },
};
const revision = { type: ["string", "null"], format: "uuid" };
const body = (schema: unknown) => ({
  required: true,
  content: { "application/json": { schema } },
});
const errors = {
  "400": {
    description:
      "Invalid input or SMTP connection rejected; no provider secrets returned",
  },
  "401": { description: "Authentication required" },
  "403": { description: "Administrator session and CSRF token required" },
  "409": {
    description:
      "Stale revision, unverified SMTP, or instance operation in progress",
  },
  "429": { description: "Too many connection attempts" },
};
const mutation = (summary: string, schema: unknown, accepted = false) => ({
  tags: ["SMTP"],
  summary,
  security: session,
  description:
    "Requires an administrator browser session and CSRF token. Personal API tokens are not accepted.",
  requestBody: body(schema),
  responses: {
    [accepted ? "202" : "200"]: {
      description: accepted ? "Update jobs queued" : "Operation completed",
    },
    ...errors,
  },
});
export const smtpOpenApiPaths = {
  "/api/settings/smtp": {
    get: {
      tags: ["SMTP"],
      summary: "Read redacted global SMTP settings and instance consumers",
      security: session,
      responses: {
        "200": {
          description:
            "Settings without credentials, verification state and instance consumers",
        },
        ...errors,
      },
    },
    put: mutation(
      "Save global SMTP settings; invalidate previous verification",
      {
        type: "object",
        additionalProperties: false,
        required: ["expectedRevision", "host", "user", "fromEmail", "fromName"],
        properties: {
          ...fields,
          expectedRevision: revision,
          enabled: { type: "boolean", default: true },
          provider: {
            type: "string",
            enum: ["custom", "resend", "zoho"],
            default: "custom",
          },
        },
      },
    ),
  },
  "/api/settings/smtp/verify": {
    post: mutation("Verify TLS and SMTP authentication without sending mail", {
      type: "object",
      additionalProperties: false,
      required: ["revision"],
      properties: { revision: { type: "string", format: "uuid" } },
    }),
  },
  "/api/settings/smtp/test-email": {
    post: mutation(
      "Send a fixed test email only to the authenticated administrator",
      {
        type: "object",
        additionalProperties: false,
        required: ["revision"],
        properties: { revision: { type: "string", format: "uuid" } },
      },
    ),
  },
  "/api/settings/smtp/apply": {
    post: mutation(
      "Apply a verified revision to global consumers, preserving individual overrides",
      {
        type: "object",
        additionalProperties: false,
        required: ["revision"],
        properties: { revision },
      },
      true,
    ),
  },
  "/api/supabase/{id}/smtp": {
    parameters: [
      {
        name: "id",
        in: "path",
        required: true,
        schema: { type: "string", pattern: "^sb_[a-f0-9]{32}$" },
      },
    ],
    put: mutation(
      "Select global, disabled, or verified custom SMTP for an instance",
      {
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["source"],
            properties: { source: { enum: ["global", "disabled"] } },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["source", "smtp"],
            properties: {
              source: { const: "custom" },
              smtp: {
                type: "object",
                additionalProperties: false,
                required: ["host", "user", "fromEmail", "fromName"],
                properties: fields,
              },
            },
          },
        ],
      },
      true,
    ),
  },
};
