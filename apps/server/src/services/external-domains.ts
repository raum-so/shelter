import { randomBytes } from "node:crypto";
import { Resolver } from "node:dns/promises";
import { parse } from "tldts";
import type { AppConfig } from "../config.js";
import type { Database } from "../lib/database.js";
import { badRequest, conflict, HttpError, notFound } from "../lib/errors.js";
import { newId, normalizeHostname } from "../lib/security.js";
import type { DomainRow } from "../types/models.js";
import type { CloudflareService } from "./cloudflare.js";
import { panelHostnames } from "./panel-domains.js";
import { reconcileRouting } from "./routing.js";

interface DnsRecord { type: "CNAME" | "TXT"; name: string; value: string }
interface ExternalRow {
  domain_id: string;
  zone_id: string;
  cname_target: string;
  verification_token: string;
  provider_id: string | null;
  phase: "ownership" | "dns" | "certificate" | "deployment" | "active" | "removing" | "error";
  dns_ready: number;
  hostname_status: string;
  tls_status: string;
  verified_at: string | null;
  checked_at: string | null;
  next_check_at: number;
  locked_until: number;
  last_error: string | null;
  validation_records_json: string;
}

const canonical = (name: string) => name.toLowerCase().replace(/\.$/, "");
const verificationName = (hostname: string) => `_shelter-verification.${hostname}`;

/** DNS-only checks: customer names are never fetched as URLs or private origins. */
async function dnsLookup<T>(lookup: () => Promise<T>): Promise<T | null> {
  try { return await lookup(); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENODATA" || code === "ENOTFOUND") return null;
    throw badRequest("DNS could not be checked; the previous route is unchanged", "EXTERNAL_DNS_UNAVAILABLE");
  }
}

export class ExternalDomains {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<unknown> | null = null;
  private readonly dns = new Resolver({ timeout: 3_000, tries: 1 });

  constructor(private readonly config: AppConfig, private readonly database: Database, private readonly cloudflare: CloudflareService) {
    // Verify public records independently of host/VPN DNS and its negative cache.
    this.dns.setServers(config.EXTERNAL_DOMAIN_DNS_SERVERS);
  }

  private row(id: string): ExternalRow | undefined {
    return this.database.sqlite.prepare("SELECT * FROM external_domains WHERE domain_id = ?").get(id) as ExternalRow | undefined;
  }

  private save(row: ExternalRow): void {
    this.database.sqlite.prepare(`UPDATE external_domains SET
      provider_id = @provider_id, phase = @phase, dns_ready = @dns_ready,
      hostname_status = @hostname_status, tls_status = @tls_status, verified_at = @verified_at,
      checked_at = @checked_at, next_check_at = @next_check_at, last_error = @last_error,
      validation_records_json = @validation_records_json WHERE domain_id = @domain_id`).run(row);
  }

  present(domain: DomainRow) {
    const row = this.row(domain.id);
    return {
      id: domain.id, hostname: domain.hostname, status: domain.status, error: domain.error,
      connection: row ? "external" : "cloudflare",
      ...(row ? { external: {
        phase: row.phase, cnameTarget: row.cname_target, ownershipVerified: Boolean(row.verified_at),
        dnsReady: row.dns_ready === 1, hostnameStatus: row.hostname_status, tlsStatus: row.tls_status,
        lastCheckedAt: row.checked_at, error: row.last_error,
        records: [
          { type: "CNAME", name: domain.hostname, value: row.cname_target },
          { type: "TXT", name: verificationName(domain.hostname), value: row.verification_token },
          ...JSON.parse(row.validation_records_json) as DnsRecord[]
        ]
      } } : {})
    };
  }

  create(projectId: string, input: string) {
    const hostname = normalizeHostname(input);
    const parsed = parse(hostname, { allowPrivateDomains: true });
    if (hostname.length > 220 || input.trim() !== hostname || !parsed.subdomain || parsed.isIp) {
      throw badRequest("Use a lowercase subdomain without a scheme, path, or wildcard", "EXTERNAL_HOSTNAME_INVALID");
    }
    const settings = this.cloudflare.externalDomainSettings();
    if (!settings.configured || !settings.zoneId || !settings.cnameTarget) {
      throw badRequest("Configure external customer domains in Cloudflare settings first", "EXTERNAL_DOMAINS_NOT_CONFIGURED");
    }
    if (hostname === settings.cnameTarget || panelHostnames(this.database).includes(hostname)
      || this.database.sqlite.prepare("SELECT 1 FROM supabase_domains WHERE hostname = ?").get(hostname)) {
      throw conflict("This hostname is reserved", "PANEL_DOMAIN");
    }
    const domain: DomainRow = {
      id: newId("dom"), project_id: projectId, hostname, zone_id: null, dns_record_id: null,
      status: "pending", error: null, created_at: new Date().toISOString()
    };
    const selected = this.database.sqlite.transaction(() => {
      if (!this.database.getMutableProject(projectId)) throw notFound("Project not found");
      const existing = this.database.listDomains().find(candidate => candidate.hostname === hostname);
      if (existing) {
        if (existing.project_id === projectId && existing.connection === "external" && this.row(existing.id)?.phase !== "removing") return existing;
        throw conflict("The domain is already assigned to a project", "DOMAIN_EXISTS");
      }
      if ((this.database.sqlite.prepare("SELECT count(*) AS n FROM external_domains").get() as { n: number }).n >= 1000) {
        throw conflict("The external domain limit has been reached", "EXTERNAL_DOMAIN_LIMIT");
      }
      this.database.createDomain(domain);
      this.database.sqlite.prepare(`INSERT INTO external_domains (domain_id, zone_id, cname_target, verification_token)
        VALUES (?, ?, ?, ?)`).run(domain.id, settings.zoneId, settings.cnameTarget, randomBytes(32).toString("hex"));
      return domain;
    }).immediate();
    return this.present(selected);
  }

  private async lease<T>(id: string, action: (row: ExternalRow) => Promise<T>): Promise<T> {
    const claimed = this.database.sqlite.prepare(`UPDATE external_domains SET locked_until = ?
      WHERE domain_id = ? AND locked_until <= ?`).run(Date.now() + 300_000, id, Date.now());
    if (!claimed.changes) throw conflict("A domain operation is already running", "DOMAIN_MUTATION_ACTIVE");
    try { return await action(this.row(id)!); }
    finally { this.database.sqlite.prepare("UPDATE external_domains SET locked_until = 0 WHERE domain_id = ?").run(id); }
  }

  async verify(id: string) {
    return this.lease(id, async row => {
      const domain = this.database.getDomain(id);
      if (!domain || !this.database.getMutableProject(domain.project_id)) throw notFound("Project not found");
      if (row.phase === "removing") throw conflict("The domain is being removed", "DOMAIN_MUTATION_ACTIVE");
      row.checked_at = new Date().toISOString();
      row.next_check_at = Date.now() + 60_000;
      row.last_error = null;
      try {
        if (!row.verified_at) {
          const records = await dnsLookup(() => this.dns.resolveTxt(verificationName(domain.hostname)));
          if (!records?.some(chunks => chunks.join("") === row.verification_token)) {
            row.phase = "ownership";
            this.database.updateDomain(id, { zone_id: null, dns_record_id: null, status: "pending", error: null });
            this.save(row);
            return this.present(this.database.getDomain(id)!);
          }
          row.verified_at = row.checked_at;
          this.save(row);
        }
        const names = await dnsLookup(() => this.dns.resolveCname(domain.hostname));
        row.dns_ready = names?.some(name => canonical(name) === row.cname_target) ? 1 : 0;
        if (!row.dns_ready) {
          row.phase = "dns";
          this.database.updateDomain(id, { zone_id: null, dns_record_id: null, status: "pending", error: null });
          this.save(row);
          reconcileRouting(this.config, this.database);
          return this.present(this.database.getDomain(id)!);
        }
        await this.cloudflare.validateExternalDomainTarget(row.zone_id, row.cname_target);
        if (!row.provider_id) {
          const created = await this.cloudflare.createCustomHostname(row.zone_id, domain.hostname);
          if (canonical(created.hostname) !== domain.hostname || created.custom_origin_server) {
            throw conflict("Cloudflare returned a different hostname", "CUSTOM_HOSTNAME_DRIFT");
          }
          row.provider_id = created.id;
          this.save(row);
        }
        const provider = await this.cloudflare.getCustomHostname(row.zone_id, row.provider_id, domain.hostname);
        if (!provider) throw conflict("The Cloudflare custom hostname is missing; remove and reconnect this domain", "CUSTOM_HOSTNAME_MISSING");
        row.hostname_status = provider.status;
        row.tls_status = provider.ssl.status;
        row.validation_records_json = JSON.stringify((provider.ssl.validation_records ?? [])
          .filter(record => record.txt_name && record.txt_value)
          .map(record => ({ type: "TXT", name: record.txt_name!, value: record.txt_value! })));
        const project = this.database.getMutableProject(domain.project_id);
        const deployment = project?.active_deployment_id ? this.database.getDeployment(project.active_deployment_id) : undefined;
        row.phase = provider.status !== "active" || provider.ssl.status !== "active" ? "certificate"
          : !deployment?.internal_port ? "deployment" : "active";
        row.next_check_at = Date.now() + (row.phase === "active" ? 300_000 : 60_000);
        this.database.updateDomain(id, { zone_id: null, dns_record_id: null, status: row.phase === "active" ? "active" : "pending", error: null });
      } catch (error) {
        row.last_error = error instanceof HttpError ? error.message : "External domain verification failed; retry later";
        // Transport failures are not proof that an established route is invalid.
        const definitive = error instanceof HttpError && ["CUSTOM_HOSTNAME_DRIFT", "CUSTOM_HOSTNAME_MISSING", "SAAS_FALLBACK_NOT_READY", "SAAS_TARGET_INVALID"].includes(error.code);
        if (domain.status !== "active" || definitive) {
          row.phase = "error";
          this.database.updateDomain(id, { zone_id: null, dns_record_id: null, status: "error", error: row.last_error });
        }
      }
      this.save(row);
      reconcileRouting(this.config, this.database);
      return this.present(this.database.getDomain(id)!);
    });
  }

  async remove(id: string): Promise<void> {
    await this.lease(id, async row => {
      const domain = this.database.getDomain(id);
      if (!domain) return;
      row.phase = "removing";
      row.next_check_at = Date.now() + 60_000;
      row.last_error = null;
      this.save(row);
      this.database.updateDomain(id, { zone_id: null, dns_record_id: null, status: "error", error: null });
      reconcileRouting(this.config, this.database);
      try {
        if (row.provider_id) await this.cloudflare.deleteCustomHostname(row.zone_id, row.provider_id, domain.hostname);
        this.database.deleteDomain(id);
      } catch (error) {
        row.last_error = error instanceof HttpError ? error.message : "Cloudflare cleanup failed; retry later";
        this.save(row);
        this.database.updateDomain(id, { zone_id: null, dns_record_id: null, status: "error", error: row.last_error });
        throw error;
      }
    });
  }

  async processNext(): Promise<void> {
    const row = this.database.sqlite.prepare(`SELECT e.* FROM external_domains e
      JOIN domains d ON d.id = e.domain_id WHERE e.next_check_at <= ? AND e.locked_until <= ?
      AND NOT EXISTS (SELECT 1 FROM project_deletions p WHERE p.project_id = d.project_id)
      ORDER BY e.next_check_at LIMIT 1`).get(Date.now(), Date.now()) as ExternalRow | undefined;
    if (!row) return;
    if (row.phase === "removing") await this.remove(row.domain_id);
    else await this.verify(row.domain_id);
  }

  start(): void {
    if (this.timer) return;
    const tick = () => {
      if (this.running) return;
      this.running = this.processNext().catch(() => undefined).finally(() => { this.running = null; });
    };
    this.timer = setInterval(tick, 2_000);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.dns.cancel();
    await this.running;
  }
}
