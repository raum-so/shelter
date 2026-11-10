import { sampleSupabaseNetworks } from "./supabase-readiness.js";
import { SupabaseBackupPolicy } from "./supabase-backup-policy.js";
import {
  SupabaseOperations,
  SupabaseOperationError,
} from "./supabase-operations.js";
import { SupabaseWorkspace } from "./supabase-workspace.js";
import { SupabaseConnections } from "./supabase-connections.js";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { AppConfig } from "../config.js";
import type { Database } from "../lib/database.js";
import { decryptString, encryptString } from "../lib/security.js";
import { CloudflareService } from "./cloudflare.js";
import { reconcileRouting } from "./routing.js";
import {
  SupabaseStore,
  type SupabaseInstance,
  type SupabaseJob,
  type SupabaseSettings,
} from "./supabase-store.js";
import {
  supabaseServices,
  createSupabaseSecrets,
  type SupabaseSecrets,
} from "./supabase-template.js";
import {
  SupabaseRuntime,
  SupabaseNetworkCapacityError,
  type SupabaseCommand,
} from "./supabase-runtime.js";
import {
  decryptSupabaseBackup,
  encryptSupabaseBackup,
  supabaseBackupHash,
} from "./supabase-backup.js";

export class SupabaseWorker {
  private readonly store: SupabaseStore;
  private readonly connections: SupabaseConnections;
  private readonly runtime: SupabaseRuntime;
  private readonly cloudflare: CloudflareService;
  private lastReconcile = 0;
  private lastCapacitySample = 0;
  constructor(
    private readonly config: AppConfig,
    private readonly database: Database,
    command?: SupabaseCommand,
  ) {
    this.store = new SupabaseStore(database);
    this.connections = new SupabaseConnections(config, database);
    this.runtime = new SupabaseRuntime(config, command);
    this.cloudflare = new CloudflareService(config, database);
  }
  async recover() {
    const verificationCandidates = (
      this.database.sqlite
        .prepare(
          "SELECT j.id,j.instance_id FROM supabase_jobs j JOIN supabase_operations o ON o.job_id=j.id WHERE o.kind='backup-verify' AND j.status IN ('running','queued','failed')",
        )
        .all() as { id: string; instance_id: string }[]
    ).map((job) => ({
      ...this.store.get(job.instance_id),
      id: job.id.replace(/^sbj_/, "sb_"),
      generation: job.id.replace(/^sbj_/, "gen_"),
    }));
    await this.runtime.recoverHelpers([
      ...this.store.list(),
      ...verificationCandidates,
    ]);
    for (const candidate of verificationCandidates) {
      await this.runtime.stop(candidate, true);
      await this.runtime.discardVolumes(candidate);
      await this.runtime.discardNetworks(candidate);
    }
    // Remove only the worker's generated private temporary directories.
    for (const entry of fs.readdirSync(this.config.DATA_DIR))
      if (/^supabase-(request|validate|function)-[A-Za-z0-9]{6}$/.test(entry))
        fs.rmSync(path.join(this.config.DATA_DIR, entry), {
          recursive: true,
          force: true,
        });
    // A test request may mutate application data. Never replay an interrupted HTTP request.
    for (const row of this.database.sqlite
      .prepare(
        "SELECT j.id FROM supabase_jobs j JOIN supabase_operations o ON o.job_id=j.id WHERE j.status='running' AND o.kind='function-invoke'",
      )
      .all() as { id: string }[]) {
      this.database.sqlite
        .prepare(
          "UPDATE supabase_jobs SET status='failed',error='REQUEST_INTERRUPTED',updated_at=? WHERE id=?",
        )
        .run(new Date().toISOString(), row.id);
      const workspace = new SupabaseWorkspace(this.config, this.database);
      workspace.result(row.id, { error: "REQUEST_INTERRUPTED" });
      workspace.phase(row.id, "failed");
    }
    this.store.recover();
    fs.rmSync(path.join(this.config.DATA_DIR, "supabase-work"), {
      recursive: true,
      force: true,
    });
  }
  private secrets(instance: SupabaseInstance) {
    return JSON.parse(
      decryptString(instance.encrypted_secrets, this.config.APP_SECRET),
    ) as SupabaseSecrets;
  }
  private async ready(instance: SupabaseInstance, connectRouter = true) {
    const port = await this.runtime.start(
      instance,
      this.secrets(instance),
      connectRouter,
    );
    return port;
  }
  private async domains(instance: SupabaseInstance) {
    for (const host of [instance.api_hostname, instance.studio_hostname]) {
      // require ownership when recovering a partially provisioned DNS operation.
      const result = await this.cloudflare.ensurePreviewDnsRecord(host);
      this.store.saveDomain(host, result.zoneId, result.recordId);
    }
  }
  async processNext(): Promise<boolean> {
    if (Date.now() - this.lastCapacitySample >= 30_000) {
      this.lastCapacitySample = Date.now();
      await sampleSupabaseNetworks(this.config, this.database, this.runtime.command);
    }
    new SupabaseBackupPolicy(this.config, this.database).schedule();
    const job = this.store.claim();
    if (!job) {
      await this.reconcile();
      this.connections.reconcile();
      return false;
    }
    let instance = this.store.get(job.instance_id);
    const workspace = new SupabaseWorkspace(this.config, this.database);
    const operation = workspace.operation(job.id);
    let lastPhase = "checking";
    const phase = (value: string) => {
      lastPhase = value;
      return this.database.sqlite
        .prepare(
          "INSERT INTO supabase_job_progress VALUES(?,?) ON CONFLICT(job_id) DO UPDATE SET phase=excluded.phase",
        )
        .run(job.id, value);
    };
    try {
      if (operation) {
        const result = await new SupabaseOperations(
          this.config,
          this.database,
          this.runtime,
        ).run(instance, job, operation);
        workspace.result(job.id, result);
        this.store.finish(job);
        this.connections.reconcile();
        return true;
      }
      phase("checking");
      this.store.update(instance.id, { status: "provisioning", error: null });
      reconcileRouting(this.config, this.database);
      const settings = JSON.parse(instance.settings_json) as SupabaseSettings;
      if (
        job.action === "start" &&
        (settings.smtpPending || settings.authSettingsPending)
      ) {
        await this.runtime.removeAuth(instance);
        if (
          (settings.authSettingsJobId ?? settings.smtpJobId) !== job.id ||
          (settings.authSettingsPending
            ? settings.authSettingsResumeRunning
            : settings.smtpResumeRunning)
        )
          this.store.update(instance.id, {
            status: "running",
            database_port: await this.ready(instance),
          });
        else this.store.update(instance.id, { status: "stopped" });
        if (settings.smtpPending)
          settings.smtpAppliedRevision = settings.smtpRevision ?? null;
        settings.smtpPending = false;
        settings.authSettingsPending = false;
        delete settings.authSettingsJobId;
        delete settings.authSettingsResumeRunning;
        delete settings.smtpResumeRunning;
        delete settings.smtpJobId;
        this.store.update(instance.id, {
          settings_json: JSON.stringify(settings),
        });
      } else if (job.action === "start") {
        await this.runtime.preflight(
          instance,
          this.store.list().filter((i) => i.status !== "archived").length,
        );
        const functionJob = this.database.sqlite
          .prepare(
            "SELECT name, encrypted_source FROM supabase_function_jobs WHERE job_id = ?",
          )
          .get(job.id) as
          { name: string; encrypted_source: string } | undefined;
        if (functionJob)
          await this.runtime.writeFunction(
            instance,
            functionJob.name,
            decryptString(functionJob.encrypted_source, this.config.APP_SECRET),
            job.id,
          );
        phase("starting");
        const port = await this.ready(instance);
        phase("routing");
        // A function update uses the instance's already-provisioned hostnames.
        // Like SMTP updates, it must not depend on refreshing provider credentials.
        if (
          !settings.functionsPending ||
          ![instance.api_hostname, instance.studio_hostname].every(
            (host) => this.store.domain(host).record_id,
          )
        )
          await this.domains(instance);
        settings.functionsPending = false;
        this.store.update(instance.id, {
          status: "running",
          database_port: port,
          settings_json: JSON.stringify(settings),
        });
      } else if (job.action === "stop" || job.action === "archive") {
        await this.runtime.stop(instance);
        if (job.action === "archive") {
          for (const host of [
            instance.api_hostname,
            instance.studio_hostname,
          ]) {
            const domain = this.store.domain(host);
            if (domain.record_id)
              await this.cloudflare.deleteDnsRecord(
                domain.zone_id,
                domain.record_id,
                host,
              );
          }
        }
        this.store.update(instance.id, {
          status: job.action === "archive" ? "archived" : "stopped",
        });
      } else if (job.action === "backup") {
        phase("backup");
        await this.backup(instance, job);
        phase("starting");
        if (job.resume_running === 1)
          this.store.update(instance.id, {
            status: "running",
            database_port: await this.ready(instance),
          });
        else this.store.update(instance.id, { status: "stopped" });
      } else if (job.action === "restore") {
        phase("restoring");
        instance = await this.restore(instance, job);
        await new SupabaseOperations(
          this.config,
          this.database,
          this.runtime,
        ).sync(instance);
        this.store.update(instance.id, {
          status: "running",
          database_port: await this.ready(instance),
        });
      } else if (job.action === "rotate-keys") {
        await this.runtime.revokeSessions(instance);
        const secrets = this.secrets(instance);
        const replacement = createSupabaseSecrets();
        secrets.jwtSecret = replacement.jwtSecret;
        secrets.anonKey = replacement.anonKey;
        secrets.serviceKey = replacement.serviceKey;
        this.store.update(instance.id, {
          encrypted_secrets: encryptString(
            JSON.stringify(secrets),
            this.config.APP_SECRET,
          ),
        });
        instance = this.store.get(instance.id);
        await this.runtime.stop(instance, true);
        if (job.resume_running === 1)
          this.store.update(instance.id, {
            status: "running",
            database_port: await this.ready(instance),
          });
        else this.store.update(instance.id, { status: "stopped" });
      } else if (job.action === "rotate") {
        const secrets = this.secrets(instance);
        secrets.studioPassword = randomBytes(24).toString("hex");
        this.store.update(instance.id, {
          encrypted_secrets: encryptString(
            JSON.stringify(secrets),
            this.config.APP_SECRET,
          ),
        });
        instance = this.store.get(instance.id);
        await this.runtime.removeGateway(instance);
        if (job.resume_running === 1)
          this.store.update(instance.id, {
            status: "running",
            database_port: await this.ready(instance),
          });
        else {
          await this.runtime.stop(instance);
          this.store.update(instance.id, { status: "stopped" });
        }
      }
      if (job.action === "backup") {
        phase("uploading");
        const id = job.id.replace(/^sbj_/, "sbb_");
        const backup = this.store.backups(instance.id).find((b) => b.id === id);
        if (backup?.sha256)
          await new SupabaseBackupPolicy(this.config, this.database).upload(
            instance.id,
            id,
            backup.sha256,
          );
      }
      phase("complete");
      this.store.finish(job);
      this.connections.reconcile();
    } catch (error) {
      // Provider output, Docker errors and SQL can contain connection secrets.
      // Keep public errors bounded and free of subprocess output.
      if (operation) {
        const code =
          error instanceof SupabaseOperationError
            ? error.code
            : "OPERATION_FAILED";
        workspace.result(job.id, { ok: false, error: code });
        workspace.phase(job.id, "failed");
        if (error instanceof SupabaseOperationError && !error.preserved)
          this.store.update(instance.id, { status: "error", error: code });
        this.store.finish(job, code);
        return true;
      }
      if (
        ["backup", "restore"].includes(job.action) &&
        job.resume_running === 1
      ) {
        try {
          this.store.update(instance.id, {
            status: "running",
            database_port: await this.ready(this.store.get(instance.id)),
          });
        } catch {
          /* Availability is not assumed after a failed recovery. */
        }
      }
      const message =
        error instanceof SupabaseNetworkCapacityError
          ? "SUPABASE_NETWORK_CAPACITY"
          : lastPhase === "uploading"
            ? "BACKUP_UPLOAD_FAILED"
            : lastPhase === "routing"
              ? "DOMAIN_SETUP_FAILED"
              : job.action === "backup"
                ? "BACKUP_CREATE_FAILED"
                : job.action === "restore"
                  ? "BACKUP_RESTORE_FAILED"
                  : lastPhase === "checking"
                    ? "CAPACITY_CHECK_FAILED"
                    : "SERVICE_START_FAILED";
      phase("failed");
      if (
        !["backup", "restore"].includes(job.action) ||
        this.store.get(instance.id).status === "provisioning"
      )
        this.store.update(instance.id, { status: "error", error: message });
      this.store.finish(job, message);
    } finally {
      this.database.sqlite
        .prepare("DELETE FROM supabase_function_jobs WHERE job_id = ?")
        .run(job.id);
      reconcileRouting(this.config, this.database);
    }
    if (
      job.action === "backup" &&
      this.store.get(instance.id).status === "running"
    ) {
      const backupId = job.id.replace(/^sbj_/, "sbb_");
      if (
        this.store
          .backups(instance.id)
          .some((b) => b.id === backupId && b.status === "ready") &&
        new SupabaseBackupPolicy(this.config, this.database).verificationDue(
          instance.id,
        )
      )
        workspace.enqueue(instance.id, "backup-verify", { backupId });
    }
    return true;
  }
  private async backup(instance: SupabaseInstance, job: SupabaseJob) {
    const id = job.id.replace(/^sbj_/, "sbb_");
    if (
      this.store
        .backups(instance.id)
        .some((b) => b.id === id && b.status === "ready")
    )
      return;
    const directory = path.join(
      this.config.DATA_DIR,
      "supabase-backups",
      instance.id,
    );
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const source = path.join(directory, `${id}.tmp`);
    const target = path.join(directory, `${id}.enc`);
    fs.rmSync(source, { force: true });
    fs.rmSync(target, { force: true });
    if (!this.store.backups(instance.id).some((b) => b.id === id))
      this.store.addBackup({
        id,
        instance_id: instance.id,
        version: instance.version,
        generation: instance.generation,
        status: "creating",
        encrypted_secrets: instance.encrypted_secrets,
        settings_json: instance.settings_json,
        size_bytes: null,
        sha256: null,
        created_at: new Date().toISOString(),
      });
    await this.runtime.diskBudget(20 * 1024 ** 3);
    await this.runtime.stop(instance);
    try {
      await this.runtime.snapshot(instance, source);
      await this.runtime.diskBudget(fs.statSync(source).size);
      await encryptSupabaseBackup(
        source,
        target,
        this.config.APP_SECRET,
        `${instance.id}:${instance.version}:${id}`,
      );
      this.store.finishBackup(
        id,
        fs.statSync(target).size,
        await supabaseBackupHash(target),
      );
    } catch (error) {
      this.store.failBackup(id);
      throw error;
    } finally {
      fs.rmSync(source, { force: true });
    }
  }
  private async restore(
    instance: SupabaseInstance,
    job: SupabaseJob,
  ): Promise<SupabaseInstance> {
    const backup = this.store
      .backups(instance.id)
      .find(
        (b) =>
          b.id === job.backup_id &&
          b.status === "ready" &&
          b.version === instance.version,
      );
    if (!backup || !/^sbb_[a-f0-9]{32}$/.test(backup.id))
      throw new Error("Invalid backup");
    const generation = job.id.replace(/^sbj_/, "gen_");
    if (instance.generation === generation) return instance;
    const file = path.join(
      this.config.DATA_DIR,
      "supabase-backups",
      instance.id,
      `${backup.id}.enc`,
    );
    if ((await supabaseBackupHash(file)) !== backup.sha256)
      throw new Error("Backup checksum mismatch");
    await this.runtime.diskBudget(
      Math.max(20 * 1024 ** 3, (backup.size_bytes ?? 0) * 4),
    );
    const temporary = `${file}.${job.id}.tmp`;
    fs.rmSync(temporary, { force: true });
    // Authenticate the entire archive before any container or persistent volume changes.
    await decryptSupabaseBackup(
      file,
      temporary,
      this.config.APP_SECRET,
      `${instance.id}:${instance.version}:${backup.id}`,
    );
    const restoredSettings = JSON.parse(
      backup.settings_json ?? instance.settings_json,
    ) as SupabaseSettings;
    const restoredSecrets = JSON.parse(
      decryptString(backup.encrypted_secrets, this.config.APP_SECRET),
    ) as SupabaseSecrets;
    if (!backup.settings_json) {
      // Legacy snapshots did not capture SMTP metadata. Never combine old credentials with a new provider.
      delete restoredSettings.smtp;
      restoredSettings.smtpSource = "disabled";
      restoredSecrets.smtpPassword = "";
    }
    restoredSettings.smtpPending = false;
    restoredSettings.authSettingsPending = false;
    delete restoredSettings.authSettingsJobId;
    delete restoredSettings.authSettingsResumeRunning;
    delete restoredSettings.smtpResumeRunning;
    delete restoredSettings.smtpJobId;
    const candidate = {
      ...instance,
      generation,
      settings_json: JSON.stringify(restoredSettings),
      encrypted_secrets: encryptString(
        JSON.stringify(restoredSecrets),
        this.config.APP_SECRET,
      ),
    };
    try {
      await this.runtime.stop(instance, true);
      await this.runtime.discardVolumes(candidate);
      await this.runtime.snapshot(candidate, temporary, true);
      await this.ready(candidate, false);
      this.store.update(instance.id, {
        generation,
        encrypted_secrets: candidate.encrypted_secrets,
        settings_json: candidate.settings_json,
      });
      return candidate;
    } catch (error) {
      await this.runtime.stop(candidate, true);
      // Old volumes were never modified; make the previous generation available again.
      await this.ready(instance);
      throw error;
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  private async reconcile() {
    if (Date.now() - this.lastReconcile < 15_000) return;
    this.lastReconcile = Date.now();
    for (const instance of this.store
      .list()
      .filter((i) => i.status === "running")) {
      try {
        for (const service of supabaseServices(instance)) {
          const state = (await this.runtime.inspect(instance, service))?.State;
          if (!state?.Running || state.Health?.Status === "unhealthy")
            throw new Error("Unhealthy service");
        }
        await this.runtime.connectRouter(instance);
      } catch {
        this.store.update(instance.id, {
          status: "error",
          error:
            "A Supabase component is unavailable. Data was retained; restart the instance after checking its health.",
        });
        reconcileRouting(this.config, this.database);
      }
    }
  }
}
