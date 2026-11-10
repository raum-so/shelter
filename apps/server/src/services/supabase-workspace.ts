import { createHash } from "node:crypto";
import type { AppConfig } from "../config.js";
import type { Database } from "../lib/database.js";
import { conflict, notFound } from "../lib/errors.js";
import { decryptString, encryptString, newId } from "../lib/security.js";
import { SupabaseStore, type SupabaseInstance } from "./supabase-store.js";

export const SUPABASE_WORKSPACE_SCHEMA = `
CREATE TABLE IF NOT EXISTS supabase_job_progress (job_id TEXT PRIMARY KEY REFERENCES supabase_jobs(id), phase TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS supabase_operations (
 job_id TEXT PRIMARY KEY REFERENCES supabase_jobs(id), kind TEXT NOT NULL,
 phase TEXT NOT NULL DEFAULT 'queued', encrypted_input TEXT NOT NULL,
 encrypted_result TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS supabase_function_versions (
 id TEXT PRIMARY KEY, instance_id TEXT NOT NULL REFERENCES supabase_instances(id),
 name TEXT NOT NULL, source_hash TEXT NOT NULL, encrypted_source TEXT NOT NULL,
 origin TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS supabase_function_history ON supabase_function_versions(instance_id,name,created_at);
CREATE TABLE IF NOT EXISTS supabase_function_heads (
 instance_id TEXT NOT NULL REFERENCES supabase_instances(id), generation TEXT NOT NULL,
 name TEXT NOT NULL, version_id TEXT NOT NULL REFERENCES supabase_function_versions(id),
 PRIMARY KEY(instance_id,generation,name)
);
CREATE TABLE IF NOT EXISTS supabase_backup_policies (
 instance_id TEXT PRIMARY KEY REFERENCES supabase_instances(id), enabled INTEGER NOT NULL DEFAULT 0,
 hour_utc INTEGER NOT NULL DEFAULT 3, next_at TEXT, encrypted_destination TEXT,
 updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS supabase_backup_checks (
 backup_id TEXT PRIMARY KEY REFERENCES supabase_backups(id), checked_at TEXT,
 restored_at TEXT, offsite_at TEXT, error TEXT
);
CREATE TABLE IF NOT EXISTS supabase_connection_checks (
 project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
 instance_id TEXT NOT NULL REFERENCES supabase_instances(id), deployment_id TEXT NOT NULL,
 fingerprint TEXT NOT NULL, checked_at TEXT NOT NULL, ok INTEGER NOT NULL
);
`;

export type WorkspaceKind =
  | "functions-sync"
  | "function-deploy"
  | "function-delete"
  | "function-invoke"
  | "connection-check"
  | "backup-verify"
  | "backup-destination-check"
  | "backup-upload";
export interface WorkspaceInput {
  name?: string | undefined;
  source?: string | undefined;
  expectedHash?: string | null | undefined;
  method?: string | undefined;
  body?: string | undefined;
  query?: string | undefined;
  auth?: "anon" | "none" | undefined;
  projectId?: string | undefined;
  backupId?: string | undefined;
}
export interface WorkspaceOperation {
  job_id: string;
  kind: WorkspaceKind;
  phase: string;
  encrypted_input: string;
  encrypted_result: string | null;
  created_at: string;
}
export interface FunctionVersion {
  id: string;
  instance_id: string;
  name: string;
  source_hash: string;
  encrypted_source: string;
  origin: string;
  created_at: string;
}
export const functionHash = (source: string) =>
  createHash("sha256").update(source).digest("hex");

export class SupabaseWorkspace {
  private readonly store: SupabaseStore;
  constructor(
    private readonly config: AppConfig,
    private readonly db: Database,
  ) {
    this.store = new SupabaseStore(db);
  }
  operation(jobId: string) {
    return this.db.sqlite
      .prepare("SELECT * FROM supabase_operations WHERE job_id=?")
      .get(jobId) as WorkspaceOperation | undefined;
  }
  input(op: WorkspaceOperation): WorkspaceInput {
    return JSON.parse(
      decryptString(op.encrypted_input, this.config.APP_SECRET),
    ) as WorkspaceInput;
  }
  enqueue(instanceId: string, kind: WorkspaceKind, input: WorkspaceInput = {}) {
    return this.db.sqlite.transaction(() => {
      const instance = this.store.get(instanceId);
      if (
        instance.status !== "running" &&
        ![
          "backup-verify",
          "backup-destination-check",
          "backup-upload",
        ].includes(kind)
      )
        throw conflict("Start this instance first", "INSTANCE_NOT_RUNNING");
      const job = this.store.enqueue(instanceId, "start");
      this.db.sqlite
        .prepare(
          "INSERT INTO supabase_operations(job_id,kind,encrypted_input,created_at) VALUES(?,?,?,?)",
        )
        .run(
          job.id,
          kind,
          encryptString(JSON.stringify(input), this.config.APP_SECRET),
          new Date().toISOString(),
        );
      return job;
    })();
  }
  phase(jobId: string, phase: string) {
    this.db.sqlite
      .prepare("UPDATE supabase_operations SET phase=? WHERE job_id=?")
      .run(phase, jobId);
  }
  result(jobId: string, result: unknown) {
    this.db.sqlite
      .prepare(
        "UPDATE supabase_operations SET encrypted_result=?,encrypted_input=?,phase='complete' WHERE job_id=?",
      )
      .run(
        encryptString(JSON.stringify(result), this.config.APP_SECRET),
        encryptString("{}", this.config.APP_SECRET),
        jobId,
      );
  }
  readResult(instanceId: string, jobId: string) {
    if (!this.store.jobs(instanceId).some((j) => j.id === jobId))
      throw notFound("Operation not found");
    const op = this.operation(jobId);
    return op?.encrypted_result
      ? (JSON.parse(
          decryptString(op.encrypted_result, this.config.APP_SECRET),
        ) as unknown)
      : null;
  }
  versions(instanceId: string, name: string) {
    return this.db.sqlite
      .prepare(
        "SELECT * FROM supabase_function_versions WHERE instance_id=? AND name=? ORDER BY created_at DESC, rowid DESC LIMIT 50",
      )
      .all(instanceId, name) as FunctionVersion[];
  }
  version(instanceId: string, name: string, id: string) {
    const row = this.db.sqlite
      .prepare(
        "SELECT * FROM supabase_function_versions WHERE instance_id=? AND name=? AND id=?",
      )
      .get(instanceId, name, id) as FunctionVersion | undefined;
    if (!row) throw notFound("Function version not found");
    return row;
  }
  head(instance: SupabaseInstance, name: string) {
    return this.db.sqlite
      .prepare(
        "SELECT v.* FROM supabase_function_heads h JOIN supabase_function_versions v ON v.id=h.version_id WHERE h.instance_id=? AND h.generation=? AND h.name=?",
      )
      .get(instance.id, instance.generation, name) as
      FunctionVersion | undefined;
  }
  source(version: FunctionVersion) {
    return decryptString(version.encrypted_source, this.config.APP_SECRET);
  }
  record(
    instance: SupabaseInstance,
    name: string,
    source: string,
    origin: string,
  ) {
    const hash = functionHash(source);
    const current = this.head(instance, name);
    if (current?.source_hash === hash) return current;
    const row: FunctionVersion = {
      id: newId("sfv"),
      instance_id: instance.id,
      name,
      source_hash: hash,
      encrypted_source: encryptString(source, this.config.APP_SECRET),
      origin,
      created_at: new Date().toISOString(),
    };
    this.db.sqlite.transaction(() => {
      this.db.sqlite
        .prepare(
          "INSERT INTO supabase_function_versions VALUES(@id,@instance_id,@name,@source_hash,@encrypted_source,@origin,@created_at)",
        )
        .run(row);
      this.db.sqlite
        .prepare(
          "INSERT INTO supabase_function_heads VALUES(?,?,?,?) ON CONFLICT(instance_id,generation,name) DO UPDATE SET version_id=excluded.version_id",
        )
        .run(instance.id, instance.generation, name, row.id);
    })();
    return row;
  }
  removeHead(instance: SupabaseInstance, name: string) {
    this.db.sqlite
      .prepare(
        "DELETE FROM supabase_function_heads WHERE instance_id=? AND generation=? AND name=?",
      )
      .run(instance.id, instance.generation, name);
  }
  catalog(instance: SupabaseInstance) {
    const rows = this.db.sqlite
      .prepare(
        "SELECT v.* FROM supabase_function_heads h JOIN supabase_function_versions v ON v.id=h.version_id WHERE h.instance_id=? AND h.generation=? ORDER BY h.name",
      )
      .all(instance.id, instance.generation) as FunctionVersion[];
    const synced = this.db.sqlite
      .prepare(
        "SELECT j.updated_at FROM supabase_jobs j JOIN supabase_operations o ON o.job_id=j.id WHERE j.instance_id=? AND o.kind='functions-sync' AND j.status='ready' ORDER BY j.updated_at DESC LIMIT 1",
      )
      .get(instance.id) as { updated_at: string } | undefined;
    return {
      functions: rows.map((v) => ({
        name: v.name,
        versionId: v.id,
        hash: v.source_hash,
        updatedAt: v.created_at,
      })),
      removed: (
        this.db.sqlite
          .prepare(
            "SELECT v.name,v.id FROM supabase_function_versions v WHERE v.instance_id=? AND NOT EXISTS(SELECT 1 FROM supabase_function_heads h WHERE h.instance_id=v.instance_id AND h.generation=? AND h.name=v.name) AND v.rowid=(SELECT max(v2.rowid) FROM supabase_function_versions v2 WHERE v2.instance_id=v.instance_id AND v2.name=v.name) ORDER BY v.name",
          )
          .all(instance.id, instance.generation) as {
          name: string;
          id: string;
        }[]
      ).map((v) => ({ name: v.name, versionId: v.id })),
      syncedAt: synced?.updated_at ?? null,
    };
  }
  checkExpected(
    instance: SupabaseInstance,
    name: string,
    expected: string | null | undefined,
  ) {
    const head = this.head(instance, name);
    if (
      (head && expected === undefined) ||
      (expected !== undefined && (head?.source_hash ?? null) !== expected)
    )
      throw conflict(
        "This function changed. Reload before deploying.",
        "FUNCTION_CHANGED",
      );
  }
}
