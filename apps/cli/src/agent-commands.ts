import { readFile } from "node:fs/promises";
import { parseOptions, requirePositionals, requiredOption } from "./arguments.js";
import type { ApiRequestOptions, ShelterClient } from "./api.js";

type Method = NonNullable<ApiRequestOptions["method"]>;
interface Command {
  method: Method;
  path: string;
  body?: true;
  scope: string;
  description: string;
}

// Paths and scopes mirror the token-authenticated server routes. Bodies retain
// the server's schema so new configuration fields do not require CLI flags.
export const agentCommands: Record<string, Command> = {
  overview: { method: "GET", path: "/api/overview", scope: "projects:read", description: "Inspect the installation overview" },
  schema: { method: "GET", path: "/api/openapi.json", scope: "none", description: "Read the installed server's OpenAPI contract" },
  analyze: { method: "POST", path: "/api/projects/analyze", body: true, scope: "projects:read", description: "Analyze bounded file facts supplied as JSON" },
  "project-update": { method: "PATCH", path: "/api/projects/{projectId}", body: true, scope: "projects:write", description: "Update project configuration" },
  "project-delete": { method: "DELETE", path: "/api/projects/{projectId}", body: true, scope: "projects:write", description: "Delete a project; body requires confirmation matching its name" },
  environment: { method: "PUT", path: "/api/projects/{projectId}/environment", body: true, scope: "environment:write", description: "Replace production environment variables" },
  deployment: { method: "GET", path: "/api/deployments/{deploymentId}", scope: "projects:read", description: "Inspect deployment state" },
  zones: { method: "GET", path: "/api/settings/cloudflare/zones", scope: "domains:write", description: "List connected Cloudflare zones" },
  "domain-access": { method: "PUT", path: "/api/projects/{projectId}/domains/{domainId}/access", body: true, scope: "domains:write", description: "Configure password protection and search visibility" },
  "domain-revoke": { method: "POST", path: "/api/projects/{projectId}/domains/{domainId}/access/revoke", scope: "domains:write", description: "Revoke domain visitor sessions" },
  previews: { method: "GET", path: "/api/projects/{projectId}/previews", scope: "projects:read", description: "List preview settings and lifecycle state" },
  "preview-settings": { method: "PUT", path: "/api/projects/{projectId}/previews/settings", body: true, scope: "projects:write", description: "Configure pull-request previews" },
  "preview-environment": { method: "PUT", path: "/api/projects/{projectId}/previews/environment", body: true, scope: "environment:write", description: "Replace isolated preview environment variables" },
  "preview-delete": { method: "DELETE", path: "/api/projects/{projectId}/previews/{previewId}", scope: "deployments:write", description: "Remove a preview and its owned resources" }
};

export async function readJsonInput(source: string): Promise<unknown> {
  const limit = 4 * 1024 * 1024;
  let raw: string;
  if (source === "-") {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      const buffer = Buffer.from(chunk as Uint8Array);
      size += buffer.length;
      if (size > limit) throw new Error("JSON input exceeds 4 MiB.");
      chunks.push(buffer);
    }
    raw = Buffer.concat(chunks).toString("utf8");
  } else {
    raw = await readFile(source, "utf8");
  }
  if (Buffer.byteLength(raw) > limit) throw new Error("JSON input exceeds 4 MiB.");
  try {
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    // JSON parser messages can include secrets from the request body.
    throw new Error("Input must be a valid JSON object.");
  }
}

export async function runAgentCommand(
  name: string, args: string[], client: ShelterClient
): Promise<unknown> {
  if (name === "api") {
    const options = parseOptions(args, ["input"]);
    const [method, path] = requirePositionals(options, 2);
    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method ?? "")) throw new Error("Unsupported API method.");
    if (method === "GET" && options.values.input) throw new Error("GET requests cannot have an input body.");
    return client.request(path ?? "", {
      method: method as Method,
      ...(options.values.input ? { body: await readJsonInput(options.values.input) } : {})
    });
  }
  const command = agentCommands[name];
  if (!command) throw new Error("Unknown agent command.");
  const options = parseOptions(args, command.body ? ["input"] : []);
  const placeholders = command.path.match(/\{\w+\}/g) ?? [];
  const values = requirePositionals(options, placeholders.length);
  let path = command.path;
  placeholders.forEach((placeholder, index) => {
    const value = values[index] ?? "";
    if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error("Invalid resource ID.");
    path = path.replace(placeholder, value);
  });
  return client.request(path, {
    method: command.method,
    ...(command.body ? { body: await readJsonInput(requiredOption(options, "input")) } : {})
  });
}
