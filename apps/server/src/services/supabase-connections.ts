import { createHash } from "node:crypto";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { Database } from "../lib/database.js";
import { badRequest, conflict, notFound, HttpError } from "../lib/errors.js";
import {
  decryptString,
  encryptString,
  newId,
  validEnvironmentKey,
} from "../lib/security.js";
import { parseStoredProjectAnalysis } from "./project-analysis.js";
import { assertEnvironmentSize } from "../routes/projects.js";
import {
  SupabaseStore,
  type SupabaseInstance,
  type SupabaseSettings,
} from "./supabase-store.js";
import type { SupabaseSecrets } from "./supabase-template.js";
import type { ProjectRow } from "../types/models.js";

export const SupabaseSiteUrl = z
  .url()
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.hash &&
      !/[\r\n\0,*]/.test(value)
    );
  }, "Use an HTTPS URL without credentials, fragments or commas");
export const SupabaseConnectionInput = z
  .object({
    siteUrl: SupabaseSiteUrl.optional(),
    projectId: z.string().min(1).max(128),
    urlVariable: z.string().min(1).max(100).optional(),
    keyVariable: z.string().min(1).max(100).optional(),
    replace: z.boolean().default(false),
  })
  .strict();
interface ConnectionRow {
  site_url: string | null;
  project_id: string;
  instance_id: string;
  url_variable: string;
  key_variable: string;
  status: "pending" | "configured" | "error";
  expected_hash: string;
  applied_hash: string | null;
  applied_at: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
}
export class SupabaseConnections {
  private readonly store: SupabaseStore;
  constructor(
    private readonly config: AppConfig,
    private readonly db: Database,
  ) {
    this.store = new SupabaseStore(db);
  }
  private rows() {
    return this.db.sqlite
      .prepare("SELECT * FROM supabase_connections ORDER BY created_at")
      .all() as ConnectionRow[];
  }
  private row(projectId: string) {
    return this.db.sqlite
      .prepare("SELECT * FROM supabase_connections WHERE project_id=?")
      .get(projectId) as ConnectionRow | undefined;
  }
  private hash(values: Array<string | null>) {
    return createHash("sha256").update(JSON.stringify(values)).digest("hex");
  }
  private environment(projectId: string, keys: string[]) {
    const entries = this.db.listEnvironment(projectId);
    return keys.map((key) => {
      const row = entries.find((entry) => entry.key === key);
      return row
        ? decryptString(row.encrypted_value, this.config.APP_SECRET)
        : null;
    });
  }
  private desired(instance: SupabaseInstance) {
    const secrets = JSON.parse(
      decryptString(instance.encrypted_secrets, this.config.APP_SECRET),
    ) as SupabaseSecrets;
    return [`https://${instance.api_hostname}`, secrets.anonKey];
  }
  private supportsConnection(project: ProjectRow) {
    const analysis = parseStoredProjectAnalysis(project.source_analysis_json);
    const application = analysis?.applications.find(
      (app) => app.rootDirectory === project.root_directory,
    );
    const active = project.active_deployment_id
      ? this.db.getDeployment(project.active_deployment_id)
      : undefined;
    return (
      active?.runtime_kind !== "files" && application?.framework !== "files"
    );
  }
  defaults(project: ProjectRow) {
    const keys = this.db.listEnvironment(project.id).map((entry) => entry.key);
    const analysis = parseStoredProjectAnalysis(project.source_analysis_json);
    const application = analysis?.applications.find(
      (app) => app.rootDirectory === project.root_directory,
    );
    const active = project.active_deployment_id
      ? this.db.getDeployment(project.active_deployment_id)
      : undefined;
    const existingPrefix = [
      "NEXT_PUBLIC_",
      "VITE_",
      "REACT_APP_",
      "PUBLIC_",
      "",
    ].find(
      (prefix) =>
        keys.includes(`${prefix}SUPABASE_URL`) ||
        keys.includes(`${prefix}SUPABASE_ANON_KEY`),
    );
    let prefix = existingPrefix ?? "";
    if (existingPrefix === undefined) {
      if (application?.framework === "next" || active?.runtime_kind === "next")
        prefix = "NEXT_PUBLIC_";
      else if (
        application?.framework === "vite" ||
        (application?.framework === "react" &&
          Array.isArray(application.evidence) &&
          application.evidence.some((value) => value.includes("Vite")))
      )
        prefix = "VITE_";
      else if (application?.framework === "react") prefix = "REACT_APP_";
      else if (application?.framework === "astro") prefix = "PUBLIC_";
    }
    return {
      urlVariable: `${prefix}SUPABASE_URL`,
      keyVariable: `${prefix}SUPABASE_ANON_KEY`,
    };
  }
  options() {
    return this.db
      .listProjects()
      .filter(
        (project) =>
          this.db.getMutableProject(project.id) &&
          this.supportsConnection(project),
      )
      .map((project) => {
        const domain = this.db
          .listDomains(project.id)
          .find((entry) => entry.status === "active");
        return {
          id: project.id,
          busy: this.db.hasActiveProductionDeployment(project.id),
          name: project.name,
          website: domain
            ? `https://${domain.hostname}${project.static_base_path ?? ""}`
            : null,
          ...this.defaults(project),
        };
      });
  }
  list() {
    return this.rows().map((row) => this.present(row));
  }
  private hasRedirect(instance: SupabaseInstance, siteUrl: string | null) {
    const settings = JSON.parse(instance.settings_json) as SupabaseSettings;
    return (
      !siteUrl ||
      settings.siteUrl === siteUrl ||
      settings.redirectUrls.includes(siteUrl)
    );
  }
  recordCheck(projectId: string, deploymentId: string, ok: boolean) {
    const row = this.row(projectId);
    if (!row?.applied_hash)
      throw conflict("Connection is not ready", "CONNECTION_NOT_READY");
    const instance = this.store.get(row.instance_id);
    const fingerprint = this.hash([
      row.applied_hash,
      instance.generation,
      instance.encrypted_secrets,
    ]);
    this.db.sqlite
      .prepare(
        "INSERT INTO supabase_connection_checks(project_id,instance_id,deployment_id,fingerprint,checked_at,ok) VALUES(?,?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET instance_id=excluded.instance_id,deployment_id=excluded.deployment_id,fingerprint=excluded.fingerprint,checked_at=excluded.checked_at,ok=excluded.ok",
      )
      .run(
        projectId,
        row.instance_id,
        deploymentId,
        fingerprint,
        new Date().toISOString(),
        ok ? 1 : 0,
      );
  }
  private present(row: ConnectionRow) {
    const project = this.db.getProject(row.project_id);
    const instance = this.store.get(row.instance_id);
    const actualHash = this.hash(
      this.environment(row.project_id, [row.url_variable, row.key_variable]),
    );
    let status:
      | "pending"
      | "error"
      | "needs_update"
      | "redeploy_required"
      | "ready"
      | "unavailable" =
      row.status === "configured" ? "redeploy_required" : row.status;
    let errorCode = row.error_code;
    if (row.status === "configured") {
      if (actualHash !== row.applied_hash) {
        status = "needs_update";
        errorCode = "ENV_CHANGED";
      } else if (this.hash(this.desired(instance)) !== row.applied_hash) {
        status = "needs_update";
        errorCode = "KEYS_CHANGED";
      } else if (!this.hasRedirect(instance, row.site_url)) {
        status = "needs_update";
        errorCode = "AUTH_REDIRECT_MISSING";
      } else {
        const active = project?.active_deployment_id
          ? this.db.getDeployment(project.active_deployment_id)
          : undefined;
        if (
          active?.status === "ready" &&
          active.trigger !== "rollback" &&
          row.applied_at &&
          active.created_at >= row.applied_at
        )
          status = "ready";
      }
    }
    if (row.status === "configured" && instance.status !== "running")
      status = "unavailable";
    const check = this.db.sqlite
      .prepare("SELECT * FROM supabase_connection_checks WHERE project_id=?")
      .get(row.project_id) as
      | {
          instance_id: string;
          deployment_id: string;
          fingerprint: string;
          checked_at: string;
          ok: number;
        }
      | undefined;
    const validCheck =
      status === "ready" &&
      check?.instance_id === instance.id &&
      check.deployment_id === project?.active_deployment_id &&
      check.fingerprint ===
        this.hash([
          row.applied_hash,
          instance.generation,
          instance.encrypted_secrets,
        ]);
    return {
      verification: validCheck
        ? { ok: check.ok === 1, checkedAt: check.checked_at }
        : null,
      siteUrl: row.site_url,
      projectId: row.project_id,
      projectName: project?.name ?? row.project_id,
      instanceId: instance.id,
      instanceName: instance.name,
      apiUrl: `https://${instance.api_hostname}`,
      urlVariable: row.url_variable,
      keyVariable: row.key_variable,
      status,
      errorCode,
      serviceStatus: instance.status,
      updatedAt: row.updated_at,
    };
  }
  reserve(instanceId: string, input: z.infer<typeof SupabaseConnectionInput>) {
    return this.db.sqlite
      .transaction(() => {
        const project = this.db.getMutableProject(input.projectId);
        if (!project || !this.supportsConnection(project))
          throw conflict("Project is unavailable", "PROJECT_UNAVAILABLE");
        const instance = this.store.get(instanceId);
        if (instance.status === "archived")
          throw conflict("Reactivate the instance first", "INSTANCE_ARCHIVED");
        const defaults = this.defaults(project);
        const keys = [
          input.urlVariable ?? defaults.urlVariable,
          input.keyVariable ?? defaults.keyVariable,
        ];
        if (
          keys[0] === keys[1] ||
          keys.some(
            (key) =>
              !validEnvironmentKey(key) ||
              ["PORT", "HOSTNAME", "NODE_ENV"].includes(key),
          )
        )
          throw badRequest("Invalid variable names");
        const previous = this.row(project.id);
        if (
          previous &&
          (previous.url_variable !== keys[0] ||
            previous.key_variable !== keys[1])
        )
          throw conflict(
            "Disconnect before changing variable names",
            "CONNECTION_VARIABLES_CHANGED",
          );
        if (previous && previous.instance_id !== instanceId && !input.replace)
          throw conflict(
            "App is already linked to another instance",
            "CONNECTION_EXISTS",
          );
        const actual = this.environment(project.id, keys);
        const desired = this.desired(instance);
        const actualHash = this.hash(actual);
        const owned =
          previous?.instance_id === instanceId &&
          previous.applied_hash === actualHash;
        if (
          !input.replace &&
          !owned &&
          actual.some(
            (value, index) => value !== null && value !== desired[index],
          )
        )
          throw conflict(
            "Confirm replacement of existing variables",
            "ENV_EXISTS",
          );
        const retained = this.db
          .listEnvironment(project.id)
          .filter((entry) => !keys.includes(entry.key));
        if (retained.length + 2 > 200)
          throw conflict("Too many app variables", "ENV_LIMIT");
        assertEnvironmentSize([
          ...retained.map((entry) => ({
            key: entry.key,
            value: decryptString(entry.encrypted_value, this.config.APP_SECRET),
          })),
          ...keys.map((key, index) => ({ key, value: desired[index]! })),
        ]);
        const siteUrl =
          input.siteUrl ??
          this.options().find((option) => option.id === project.id)?.website ??
          null;
        if (
          previous?.instance_id === instanceId &&
          previous.site_url === siteUrl &&
          previous.status === "configured" &&
          previous.applied_hash === actualHash &&
          this.hasRedirect(instance, siteUrl) &&
          actualHash === this.hash(desired)
        )
          return this.present(previous);
        const now = new Date().toISOString();
        this.db.sqlite
          .prepare(
            `INSERT INTO supabase_connections (project_id,instance_id,url_variable,key_variable,status,expected_hash,applied_hash,applied_at,error_code,created_at,updated_at,site_url)
        VALUES (?,?,?,?,'pending',?,NULL,NULL,NULL,?,?,?) ON CONFLICT(project_id) DO UPDATE SET instance_id=excluded.instance_id,url_variable=excluded.url_variable,key_variable=excluded.key_variable,site_url=excluded.site_url,status='pending',expected_hash=excluded.expected_hash,applied_hash=NULL,applied_at=NULL,error_code=NULL,updated_at=excluded.updated_at`,
          )
          .run(
            project.id,
            instanceId,
            keys[0],
            keys[1],
            actualHash,
            now,
            now,
            siteUrl,
          );
        return this.present(this.row(project.id)!);
      })
      .immediate();
  }
  apply(projectId: string) {
    return this.db.sqlite
      .transaction(() => {
        const row = this.row(projectId);
        if (!row) throw notFound("Connection not found");
        if (row.status !== "pending") return this.present(row);
        const instance = this.store.get(row.instance_id);
        if (
          instance.status !== "running" ||
          this.store
            .jobs(instance.id)
            .some((job) => ["queued", "running"].includes(job.status))
        )
          return this.present(row);
        if (!this.db.getMutableProject(projectId))
          throw conflict("Project is unavailable", "PROJECT_UNAVAILABLE");
        if (this.db.hasActiveProductionDeployment(projectId))
          return this.present(row);
        const keys = [row.url_variable, row.key_variable];
        if (this.hash(this.environment(projectId, keys)) !== row.expected_hash)
          throw conflict(
            "App variables changed while the connection was pending",
            "ENV_CHANGED",
          );
        const settings = JSON.parse(instance.settings_json) as SupabaseSettings;
        if (
          row.site_url &&
          settings.siteUrl !== row.site_url &&
          !settings.redirectUrls.includes(row.site_url)
        ) {
          if (settings.redirectUrls.length >= 20)
            throw conflict(
              "Review sign-in destinations before linking another app",
              "REDIRECT_LIMIT",
            );
          settings.redirectUrls.push(row.site_url);
          settings.authSettingsPending = true;
          settings.authSettingsResumeRunning = true;
          const job = this.store.enqueue(instance.id, "start");
          settings.authSettingsJobId = job.id;
          this.store.update(instance.id, {
            settings_json: JSON.stringify(settings),
          });
          return this.present(row);
        }
        const desired = this.desired(instance);
        const now = new Date().toISOString();
        const entries = this.db
          .listEnvironment(projectId)
          .filter((entry) => !keys.includes(entry.key));
        keys.forEach((key, index) =>
          entries.push({
            id: newId("env"),
            project_id: projectId,
            key,
            encrypted_value: encryptString(
              desired[index]!,
              this.config.APP_SECRET,
            ),
            created_at: now,
            updated_at: now,
          }),
        );
        if (entries.length > 200)
          throw conflict("Too many app variables", "ENV_LIMIT");
        assertEnvironmentSize(
          entries.map((entry) => ({
            key: entry.key,
            value: decryptString(entry.encrypted_value, this.config.APP_SECRET),
          })),
        );
        if (!this.db.replaceEnvironmentForMutableProject(projectId, entries))
          throw conflict("App is busy", "PROJECT_UNAVAILABLE");
        this.db.sqlite
          .prepare(
            "UPDATE supabase_connections SET status='configured', applied_hash=?, applied_at=?, error_code=NULL, updated_at=? WHERE project_id=?",
          )
          .run(this.hash(desired), now, now, projectId);
        return this.present(this.row(projectId)!);
      })
      .immediate();
  }
  connect(instanceId: string, input: z.infer<typeof SupabaseConnectionInput>) {
    return this.db.sqlite
      .transaction(() => {
        this.reserve(instanceId, input);
        return this.apply(input.projectId);
      })
      .immediate();
  }
  reconcile() {
    for (const row of this.rows().filter(
      (entry) => entry.status === "pending",
    )) {
      try {
        this.apply(row.project_id);
      } catch (error) {
        const code =
          error instanceof HttpError ? error.code : "CONNECTION_FAILED";
        this.db.sqlite
          .prepare(
            "UPDATE supabase_connections SET status='error',error_code=?,updated_at=? WHERE project_id=? AND status='pending'",
          )
          .run(code, new Date().toISOString(), row.project_id);
      }
    }
  }
  disconnect(instanceId: string, projectId: string) {
    return this.db.sqlite
      .transaction(() => {
        const row = this.row(projectId);
        if (!row || row.instance_id !== instanceId)
          throw notFound("Connection not found");
        const keys = [row.url_variable, row.key_variable];
        const owned =
          row.applied_hash !== null &&
          this.hash(this.environment(projectId, keys)) === row.applied_hash;
        if (
          owned &&
          !this.db.replaceEnvironmentForMutableProject(
            projectId,
            this.db
              .listEnvironment(projectId)
              .filter((entry) => !keys.includes(entry.key)),
          )
        )
          throw conflict("App is busy", "PROJECT_UNAVAILABLE");
        this.db.sqlite
          .prepare("DELETE FROM supabase_connections WHERE project_id=?")
          .run(projectId);
        return { environmentRetained: !owned, redeployRequired: owned };
      })
      .immediate();
  }
}
