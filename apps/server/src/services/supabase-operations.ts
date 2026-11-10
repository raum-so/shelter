import { SupabaseBackupPolicy } from "./supabase-backup-policy.js";
import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "../config.js";
import type { Database } from "../lib/database.js";
import { decryptString } from "../lib/security.js";
import { SupabaseConnections } from "./supabase-connections.js";
import {
  SupabaseStore,
  type SupabaseInstance,
  type SupabaseJob,
} from "./supabase-store.js";
import {
  SupabaseWorkspace,
  functionHash,
  type WorkspaceOperation,
} from "./supabase-workspace.js";
import { SupabaseRuntime } from "./supabase-runtime.js";
import {
  decryptSupabaseBackup,
  supabaseBackupHash,
} from "./supabase-backup.js";
import type { SupabaseSecrets } from "./supabase-template.js";

export class SupabaseOperationError extends Error {
  constructor(
    readonly code: string,
    readonly preserved = true,
  ) {
    super(code);
  }
}
export class SupabaseOperations {
  private readonly workspace: SupabaseWorkspace;
  private readonly store: SupabaseStore;
  constructor(
    private readonly config: AppConfig,
    private readonly db: Database,
    private readonly runtime: SupabaseRuntime,
  ) {
    this.workspace = new SupabaseWorkspace(config, db);
    this.store = new SupabaseStore(db);
  }
  private secrets(instance: SupabaseInstance) {
    return JSON.parse(
      decryptString(instance.encrypted_secrets, this.config.APP_SECRET),
    ) as SupabaseSecrets;
  }
  async sync(instance: SupabaseInstance) {
    const files = await this.runtime.functionFiles(instance);
    this.db.sqlite.transaction(() => {
      for (const [name, source] of files)
        this.workspace.record(instance, name, source, "imported");
      for (const head of this.workspace.catalog(instance).functions)
        if (!files.has(head.name))
          this.workspace.removeHead(instance, head.name);
    })();
    return files;
  }
  async run(
    instance: SupabaseInstance,
    job: SupabaseJob,
    op: WorkspaceOperation,
  ) {
    const input = this.workspace.input(op),
      phase = (value: string) => this.workspace.phase(job.id, value);
    phase("checking");
    if (op.kind === "backup-upload") {
      const backup = this.store
        .backups(instance.id)
        .find((b) => b.id === input.backupId && b.status === "ready");
      if (
        new SupabaseBackupPolicy(this.config, this.db).get(instance.id)
          .destination !== "s3"
      )
        throw new SupabaseOperationError("BACKUP_DESTINATION_REQUIRED");
      if (!backup?.sha256) throw new SupabaseOperationError("BACKUP_INVALID");
      phase("uploading");
      await new SupabaseBackupPolicy(this.config, this.db).upload(
        instance.id,
        backup.id,
        backup.sha256,
      );
      return { ok: true };
    }
    if (op.kind === "backup-destination-check") {
      await new SupabaseBackupPolicy(this.config, this.db).verifyDestination(
        instance.id,
      );
      return { ok: true };
    }
    if (op.kind === "functions-sync") {
      await this.sync(instance);
      return { ok: true };
    }
    if (op.kind === "function-deploy" || op.kind === "function-delete") {
      if (!input.name) throw new SupabaseOperationError("FUNCTION_INVALID");
      const files = await this.sync(instance),
        previous = files.get(input.name);
      // A worker may stop after the atomic file switch but before committing its result.
      if (
        ["activating", "health"].includes(op.phase) &&
        ((op.kind === "function-deploy" && previous === input.source) ||
          (op.kind === "function-delete" && previous === undefined))
      ) {
        await this.runtime.healthy(instance, "functions");
        return { ok: true };
      }
      if (
        (previous !== undefined ? functionHash(previous) : null) !==
        (input.expectedHash ?? null)
      )
        throw new SupabaseOperationError("FUNCTION_CHANGED");
      const settings = JSON.parse(instance.settings_json) as {
        functionsEnabled?: boolean;
      };
      if (!settings.functionsEnabled) {
        settings.functionsEnabled = true;
        instance = { ...instance, settings_json: JSON.stringify(settings) };
        this.store.update(instance.id, {
          settings_json: instance.settings_json,
        });
      }
      const secrets = this.secrets(instance);
      // Upgrade the stateless router first; no DNS operation or database restart is needed.
      await this.runtime.start(instance, secrets);
      if (op.kind === "function-deploy") {
        if (!input.source) throw new SupabaseOperationError("FUNCTION_INVALID");
        phase("validating");
        try {
          await this.runtime.validateFunction(
            instance,
            input.source,
            job.id,
            secrets,
          );
        } catch {
          throw new SupabaseOperationError("FUNCTION_VALIDATION_FAILED");
        }
      }
      phase("activating");
      try {
        if (op.kind === "function-delete")
          await this.runtime.removeFunction(instance, input.name);
        else
          await this.runtime.writeFunction(
            instance,
            input.name,
            input.source!,
            job.id,
          );
        phase("health");
        await this.runtime.healthy(instance, "functions");
      } catch {
        phase("rolling-back");
        try {
          if (previous !== undefined)
            await this.runtime.writeFunction(
              instance,
              input.name,
              previous,
              job.id,
            );
          else await this.runtime.removeFunction(instance, input.name);
          await this.runtime.healthy(instance, "functions");
        } catch {
          throw new SupabaseOperationError("FUNCTION_ROLLBACK_FAILED", false);
        }
        throw new SupabaseOperationError("FUNCTION_ACTIVATION_FAILED");
      }
      if (op.kind === "function-delete")
        this.workspace.removeHead(instance, input.name);
      else
        this.workspace.record(instance, input.name, input.source!, "deployed");
      return { ok: true };
    }
    if (op.kind === "function-invoke") {
      if (!input.name || !/^[a-z][a-z0-9_-]{0,62}$/.test(input.name))
        throw new SupabaseOperationError("FUNCTION_INVALID");
      phase("request");
      const secrets = this.secrets(instance);
      const startedAt = new Date().toISOString();
      const result = await this.runtime.request(instance, {
        url: `http://functions:9000/${input.name}${input.query ? `?${new URLSearchParams(input.query).toString()}` : ""}`,
        method: input.method,
        body: ["GET", "HEAD"].includes(input.method ?? "")
          ? undefined
          : input.body,
        token: input.auth === "none" ? undefined : secrets.anonKey,
      });
      let body = result.body;
      let logs = await this.runtime.functionLogs(instance, startedAt);
      for (const secret of Object.values(secrets))
        if (typeof secret === "string" && secret.length >= 8) {
          body = body.replaceAll(secret, "[redacted]");
          logs = logs.replaceAll(secret, "[redacted]");
        }
      return { ...result, body, logs, auth: input.auth };
    }
    if (op.kind === "connection-check") {
      const connections = new SupabaseConnections(this.config, this.db),
        link = connections
          .list()
          .find(
            (c) =>
              c.projectId === input.projectId && c.instanceId === instance.id,
          );
      const project = input.projectId
        ? this.db.getProject(input.projectId)
        : undefined;
      const deployment = project?.active_deployment_id
        ? this.db.getDeployment(project.active_deployment_id)
        : undefined;
      if (!link || link.status !== "ready" || !deployment?.runtime_container)
        throw new SupabaseOperationError("CONNECTION_NOT_READY");
      // Check ownership before entering an app's network namespace.
      const inspection = await this.runtime.command("docker", [
        "inspect",
        "--format",
        '{{index .Config.Labels "shelter.project"}}|{{index .Config.Labels "shelter.deployment"}}',
        deployment.runtime_container,
      ]);
      if (inspection.stdout.trim() !== `${project!.id}|${deployment.id}`)
        throw new SupabaseOperationError("CONNECTION_NOT_READY");
      phase("request");
      let ok = false;
      try {
        const response = await this.runtime.request(instance, {
          url: `https://${instance.api_hostname}/auth/v1/health`,
          token: this.secrets(instance).anonKey,
          network: `container:${deployment.runtime_container}`,
        });
        ok = response.status === 200;
      } catch {
        /* A failed probe is a connection result, not a database failure. */
      }
      connections.recordCheck(project!.id, deployment.id, ok);
      return { ok };
    }
    if (op.kind === "backup-verify") {
      const backup = this.store
        .backups(instance.id)
        .find((b) => b.id === input.backupId && b.status === "ready");
      if (!backup || backup.version !== instance.version)
        throw new SupabaseOperationError("BACKUP_INVALID");
      const file = path.join(
          this.config.DATA_DIR,
          "supabase-backups",
          instance.id,
          `${backup.id}.enc`,
        ),
        temporary = `${file}.${job.id}.verify`;
      const candidate = {
        ...instance,
        // Container and network names are based on instance ID, not generation.
        // A verification must have its own identity as well as its own volumes.
        id: job.id.replace(/^sbj_/, "sb_"),
        generation: job.id.replace(/^sbj_/, "gen_"),
        encrypted_secrets: backup.encrypted_secrets,
        settings_json: backup.settings_json ?? instance.settings_json,
      };
      let created = false;
      try {
        phase("verifying");
        if ((await supabaseBackupHash(file)) !== backup.sha256)
          throw new Error("Invalid checksum");
        await this.runtime.diskBudget(
          Math.max(20 * 1024 ** 3, (backup.size_bytes ?? 0) * 4),
        );
        await decryptSupabaseBackup(
          file,
          temporary,
          this.config.APP_SECRET,
          `${instance.id}:${instance.version}:${backup.id}`,
        );
        await this.runtime.preflight(
          candidate,
          new SupabaseStore(this.db)
            .list()
            .filter((i) => i.status !== "archived").length + 1,
        );
        phase("test-restore");
        // This deterministic generation belongs only to this verification job.
        await this.runtime.stop(candidate, true);
        await this.runtime.discardVolumes(candidate);
        created = true;
        // Restored cron jobs and webhooks must never call the live app or external services.
        await this.runtime.ensureTestNetworks(candidate);
        await this.runtime.snapshot(candidate, temporary, true);
        await this.runtime.startIsolated(candidate, this.secrets(candidate));
        const response = await this.runtime.request(candidate, {
          url: "http://auth:9999/health",
          token: this.secrets(candidate).anonKey,
        });
        if (response.status !== 200) throw new Error("Restore probe failed");
        const now = new Date().toISOString();
        this.db.sqlite
          .prepare(
            "INSERT INTO supabase_backup_checks(backup_id,checked_at,restored_at) VALUES(?,?,?) ON CONFLICT(backup_id) DO UPDATE SET checked_at=excluded.checked_at,restored_at=excluded.restored_at,error=NULL",
          )
          .run(backup.id, now, now);
        return { ok: true, restoredAt: now };
      } catch {
        this.db.sqlite
          .prepare(
            "INSERT INTO supabase_backup_checks(backup_id,error) VALUES(?,'BACKUP_VERIFY_FAILED') ON CONFLICT(backup_id) DO UPDATE SET error=excluded.error",
          )
          .run(backup.id);
        throw new SupabaseOperationError("BACKUP_VERIFY_FAILED");
      } finally {
        fs.rmSync(temporary, { force: true });
        if (created) {
          await this.runtime.stop(candidate, true);
          await this.runtime.discardVolumes(candidate);
          await this.runtime.discardNetworks(candidate);
        }
      }
    }
    throw new SupabaseOperationError("OPERATION_FAILED");
  }
}
