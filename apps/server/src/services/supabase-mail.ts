import type { z } from "zod";
import type { AppConfig } from "../config.js";
import type { Database } from "../lib/database.js";
import { badRequest, conflict } from "../lib/errors.js";
import { decryptString, encryptString } from "../lib/security.js";
import {
  SmtpService,
  type SmtpConfiguration,
  SupabaseSmtpInput,
} from "./smtp.js";
import {
  SupabaseStore,
  type SupabaseInstance,
  type SupabaseSettings,
} from "./supabase-store.js";
import type { SupabaseSecrets } from "./supabase-template.js";

export function smtpSource(
  settings: SupabaseSettings,
): "global" | "custom" | "disabled" {
  return settings.smtpSource ?? (settings.smtp ? "custom" : "disabled");
}
export function withGlobalSmtp(
  settings: SupabaseSettings,
  value: SmtpConfiguration | null,
): SupabaseSettings {
  const { smtp: _smtp, ...rest } = settings;
  return {
    ...rest,
    smtpSource: "global",
    smtpRevision: value?.revision ?? null,
    ...(value?.enabled
      ? {
          smtp: {
            host: value.host,
            port: value.port,
            user: value.user,
            sender: value.fromName,
            adminEmail: value.fromEmail,
          },
        }
      : {}),
  };
}
export class SupabaseMailService {
  private readonly store: SupabaseStore;
  private readonly smtp: SmtpService;
  constructor(
    private readonly config: AppConfig,
    private readonly db: Database,
  ) {
    this.store = new SupabaseStore(db);
    this.smtp = new SmtpService(config, db);
  }
  targets() {
    const revision = this.smtp.state().revision;
    return this.store
      .list()
      .filter((instance) => instance.status !== "archived")
      .map((instance) => {
        const settings = JSON.parse(instance.settings_json) as SupabaseSettings;
        return {
          id: instance.id,
          name: instance.name,
          source: smtpSource(settings),
          outdated:
            smtpSource(settings) === "global" &&
            (settings.smtpAppliedRevision !== revision ||
              settings.smtpPending === true),
          busy: this.store
            .jobs(instance.id)
            .some((job) => ["queued", "running"].includes(job.status)),
        };
      });
  }
  applyGlobal(revision: string | null) {
    return this.db.sqlite.transaction(() => {
      const value = this.smtp.snapshot(revision);
      const targets = this.targets().filter(
        (target) => target.source === "global" && target.outdated,
      );
      if (targets.some((target) => target.busy))
        throw conflict(
          "Wait for current instance operations before applying SMTP",
          "SMTP_INSTANCES_BUSY",
        );
      return {
        queued: targets.map(
          (target) =>
            this.queue(
              this.store.get(target.id),
              withGlobalSmtp(
                JSON.parse(
                  this.store.get(target.id).settings_json,
                ) as SupabaseSettings,
                value,
              ),
              value?.enabled ? value.password : "",
            ).id,
        ),
      };
    })();
  }
  async selectSource(id: string, input: z.infer<typeof SupabaseSmtpInput>) {
    const instance = this.store.get(id);
    const old = JSON.parse(instance.settings_json) as SupabaseSettings;
    if (instance.status === "archived")
      throw conflict("Reactivate the instance first", "INSTANCE_ARCHIVED");
    if (
      this.store
        .jobs(id)
        .some((job) => ["queued", "running"].includes(job.status))
    )
      throw conflict("An operation is already active", "INSTANCE_BUSY");
    if (input.source === "custom") {
      const secrets = JSON.parse(
        decryptString(instance.encrypted_secrets, this.config.APP_SECRET),
      ) as SupabaseSecrets;
      const sameServer =
        smtpSource(old) === "custom" &&
        old.smtp?.host === input.smtp.host &&
        old.smtp.user === input.smtp.user;
      const password =
        input.smtp.password ?? (sameServer ? secrets.smtpPassword : "");
      if (!password)
        throw badRequest(
          "Supply credentials for this SMTP server",
          "SMTP_PASSWORD_REQUIRED",
        );
      await this.smtp.verifyConnection({ ...input.smtp, password });
      return this.db.sqlite.transaction(() => {
        const current = this.store.get(id);
        if (
          current.settings_json !== instance.settings_json ||
          current.encrypted_secrets !== instance.encrypted_secrets ||
          current.generation !== instance.generation ||
          current.status !== instance.status
        )
          throw conflict(
            "Instance changed during SMTP verification",
            "SMTP_CHANGED",
          );
        const {
          password: _password,
          fromEmail,
          fromName,
          ...server
        } = input.smtp;
        const next: SupabaseSettings = {
          ...old,
          smtpSource: "custom",
          smtpRevision: null,
          smtp: { ...server, adminEmail: fromEmail, sender: fromName },
        };
        return { jobId: this.queue(current, next, password).id };
      })();
    }
    return this.db.sqlite.transaction(() => {
      const value = input.source === "global" ? this.smtp.snapshot() : null;
      const current = this.store.get(id);
      const next = withGlobalSmtp(
        JSON.parse(current.settings_json) as SupabaseSettings,
        value,
      );
      next.smtpSource = input.source;
      return {
        jobId: this.queue(current, next, value?.enabled ? value.password : "")
          .id,
      };
    })();
  }
  private queue(
    instance: SupabaseInstance,
    next: SupabaseSettings,
    password: string,
  ) {
    if (instance.status === "archived")
      throw conflict("Reactivate the instance first", "INSTANCE_ARCHIVED");
    const old = JSON.parse(instance.settings_json) as SupabaseSettings;
    next.smtpPending = true;
    next.smtpResumeRunning =
      instance.status === "stopped"
        ? false
        : old.smtpPending
          ? old.smtpResumeRunning === true
          : instance.status === "running";
    const secrets = JSON.parse(
      decryptString(instance.encrypted_secrets, this.config.APP_SECRET),
    ) as SupabaseSecrets;
    secrets.smtpPassword = password;
    // The job and its desired configuration commit together; a failed retry keeps the same snapshot.
    const job = this.store.enqueue(instance.id, "start");
    next.smtpJobId = job.id;
    this.store.update(instance.id, {
      settings_json: JSON.stringify(next),
      encrypted_secrets: encryptString(
        JSON.stringify(secrets),
        this.config.APP_SECRET,
      ),
    });
    return job;
  }
}
