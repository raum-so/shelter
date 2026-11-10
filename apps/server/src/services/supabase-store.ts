import { SUPABASE_WORKSPACE_SCHEMA } from "./supabase-workspace.js";
import type { Database } from "../lib/database.js";
import { conflict, notFound } from "../lib/errors.js";
import { newId } from "../lib/security.js";
import { panelHostnames } from "./panel-domains.js";

export const SUPABASE_SCHEMA = `${SUPABASE_WORKSPACE_SCHEMA}

CREATE TABLE IF NOT EXISTS supabase_instances (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, version TEXT NOT NULL,
 api_hostname TEXT NOT NULL UNIQUE COLLATE NOCASE,
 studio_hostname TEXT NOT NULL UNIQUE COLLATE NOCASE,
 settings_json TEXT NOT NULL, encrypted_secrets TEXT NOT NULL,
 generation TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
 database_port INTEGER, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS supabase_domains (
 hostname TEXT PRIMARY KEY COLLATE NOCASE,
 instance_id TEXT NOT NULL REFERENCES supabase_instances(id),
 zone_id TEXT, record_id TEXT
);
CREATE TABLE IF NOT EXISTS supabase_jobs (
 id TEXT PRIMARY KEY, instance_id TEXT NOT NULL REFERENCES supabase_instances(id),
 action TEXT NOT NULL CHECK(action IN ('start','stop','backup','restore','rotate','rotate-keys','archive')),
 backup_id TEXT, resume_running INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL CHECK(status IN ('queued','running','ready','failed')),
 error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS supabase_one_job ON supabase_jobs(instance_id)
 WHERE status IN ('queued','running');
CREATE TABLE IF NOT EXISTS supabase_connections (
 project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
 instance_id TEXT NOT NULL REFERENCES supabase_instances(id),
 url_variable TEXT NOT NULL, key_variable TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','configured','error')), site_url TEXT,
 expected_hash TEXT NOT NULL, applied_hash TEXT, applied_at TEXT,
 error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS supabase_connections_instance ON supabase_connections(instance_id);
CREATE TABLE IF NOT EXISTS supabase_studio_access (
 token_hash TEXT PRIMARY KEY,
 kind TEXT NOT NULL CHECK(kind IN ('ticket','session')),
 instance_id TEXT NOT NULL REFERENCES supabase_instances(id) ON DELETE CASCADE,
 session_token_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
 credential_revision TEXT NOT NULL, browser_state_hash TEXT,
 expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS supabase_studio_access_expiry ON supabase_studio_access(expires_at);
CREATE TABLE IF NOT EXISTS supabase_function_jobs (
 job_id TEXT PRIMARY KEY REFERENCES supabase_jobs(id) ON DELETE CASCADE,
 name TEXT NOT NULL, encrypted_source TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS supabase_backups (
 id TEXT PRIMARY KEY, instance_id TEXT NOT NULL REFERENCES supabase_instances(id),
 version TEXT NOT NULL, generation TEXT NOT NULL, status TEXT NOT NULL,
 encrypted_secrets TEXT NOT NULL, size_bytes INTEGER, sha256 TEXT, created_at TEXT NOT NULL, settings_json TEXT
);
`;

export interface SupabaseSettings {
  functionsEnabled?: boolean;
  functionsPending?: boolean;
  authSettingsPending?: boolean;
  authSettingsJobId?: string;
  authSettingsResumeRunning?: boolean;
  smtpSource?: "global" | "custom" | "disabled";
  smtpRevision?: string | null;
  smtpAppliedRevision?: string | null;
  smtpPending?: boolean;
  smtpJobId?: string;
  smtpResumeRunning?: boolean;
  siteUrl: string;
  redirectUrls: string[];
  smtp?: {
    host: string;
    port: number;
    user: string;
    sender: string;
    adminEmail: string;
  };
}
export interface SupabaseInstance {
  id: string;
  name: string;
  version: string;
  api_hostname: string;
  studio_hostname: string;
  settings_json: string;
  encrypted_secrets: string;
  generation: string;
  status:
    "queued" | "provisioning" | "running" | "stopped" | "error" | "archived";
  database_port: number | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}
export type SupabaseAction =
  | "start"
  | "stop"
  | "backup"
  | "restore"
  | "rotate"
  | "rotate-keys"
  | "archive";
export interface SupabaseJob {
  id: string;
  instance_id: string;
  action: SupabaseAction;
  backup_id: string | null;
  resume_running: number;
  status: string;
  error: string | null;
  created_at: string;
  updated_at: string;
}
export interface SupabaseBackup {
  settings_json?: string | null;
  id: string;
  instance_id: string;
  version: string;
  generation: string;
  status: string;
  encrypted_secrets: string;
  size_bytes: number | null;
  sha256: string | null;
  created_at: string;
}

export class SupabaseStore {
  constructor(private readonly db: Database) {}
  operationSummary(id: string) {
    return (this.db.sqlite
      .prepare("SELECT kind,phase FROM supabase_operations WHERE job_id=?")
      .get(id) ??
      this.db.sqlite
        .prepare(
          "SELECT j.action AS kind,p.phase FROM supabase_job_progress p JOIN supabase_jobs j ON j.id=p.job_id WHERE p.job_id=?",
        )
        .get(id)) as { kind: string; phase: string } | undefined;
  }
  backupCheck(id: string) {
    return (
      this.db.sqlite
        .prepare(
          "SELECT checked_at AS checkedAt,restored_at AS restoredAt,offsite_at AS offsiteAt,error FROM supabase_backup_checks WHERE backup_id=?",
        )
        .get(id) ?? null
    );
  }
  list(): SupabaseInstance[] {
    return this.db.sqlite
      .prepare("SELECT * FROM supabase_instances ORDER BY created_at DESC")
      .all() as SupabaseInstance[];
  }
  get(id: string): SupabaseInstance {
    const instance = this.db.sqlite
      .prepare("SELECT * FROM supabase_instances WHERE id = ?")
      .get(id) as SupabaseInstance | undefined;
    if (!instance) throw notFound("Supabase instance not found");
    return instance;
  }
  jobs(id: string): SupabaseJob[] {
    return this.db.sqlite
      .prepare(
        "SELECT * FROM supabase_jobs WHERE instance_id = ? ORDER BY created_at DESC,rowid DESC LIMIT 20",
      )
      .all(id) as SupabaseJob[];
  }
  backups(id: string): SupabaseBackup[] {
    return this.db.sqlite
      .prepare(
        "SELECT * FROM supabase_backups WHERE instance_id = ? ORDER BY created_at DESC",
      )
      .all(id) as SupabaseBackup[];
  }
  create(instance: SupabaseInstance): SupabaseJob {
    return this.db.sqlite.transaction(() => {
      const hosts = [instance.api_hostname, instance.studio_hostname];
      for (const host of hosts) {
        if (
          panelHostnames(this.db).includes(host) ||
          this.db.sqlite
            .prepare("SELECT 1 FROM supabase_domains WHERE hostname = ?")
            .get(host) ||
          this.db.listDomains().some((d) => d.hostname === host)
        )
          throw conflict("Hostname already assigned", "DOMAIN_EXISTS");
      }
      this.db.sqlite
        .prepare(
          `INSERT INTO supabase_instances (id,name,version,api_hostname,studio_hostname,settings_json,encrypted_secrets,generation,status,created_at,updated_at) VALUES (@id,@name,@version,@api_hostname,@studio_hostname,@settings_json,@encrypted_secrets,@generation,@status,@created_at,@updated_at)`,
        )
        .run(instance);
      for (const host of hosts)
        this.db.sqlite
          .prepare(
            "INSERT INTO supabase_domains (hostname, instance_id) VALUES (?, ?)",
          )
          .run(host, instance.id);
      return this.enqueue(instance.id, "start");
    })();
  }
  enqueue(id: string, action: SupabaseAction, backupId?: string): SupabaseJob {
    return this.db.sqlite.transaction(() => {
      const instance = this.get(id);
      if (instance.status === "archived" && action !== "start")
        throw conflict("Instance is archived", "INSTANCE_ARCHIVED");
      if (
        this.db.sqlite
          .prepare(
            "SELECT 1 FROM supabase_jobs WHERE instance_id = ? AND status IN ('queued','running')",
          )
          .get(id)
      )
        throw conflict("An operation is already active", "INSTANCE_BUSY");
      if (
        action === "restore" &&
        !this.backups(id).some(
          (b) =>
            b.id === backupId &&
            b.status === "ready" &&
            b.version === instance.version,
        )
      )
        throw conflict(
          "A completed backup of this instance and version is required",
          "INVALID_BACKUP",
        );
      const now = new Date().toISOString();
      const job: SupabaseJob = {
        id: newId("sbj"),
        instance_id: id,
        action,
        backup_id: backupId ?? null,
        resume_running: instance.status === "running" ? 1 : 0,
        status: "queued",
        error: null,
        created_at: now,
        updated_at: now,
      };
      this.db.sqlite
        .prepare(
          "INSERT INTO supabase_jobs VALUES (@id,@instance_id,@action,@backup_id,@resume_running,@status,@error,@created_at,@updated_at)",
        )
        .run(job);
      return job;
    })();
  }
  recover(): void {
    this.db.sqlite
      .prepare(
        "UPDATE supabase_jobs SET status = 'queued' WHERE status = 'running'",
      )
      .run();
    this.db.sqlite
      .prepare(
        "UPDATE supabase_backups SET status = 'failed' WHERE status = 'creating'",
      )
      .run();
  }
  claim(): SupabaseJob | undefined {
    return this.db.sqlite.transaction(() => {
      const job = this.db.sqlite
        .prepare(
          "SELECT * FROM supabase_jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1",
        )
        .get() as SupabaseJob | undefined;
      if (job)
        this.db.sqlite
          .prepare(
            "UPDATE supabase_jobs SET status = 'running', updated_at = ? WHERE id = ?",
          )
          .run(new Date().toISOString(), job.id);
      return job;
    })();
  }
  update(
    id: string,
    fields: Partial<
      Pick<
        SupabaseInstance,
        | "status"
        | "error"
        | "database_port"
        | "encrypted_secrets"
        | "generation"
        | "settings_json"
      >
    >,
  ): void {
    const allowed = [
      "status",
      "error",
      "database_port",
      "encrypted_secrets",
      "generation",
      "settings_json",
    ];
    const entries = Object.entries(fields).filter(([key]) =>
      allowed.includes(key),
    );
    this.db.sqlite
      .prepare(
        `UPDATE supabase_instances SET ${entries.map(([key]) => `${key} = ?`).join(", ")}, updated_at = ? WHERE id = ?`,
      )
      .run(...entries.map(([, value]) => value), new Date().toISOString(), id);
  }
  finish(job: SupabaseJob, error?: string): void {
    this.db.sqlite
      .prepare(
        "UPDATE supabase_jobs SET status = ?, error = ?, updated_at = ? WHERE id = ?",
      )
      .run(
        error ? "failed" : "ready",
        error ?? null,
        new Date().toISOString(),
        job.id,
      );
  }
  domain(host: string): { zone_id: string | null; record_id: string | null } {
    return this.db.sqlite
      .prepare(
        "SELECT zone_id, record_id FROM supabase_domains WHERE hostname = ?",
      )
      .get(host) as { zone_id: string | null; record_id: string | null };
  }
  saveDomain(host: string, zone: string, record: string): void {
    this.db.sqlite
      .prepare(
        "UPDATE supabase_domains SET zone_id = ?, record_id = ? WHERE hostname = ?",
      )
      .run(zone, record, host);
  }
  addBackup(backup: SupabaseBackup): void {
    this.db.sqlite
      .prepare(
        "INSERT INTO supabase_backups (id,instance_id,version,generation,status,encrypted_secrets,size_bytes,sha256,created_at,settings_json) VALUES (@id,@instance_id,@version,@generation,@status,@encrypted_secrets,@size_bytes,@sha256,@created_at,@settings_json)",
      )
      .run({ ...backup, settings_json: backup.settings_json ?? null });
  }
  finishBackup(id: string, size: number, sha: string): void {
    this.db.sqlite
      .prepare(
        "UPDATE supabase_backups SET status = 'ready', size_bytes = ?, sha256 = ? WHERE id = ?",
      )
      .run(size, sha, id);
  }
  failBackup(id: string): void {
    this.db.sqlite
      .prepare("UPDATE supabase_backups SET status = 'failed' WHERE id = ?")
      .run(id);
  }
}

export function presentSupabase(
  instance: SupabaseInstance,
  store: SupabaseStore,
) {
  return {
    id: instance.id,
    name: instance.name,
    version: instance.version,
    apiUrl: `https://${instance.api_hostname}`,
    studioUrl: `https://${instance.studio_hostname}`,
    settings: JSON.parse(instance.settings_json) as SupabaseSettings,
    status: instance.status,
    databasePort: instance.database_port,
    error: instance.error,
    createdAt: instance.created_at,
    jobs: store.jobs(instance.id).map((j) => ({
      id: j.id,
      action: j.action,
      status: j.status,
      error: j.error,
      createdAt: j.created_at,
      updatedAt: j.updated_at,
      operation: store.operationSummary(j.id),
    })),
    backups: store.backups(instance.id).map((b) => ({
      id: b.id,
      status: b.status,
      version: b.version,
      sizeBytes: b.size_bytes,
      createdAt: b.created_at,
      verification: store.backupCheck(b.id),
    })),
  };
}
