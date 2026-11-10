export interface SupabaseInstance {
  id: string;
  name: string;
  version: string;
  apiUrl: string;
  studioUrl: string;
  status:
    "queued" | "provisioning" | "running" | "stopped" | "error" | "archived";
  databasePort: number | null;
  error: string | null;
  createdAt: string;
  settings: {
    functionsEnabled?: boolean;
    smtpSource?: "global" | "custom" | "disabled";
    smtpPending?: boolean;
    smtpAppliedRevision?: string | null;
    siteUrl: string;
    redirectUrls: string[];
    smtp?: {
      host: string;
      port: number;
      user: string;
      sender: string;
      adminEmail: string;
    };
  };
  jobs: SupabaseJob[];
  backups: {
    id: string;
    status: string;
    version: string;
    sizeBytes: number | null;
    createdAt: string;
    verification?: {
      checkedAt: string | null;
      restoredAt: string | null;
      offsiteAt: string | null;
      error: string | null;
    } | null;
  }[];
}
export interface SupabaseCreateInput {
  connection?: SupabaseConnectionInput;
  smtpSource?: "global" | "custom" | "disabled";
  name: string;
  apiHostname: string;
  studioHostname: string;
  siteUrl: string;
  redirectUrls: string[];
  smtp?: {
    host: string;
    port: number;
    user: string;
    sender: string;
    adminEmail: string;
    password: string;
  };
}
export interface SupabaseCredentials {
  apiUrl: string;
  anonKey: string;
  serviceRoleKey: string;
  studioUsername: string;
  studioPassword: string;
  databaseUser: string;
  databaseName: string;
  databasePassword: string;
  databasePort: number | null;
}

export interface SupabaseConnection {
  projectId: string;
  projectName: string;
  instanceId: string;
  instanceName: string;
  apiUrl: string;
  urlVariable: string;
  keyVariable: string;
  siteUrl: string | null;
  status:
    | "pending"
    | "error"
    | "needs_update"
    | "redeploy_required"
    | "ready"
    | "unavailable";
  errorCode: string | null;
  verification?: { ok: boolean; checkedAt: string } | null;
  serviceStatus: SupabaseInstance["status"];
  updatedAt: string;
}
export interface SupabaseConnectionInput {
  projectId: string;
  urlVariable?: string;
  keyVariable?: string;
  siteUrl?: string;
  replace?: boolean;
}
export interface SupabaseConnectionCatalog {
  connections: SupabaseConnection[];
  projects: {
    busy: boolean;
    id: string;
    name: string;
    website: string | null;
    urlVariable: string;
    keyVariable: string;
  }[];
}

export interface SupabaseJob {
  id: string;
  action: string;
  status: string;
  error: string | null;
  createdAt?: string;
  updatedAt?: string;
  operation?: { kind: string; phase: string };
}
export interface SupabaseFunction {
  name: string;
  versionId: string;
  hash: string;
  updatedAt: string;
}
export interface SupabaseFunctionCatalog {
  functions: SupabaseFunction[];
  removed?: { name: string; versionId: string }[];
  syncedAt: string | null;
}
export interface SupabaseFunctionDetail {
  name: string;
  source: string | null;
  hash: string | null;
  versionId: string | null;
  versions: {
    id: string;
    hash: string;
    origin: string;
    createdAt: string;
    active: boolean;
  }[];
}
export interface SupabaseInvocation {
  logs?: string;
  status: number;
  body: string;
  durationMs: number;
  auth: "anon" | "none";
}
export interface SupabaseBackupPolicy {
  verifyWeekly: boolean;
  enabled: boolean;
  hourUtc: number;
  nextAt: string | null;
  destination: "local" | "s3";
  s3: {
    endpoint: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    hasSecret?: boolean;
    secretAccessKey?: string;
  } | null;
}

export interface SupabaseReadiness {
  status: "ready" | "blocked" | "unknown";
  sampledAt: string | null;
  checks: Record<"memory" | "storage" | "cpu" | "docker" | "network" | "cloudflare" | "worker", boolean | null>;
  available: { memoryBytes: number | null; storageBytes: number | null; networks: number | null };
}
