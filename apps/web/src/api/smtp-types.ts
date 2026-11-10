export interface SmtpConfiguration {
  enabled: boolean;
  provider: "custom" | "resend" | "zoho";
  host: string;
  port: 465;
  user: string;
  fromEmail: string;
  fromName: string;
}
export interface SmtpState {
  configured: boolean;
  revision: string | null;
  verified: boolean;
  configuration:
    | (SmtpConfiguration & { passwordConfigured: boolean; revision: string })
    | null;
  instances: {
    id: string;
    name: string;
    source: "global" | "custom" | "disabled";
    outdated: boolean;
    busy: boolean;
  }[];
}
export type SmtpInput = SmtpConfiguration & {
  expectedRevision: string | null;
  password?: string;
};

export type SupabaseSmtpInput =
  | { source: "global" | "disabled" }
  | {
      source: "custom";
      smtp: Omit<SmtpConfiguration, "enabled" | "provider"> & {
        password?: string;
      };
    };
