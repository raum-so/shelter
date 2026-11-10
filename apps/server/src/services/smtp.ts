import { randomUUID } from "node:crypto";
import { domainToASCII } from "node:url";
import nodemailer from "nodemailer";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { Database } from "../lib/database.js";
import { badRequest, conflict } from "../lib/errors.js";
import { decryptString, encryptString } from "../lib/security.js";

const clean = z
  .string()
  .max(4096)
  .refine((value) => !/[\r\n\0]/.test(value));
export const SmtpInput = z
  .object({
    expectedRevision: z.uuid().nullable(),
    enabled: z.boolean().default(true),
    provider: z.enum(["custom", "resend", "zoho"]).default("custom"),
    host: z
      .string()
      .trim()
      .max(253)
      .transform((value) => domainToASCII(value.toLowerCase()))
      .refine(
        (value) =>
          /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/.test(
            value,
          ),
        "Use an SMTP DNS hostname",
      ),
    // GoTrue infers implicit TLS from 465. Keep the shared transport equally strict.
    port: z.literal(465).default(465),
    user: clean.pipe(z.string().min(1)),
    password: clean.pipe(z.string().min(1)).optional(),
    fromEmail: z.email().max(320),
    fromName: clean.pipe(z.string().trim().min(1).max(160)),
  })
  .strict();
export const InstanceSmtpInput = SmtpInput.omit({
  expectedRevision: true,
  enabled: true,
  provider: true,
});
export const SupabaseSmtpInput = z.discriminatedUnion("source", [
  z.object({ source: z.literal("global") }).strict(),
  z.object({ source: z.literal("disabled") }).strict(),
  z.object({ source: z.literal("custom"), smtp: InstanceSmtpInput }).strict(),
]);
export interface SmtpConfiguration {
  revision: string;
  enabled: boolean;
  provider: "custom" | "resend" | "zoho";
  host: string;
  port: 465;
  user: string;
  password: string;
  fromEmail: string;
  fromName: string;
}
const CONFIG = "smtp.configuration";
const VERIFIED = "smtp.verified_revision";
export class SmtpService {
  constructor(
    private readonly config: AppConfig,
    private readonly db: Database,
  ) {}
  configuration(): SmtpConfiguration | null {
    const value = this.db.getSetting(CONFIG);
    return value
      ? (JSON.parse(
          decryptString(value, this.config.APP_SECRET),
        ) as SmtpConfiguration)
      : null;
  }
  state() {
    const configuration = this.configuration();
    if (!configuration)
      return {
        configured: false as const,
        revision: null,
        verified: false,
        configuration: null,
      };
    const { password: _password, ...publicConfiguration } = configuration;
    return {
      configured: true as const,
      revision: configuration.revision,
      verified: this.db.getSetting(VERIFIED) === configuration.revision,
      configuration: { ...publicConfiguration, passwordConfigured: true },
    };
  }
  save(input: z.infer<typeof SmtpInput>) {
    return this.db.sqlite.transaction(() => {
      const previous = this.configuration();
      if ((previous?.revision ?? null) !== input.expectedRevision)
        throw conflict(
          "SMTP configuration changed; reload before saving",
          "SMTP_CHANGED",
        );
      if (
        !input.password &&
        (!previous ||
          previous.host !== input.host ||
          previous.user !== input.user)
      )
        throw badRequest(
          "Supply credentials for this SMTP server",
          "SMTP_PASSWORD_REQUIRED",
        );
      const { expectedRevision: _expected, ...settings } = input;
      const configuration: SmtpConfiguration = {
        ...settings,
        password: input.password ?? previous!.password,
        revision: randomUUID(),
      };
      this.db.setSetting(
        CONFIG,
        encryptString(JSON.stringify(configuration), this.config.APP_SECRET),
      );
      this.db.deleteSetting(VERIFIED);
      return this.state();
    })();
  }
  snapshot(expectedRevision?: string | null) {
    const value = this.configuration();
    if (
      expectedRevision !== undefined &&
      (value?.revision ?? null) !== expectedRevision
    )
      throw conflict("SMTP configuration changed", "SMTP_CHANGED");
    if (value?.enabled && this.db.getSetting(VERIFIED) !== value.revision)
      throw conflict(
        "Verify the saved SMTP connection first",
        "SMTP_NOT_VERIFIED",
      );
    return value;
  }
  private transport(
    value: Pick<SmtpConfiguration, "host" | "port" | "user" | "password">,
  ) {
    return nodemailer.createTransport({
      host: value.host,
      port: value.port,
      secure: true,
      auth: { user: value.user, pass: value.password },
      tls: {
        minVersion: "TLSv1.2",
        servername: value.host,
        rejectUnauthorized: true,
      },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
      dnsTimeout: 5_000,
      logger: false,
      debug: false,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
  }
  private failure(error: unknown): never {
    const code =
      error && typeof error === "object" && "code" in error
        ? error.code
        : undefined;
    if (code === "EAUTH")
      throw badRequest("SMTP authentication failed", "SMTP_AUTH_FAILED");
    if (code === "ETLS" || code === "ESOCKET")
      throw badRequest("SMTP TLS connection failed", "SMTP_TLS_FAILED");
    throw badRequest("SMTP connection failed", "SMTP_CONNECTION_FAILED");
  }
  async verifyConnection(
    value: Pick<SmtpConfiguration, "host" | "port" | "user" | "password">,
  ) {
    const transport = this.transport(value);
    try {
      if (!(await transport.verify()))
        throw new Error("SMTP verification rejected");
    } catch (error) {
      this.failure(error);
    } finally {
      transport.close();
    }
  }
  async verify(revision: string) {
    const value = this.configuration();
    if (!value || value.revision !== revision)
      throw conflict("SMTP configuration changed", "SMTP_CHANGED");
    if (!value.enabled)
      throw badRequest(
        "Enable SMTP before testing the connection",
        "SMTP_DISABLED",
      );
    await this.verifyConnection(value);
    return this.db.sqlite.transaction(() => {
      if (this.configuration()?.revision !== revision)
        throw conflict(
          "SMTP configuration changed during verification",
          "SMTP_CHANGED",
        );
      this.db.setSetting(VERIFIED, revision);
      return this.state();
    })();
  }
  async sendTest(revision: string, recipient: string) {
    const value = this.snapshot(revision);
    if (!value?.enabled) throw badRequest("SMTP is disabled", "SMTP_DISABLED");
    const target = z.email().safeParse(recipient);
    if (!target.success)
      throw badRequest(
        "The administrator email is not a deliverable address",
        "SMTP_RECIPIENT_INVALID",
      );
    const transport = this.transport(value);
    try {
      const result = await transport.sendMail({
        from: { name: value.fromName, address: value.fromEmail },
        to: target.data,
        subject: "Shelter SMTP test",
        text: "Your saved SMTP configuration accepted this Shelter test message. Check its arrival to confirm delivery.",
        disableFileAccess: true,
        disableUrlAccess: true,
      });
      if (!result.accepted?.length)
        throw new Error("SMTP did not accept the message");
      return { accepted: true };
    } catch (error) {
      return this.failure(error);
    } finally {
      transport.close();
    }
  }
}
