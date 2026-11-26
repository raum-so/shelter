import { randomUUID } from "node:crypto";
import { z } from "zod";
import { badRequest, conflict } from "../lib/errors.js";

const phase = "http_request_dynamic_redirect";
const guard = 'not starts_with(http.request.uri.path, "/.well-known/acme-challenge/")';
const id = z.string().regex(/^[a-f0-9]{32}$/i);
const ruleSchema = z.object({
  id, action: z.literal("redirect"), expression: z.string().min(1).max(4096),
  action_parameters: z.record(z.string(), z.unknown()), description: z.string().optional(),
  enabled: z.boolean().optional(), ref: z.string().optional(),
  logging: z.object({ enabled: z.boolean() }).strict().optional(),
  version: z.string().optional(), last_updated: z.string().optional()
}).strict();
const rulesetSchema = z.object({
  id, kind: z.literal("zone"), phase: z.literal(phase), version: z.string(),
  rules: z.array(z.record(z.string(), z.unknown())).max(100).default([])
}).passthrough();
type Ruleset = z.infer<typeof rulesetSchema>;
type Rule = z.infer<typeof ruleSchema>;
type Client = { request<T>(method: string, endpoint: string, body?: unknown): Promise<T> };

export interface AcmeRedirectPlan {
  token: string;
  expiresAt: string;
  changes: Array<{ id: string; description: string; before: string; after: string }>;
}
interface StoredPlan {
  owner: string;
  expires: number;
  snapshot: Ruleset | null;
  rules: Rule[];
}

function stable(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
}

// Only recognize our complete outer guard. A substring inside an OR or a
// quoted string is not proof that all ACME requests bypass the redirect.
function protectedExpression(expression: string): boolean {
  const suffix = `) and ${guard}`;
  if (!expression.startsWith("(") || !expression.endsWith(suffix)) return false;
  const innerEnd = expression.length - suffix.length;
  let depth = 0;
  let quoted = false;
  let raw = false;
  for (let i = 0; i <= innerEnd; i++) {
    const character = expression[i];
    if (quoted) {
      if (!raw && character === "\\") i++;
      else if (character === '"') quoted = false;
    } else if (character === '"') {
      quoted = true;
      raw = expression[i - 1] === "r";
    } else if (character === "(") depth++;
    else if (character === ")" && --depth === 0) return i === innerEnd;
  }
  return false;
}

function writable(rule: Record<string, unknown>): Record<string, unknown> {
  const { version: _version, last_updated: _updated, id: _id, ...fields } = rule;
  return fields;
}

function semantics(ruleset: Ruleset | null): string {
  return stable(ruleset && { id: ruleset.id, kind: ruleset.kind, phase: ruleset.phase,
    rules: ruleset.rules.map(rule => ({ id: rule.id, ...writable(rule) })) });
}

function drift(): never {
  throw conflict("Cloudflare redirect rules changed. Inspect the setup again before saving.", "ACME_REDIRECT_DRIFT");
}

export class CloudflareAcmeRedirects {
  private readonly plans = new Map<string, StoredPlan>();
  private applying = false;

  constructor(private readonly read: (client: Client, zoneId: string) => Promise<unknown | null>) {}

  private async snapshot(client: Client, zoneId: string): Promise<Ruleset | null> {
    const result = await this.read(client, zoneId);
    if (result === null) return null;
    const parsed = rulesetSchema.safeParse(result);
    if (!parsed.success) throw badRequest("These Cloudflare redirect rules require manual review.", "ACME_REDIRECT_UNSUPPORTED");
    if (parsed.data.rules.some(rule => !id.safeParse(rule.id).success)
      || new Set(parsed.data.rules.map(rule => rule.id)).size !== parsed.data.rules.length) {
      throw badRequest("These Cloudflare redirect rules require manual review.", "ACME_REDIRECT_UNSUPPORTED");
    }
    return parsed.data;
  }

  async plan(client: Client, zoneId: string, owner: string): Promise<AcmeRedirectPlan> {
    const snapshot = await this.snapshot(client, zoneId);
    const rules: Rule[] = [];
    for (const rule of snapshot?.rules ?? []) {
      if (rule.enabled === false) continue;
      const parsed = ruleSchema.safeParse(rule);
      if (!parsed.success) throw badRequest("An enabled Cloudflare redirect rule requires manual review.", "ACME_REDIRECT_UNSUPPORTED");
      if (protectedExpression(parsed.data.expression)) continue;
      if (`(${parsed.data.expression}) and ${guard}`.length > 4096) {
        throw badRequest("A Cloudflare redirect expression is too long to extend safely.", "ACME_REDIRECT_UNSUPPORTED");
      }
      rules.push(parsed.data);
    }
    const now = Date.now();
    for (const [key, value] of this.plans) if (value.expires <= now) this.plans.delete(key);
    if (this.plans.size >= 20) this.plans.delete(this.plans.keys().next().value!);
    const token = randomUUID();
    const expires = now + 5 * 60_000;
    this.plans.set(token, { owner, expires, snapshot, rules });
    return { token, expiresAt: new Date(expires).toISOString(), changes: rules.map(rule => ({
      id: rule.id, description: rule.description || rule.id, before: rule.expression, after: `(${rule.expression}) and ${guard}`
    })) };
  }

  async apply(client: Client, zoneId: string, owner: string, token: string,
    backup: (value: unknown) => void): Promise<void> {
    const plan = this.plans.get(token);
    if (!plan || plan.owner !== owner || plan.expires <= Date.now()) {
      throw conflict("The redirect preview expired. Inspect the setup again.", "ACME_REDIRECT_PLAN_EXPIRED");
    }
    if (this.applying) throw conflict("A redirect update is already running.", "ACME_REDIRECT_BUSY");
    this.plans.delete(token);
    this.applying = true;
    try {
      let latest = await this.snapshot(client, zoneId);
      if (stable(latest) !== stable(plan.snapshot)) drift();
      if (!latest || !plan.rules.length) return;
      // Persist the provider's original definitions before the first write,
      // including when a timeout leaves the result of that write uncertain.
      backup({ zoneId, createdAt: new Date().toISOString(), ruleset: latest, ruleIds: plan.rules.map(rule => rule.id) });
      for (const rule of plan.rules) {
        if (!latest) drift();
        const before = await this.snapshot(client, zoneId);
        if (stable(before) !== stable(latest)) drift();
        const updated = { ...writable(rule), expression: `(${rule.expression}) and ${guard}` };
        const expected: Ruleset = { ...latest, rules: latest.rules.map(item => item.id === rule.id ? { id: rule.id, ...updated } : item) };
        // PATCH needs every writable field, not just the new expression.
        // No position is supplied, so the provider preserves the rule order.
        await client.request("PATCH", `/zones/${zoneId}/rulesets/${latest.id}/rules/${rule.id}`, updated);
        latest = await this.snapshot(client, zoneId);
        if (semantics(latest) !== semantics(expected)) drift();
      }
    } finally { this.applying = false; }
  }
}
