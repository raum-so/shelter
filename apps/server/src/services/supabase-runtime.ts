import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import {
  runCommand,
  type CommandOptions,
  type CommandResult,
} from "../lib/command.js";
import type { SupabaseInstance, SupabaseSettings } from "./supabase-store.js";
import {
  SERVICE_ORDER,
  SUPABASE_ASSETS,
  supabaseNames,
  supabaseTemplate,
  supabaseServices,
  type ServiceName,
  type SupabaseSecrets,
} from "./supabase-template.js";

export type SupabaseCommand = (
  command: string,
  args: string[],
  options?: CommandOptions,
) => Promise<CommandResult>;
export class SupabaseNetworkCapacityError extends Error {
  constructor() {
    super("SUPABASE_NETWORK_CAPACITY");
  }
}
const memory: Record<ServiceName, string> = {
  db: "2g",
  auth: "256m",
  rest: "256m",
  realtime: "512m",
  imgproxy: "256m",
  storage: "512m",
  meta: "256m",
  studio: "512m",
  "api-gw": "256m",
  functions: "512m",
};
export const SUPABASE_VOLUMES = [
  "db",
  "db-config",
  "storage",
  "snippets",
  "gateway",
  "functions",
  "functions-router",
] as const;
interface ContainerInspection {
  Id: string;
  Config: {
    Labels: Record<string, string>;
    Image: string;
    Healthcheck?: { Test?: string[] };
  };
  State: { Running: boolean; Status: string; Health?: { Status: string } };
  NetworkSettings: {
    Networks: Record<string, unknown>;
    Ports: Record<string, { HostIp: string; HostPort: string }[] | null>;
  };
}

export class SupabaseRuntime {
  constructor(
    private readonly config: AppConfig,
    readonly command: SupabaseCommand = runCommand,
  ) {}
  private async docker(args: string[], options: CommandOptions = {}) {
    return this.command("docker", args, {
      timeoutMs: 60_000,
      maxOutputChars: 64_000,
      ...options,
    });
  }
  private labels(instance: SupabaseInstance, extra: string) {
    return [
      "--label",
      "shelter.managed=true",
      "--label",
      `shelter.supabase=${instance.id}`,
      "--label",
      `shelter.purpose=${extra}`,
    ];
  }
  async inspect(
    instance: SupabaseInstance,
    service: ServiceName,
  ): Promise<ContainerInspection | undefined> {
    const result = await this.docker(
      ["container", "inspect", supabaseNames(instance).container(service)],
      { allowFailure: true },
    );
    if (result.exitCode !== 0) {
      if (/No such (object|container)/i.test(result.stderr)) return undefined;
      throw new Error("Cannot inspect managed container");
    }
    const value = (JSON.parse(result.stdout) as ContainerInspection[])[0];
    if (
      !value ||
      value.Config.Labels["shelter.managed"] !== "true" ||
      value.Config.Labels["shelter.supabase"] !== instance.id ||
      value.Config.Labels["shelter.purpose"] !== `supabase-${service}`
    )
      throw new Error("Supabase container ownership mismatch");
    if (service === "rest" && value.State.Running) {
      // The pinned PostgREST image has no shell; Docker CLI health commands
      // always use CMD-SHELL. Execute its native readiness probe directly.
      let ready = false;
      try {
        const probe = await this.docker(
          ["exec", value.Id, "postgrest", "--ready"],
          {
            allowFailure: true,
            timeoutMs: 10_000,
          },
        );
        ready = probe.exitCode === 0;
      } catch {
        // A timed-out probe must not be mistaken for a healthy service.
      }
      value.State.Health = { Status: ready ? "healthy" : "unhealthy" };
    }
    return value;
  }
  private async resource(
    instance: SupabaseInstance,
    type: "network" | "volume",
    name: string,
    purpose: string,
    internal = false,
  ) {
    const result = await this.docker([type, "inspect", name], {
      allowFailure: true,
    });
    if (result.exitCode !== 0) {
      if (!/no such (network|volume)|not found/i.test(result.stderr))
        throw new Error("Cannot inspect managed resource");
      if (type === "network") {
        await this.createNetwork(instance, name, purpose, internal);
      } else {
        await this.docker([
          type,
          "create",
          ...this.labels(instance, purpose),
          name,
        ]);
      }
    }
    const verified = await this.docker([type, "inspect", name]);
    const values = JSON.parse(verified.stdout) as {
      Labels: Record<string, string>;
      Internal?: boolean;
    }[];
    if (
      values[0]?.Labels["shelter.supabase"] !== instance.id ||
      values[0]?.Labels["shelter.purpose"] !== purpose
    )
      throw new Error("Supabase resource ownership mismatch");
    if (internal && values[0]?.Internal !== true)
      throw new Error("Verification network must block external access");
  }
  async ensureTestNetworks(instance: SupabaseInstance) {
    const names = supabaseNames(instance);
    await this.resource(
      instance,
      "network",
      names.backend,
      "supabase-backend",
      true,
    );
    await this.resource(
      instance,
      "network",
      names.frontend,
      "supabase-frontend",
      true,
    );
  }
  private async createNetwork(
    instance: SupabaseInstance,
    name: string,
    purpose: string,
    internal = false,
  ) {
    const pool = this.config.SUPABASE_NETWORK_POOL;
    const first = createHash("sha256").update(name).digest()[0]!;
    // Only use an operator-reserved pool; guessing host/VPN address space can
    // silently break outbound access. Docker rejects overlapping subnets.
    for (let attempt = 0; attempt < (pool ? 256 : 1); attempt++) {
      const subnet = pool
        ? `${pool.split(".").slice(0, 2).join(".")}.${(first + attempt) % 256}.0/24`
        : undefined;
      const result = await this.docker(
        [
          "network",
          "create",
          "--driver",
          "bridge",
          ...(internal ? ["--internal"] : []),
          ...this.labels(instance, purpose),
          ...(subnet ? ["--subnet", subnet] : []),
          name,
        ],
        { allowFailure: true },
      );
      if (result.exitCode === 0) return;
      if (pool && /pool overlaps with other one/i.test(result.stderr)) continue;
      if (
        /all predefined address pools have been fully subnetted/i.test(
          result.stderr,
        )
      )
        throw new SupabaseNetworkCapacityError();
      throw new Error("Cannot create managed Supabase network");
    }
    throw new SupabaseNetworkCapacityError();
  }
  async recoverHelpers(instances: SupabaseInstance[]) {
    for (const type of ["container", "volume"] as const) {
      const listed = await this.docker(
        type === "container"
          ? [
              "ps",
              "-a",
              "--filter",
              "label=shelter.managed=true",
              "--format",
              "{{.Names}}",
            ]
          : [
              "volume",
              "ls",
              "--filter",
              "label=shelter.managed=true",
              "--format",
              "{{.Name}}",
            ],
      );
      for (const name of listed.stdout.split("\n").filter(Boolean)) {
        const owner = instances.find((instance) => {
          const prefix = supabaseNames(instance).prefix;
          return (
            name.startsWith(`${prefix}-snapshot-`) ||
            name.startsWith(`${prefix}-config-`)
          );
        });
        if (!owner || !/^[a-z0-9_-]+$/.test(name)) continue;
        const inspection = await this.docker([
          type,
          "inspect",
          name,
          "--format",
          type === "container" ? "{{json .Config.Labels}}" : "{{json .Labels}}",
        ]);
        const labels = JSON.parse(inspection.stdout) as Record<string, string>;
        if (
          labels["shelter.supabase"] !== owner.id ||
          !["supabase-transfer", "supabase-config"].includes(
            labels["shelter.purpose"] ?? "",
          )
        )
          throw new Error("Helper ownership mismatch");
        await this.docker(
          type === "container"
            ? ["rm", "--force", name]
            : ["volume", "rm", name],
        );
      }
    }
  }
  async preflight(instance: SupabaseInstance, reservedInstances: number) {
    const result = await this.docker(["info", "--format", "{{json .}}"]);
    const info = JSON.parse(result.stdout) as {
      MemTotal: number;
      NCPU: number;
      OSType: string;
      Architecture: string;
    };
    if (
      !Number.isSafeInteger(info.MemTotal) ||
      !Number.isSafeInteger(info.NCPU) ||
      info.OSType !== "linux" ||
      !["x86_64", "aarch64", "arm64", "amd64"].includes(info.Architecture)
    )
      throw new Error("Supabase requires Linux amd64 or arm64");
    if (
      info.MemTotal < 7.5 * 1024 ** 3 ||
      info.MemTotal < (reservedInstances * 5.5 + 2) * 1024 ** 3 ||
      info.NCPU < 4
    )
      throw new Error(
        "Supabase requires at least 8 GB RAM and 4 CPUs with capacity for existing instances",
      );
    const stats = await this.docker([
      "stats",
      "--no-stream",
      "--format",
      "{{.Name}}|{{.MemUsage}}",
    ]);
    let used = 0;
    for (const line of stats.stdout.split("\n")) {
      const [name, usage] = line.split("|");
      if (name?.startsWith(supabaseNames(instance).prefix)) continue;
      const match = /^([0-9.]+)([KMGT]?i?B)/.exec((usage ?? "").trim());
      if (!match) throw new Error("Cannot determine available Docker memory");
      const units: Record<string, number> = {
        B: 1,
        kB: 1000,
        KB: 1000,
        MB: 1e6,
        GB: 1e9,
        TB: 1e12,
        KiB: 1024,
        MiB: 1024 ** 2,
        GiB: 1024 ** 3,
        TiB: 1024 ** 4,
      };
      const multiplier = units[match[2]!];
      if (!multiplier) throw new Error("Unknown Docker memory unit");
      used += Number(match[1]) * multiplier;
    }
    if (info.MemTotal - used < 6 * 1024 ** 3)
      throw new Error(
        "Insufficient available memory for Supabase and host reserve",
      );
    await this.diskBudget(15 * 1024 ** 3);
  }
  async diskBudget(required: number) {
    const stat = await fs.promises.statfs(this.config.DATA_DIR, {
      bigint: true,
    });
    if (stat.bavail * stat.bsize < BigInt(Math.ceil(required + 5 * 1024 ** 3)))
      throw new Error("Insufficient free space for Supabase operation");
  }
  async ensureVolumes(instance: SupabaseInstance) {
    for (const volume of SUPABASE_VOLUMES)
      await this.resource(
        instance,
        "volume",
        supabaseNames(instance).volume(volume),
        `supabase-volume-${volume}`,
      );
  }
  async start(
    instance: SupabaseInstance,
    secrets: SupabaseSecrets,
    connectRouter = true,
  ): Promise<number> {
    const port = await this.startServices(
      instance,
      secrets,
      connectRouter,
      true,
    );
    if (port === undefined)
      throw new Error("Missing loopback database endpoint");
    return port;
  }
  async startIsolated(
    instance: SupabaseInstance,
    secrets: SupabaseSecrets,
  ): Promise<void> {
    await this.ensureTestNetworks(instance);
    await this.startServices(instance, secrets, false, false);
  }
  private async startServices(
    instance: SupabaseInstance,
    secrets: SupabaseSecrets,
    connectRouter: boolean,
    requirePublishedDatabase: boolean,
  ): Promise<number | undefined> {
    const names = supabaseNames(instance);
    const template = supabaseTemplate(instance, secrets);
    await this.resource(instance, "network", names.backend, "supabase-backend");
    await this.resource(
      instance,
      "network",
      names.frontend,
      "supabase-frontend",
    );
    await this.ensureVolumes(instance);
    const work = path.join(this.config.DATA_DIR, "supabase-work", instance.id);
    fs.mkdirSync(work, { recursive: true, mode: 0o700 });
    try {
      const functionsEnabled =
        (JSON.parse(instance.settings_json) as SupabaseSettings)
          .functionsEnabled === true;
      for (const service of supabaseServices(instance)) {
        const definition = template.services[service];
        let existing = await this.inspect(instance, service);
        const configHash = createHash("sha256")
          .update(
            JSON.stringify({
              definition,
              gateway: service === "api-gw" ? template.gateway : null,
              ...(service === "functions"
                ? {
                    router: createHash("sha256")
                      .update(
                        fs.readFileSync(
                          path.join(SUPABASE_ASSETS, "functions/index.ts"),
                        ),
                      )
                      .digest("hex"),
                  }
                : {}),
            }),
          )
          .digest("hex");
        if (
          existing &&
          existing.Config.Labels["shelter.config-sha"] !== configHash
        ) {
          if (service !== "api-gw" && service !== "functions")
            throw new Error(
              "Supabase configuration differs; a reviewed migration is required",
            );
          if (service === "api-gw") await this.removeGateway(instance);
          else await this.docker(["rm", "--force", existing.Id]);
          existing = undefined;
        }
        if (existing && existing.Config.Image !== definition.image)
          throw new Error(
            "Supabase image differs from pinned version; automatic upgrades are disabled",
          );
        if (
          service === "studio" &&
          functionsEnabled &&
          existing &&
          existing.Config.Labels["shelter.functions-ready"] !== "true"
        ) {
          await this.docker(["rm", "--force", existing.Id]);
          existing = undefined;
        }
        // Repair the former shell-based healthcheck on this stateless service.
        // inspect() and the configuration/image checks above verify ownership.
        if (
          service === "rest" &&
          existing?.Config.Healthcheck?.Test?.[0] === "CMD-SHELL"
        ) {
          await this.docker(["rm", "--force", existing.Id]);
          existing = undefined;
        }
        if (!existing) {
          await this.docker(["pull", definition.image], {
            timeoutMs: 15 * 60_000,
          });
          const envFile = path.join(work, `${service}.env`);
          const entries = Object.entries(definition.environment ?? {});
          if (entries.some(([key, value]) => /[\r\n\0]/.test(`${key}${value}`)))
            throw new Error("Invalid multiline environment value");
          fs.writeFileSync(
            envFile,
            entries.map(([key, value]) => `${key}=${value}`).join("\n") + "\n",
            { mode: 0o600 },
          );
          const args = [
            "create",
            "--name",
            names.container(service),
            "--hostname",
            service === "realtime" ? "realtime-dev.supabase-realtime" : service,
            ...this.labels(instance, `supabase-${service}`),
            "--label",
            `shelter.generation=${instance.generation}`,
            "--label",
            `shelter.config-sha=${configHash}`,
            ...(service === "studio" && functionsEnabled
              ? ["--label", "shelter.functions-ready=true"]
              : []),
            "--network",
            names.backend,
            "--network-alias",
            service,
            "--restart",
            "unless-stopped",
            "--memory",
            memory[service],
            "--memory-swap",
            memory[service],
            "--cpus",
            service === "db" ? "2" : "1",
            "--pids-limit",
            "512",
            "--security-opt",
            "no-new-privileges:true",
            "--cap-drop",
            "ALL",
            "--log-driver",
            service === "api-gw" ? "none" : "local",
            ...(service === "api-gw"
              ? []
              : ["--log-opt", "max-size=10m", "--log-opt", "max-file=3"]),
            "--env-file",
            envFile,
            "--tmpfs",
            "/tmp:rw,nosuid,nodev,size=128m",
          ];
          if (service === "db") {
            args.push(
              "--cap-add",
              "CHOWN",
              "--cap-add",
              "DAC_OVERRIDE",
              "--cap-add",
              "FOWNER",
              "--cap-add",
              "SETGID",
              "--cap-add",
              "SETUID",
              "--mount",
              `type=volume,source=${names.volume("db")},target=/var/lib/postgresql/data`,
              "--mount",
              `type=volume,source=${names.volume("db-config")},target=/etc/postgresql-custom`,
              "--publish",
              "127.0.0.1::5432",
            );
          } else {
            args.push("--read-only");
            if (service === "api-gw")
              args.push(
                "--mount",
                `type=volume,source=${names.volume("gateway")},target=/etc/envoy,readonly,volume-nocopy`,
              );
            if (service === "storage" || service === "imgproxy")
              args.push(
                "--mount",
                `type=volume,source=${names.volume("storage")},target=/var/lib/storage${service === "imgproxy" ? ",readonly" : ""}`,
              );
            if (service === "studio")
              args.push(
                "--mount",
                `type=volume,source=${names.volume("snippets")},target=/app/snippets`,
              );
            if (service === "studio" && functionsEnabled)
              args.push(
                "--mount",
                `type=volume,source=${names.volume("functions")},target=/app/edge-functions,readonly,volume-nocopy`,
              );
            if (service === "functions")
              args.push(
                "--mount",
                `type=volume,source=${names.volume("functions")},target=/home/deno/functions,readonly,volume-nocopy`,
                "--mount",
                `type=volume,source=${names.volume("functions-router")},target=/opt/shelter/functions-router,readonly,volume-nocopy`,
                "--tmpfs",
                "/root/.cache/deno:rw,nosuid,size=128m",
              );
          }
          if (service === "realtime")
            args.push("--network-alias", "realtime-dev.supabase-realtime");
          const health = definition.healthcheck;
          if (service === "rest") {
            args.push("--no-healthcheck");
          } else if (health) {
            const test =
              health.test[0] === "CMD-SHELL"
                ? health.test[1]!
                : health.test
                    .slice(1)
                    .map((value) => `'${value.replaceAll("'", "'\\''")}'`)
                    .join(" ");
            args.push(
              "--health-cmd",
              test,
              "--health-interval",
              health.interval ?? "10s",
              "--health-timeout",
              health.timeout ?? "5s",
              "--health-retries",
              String(health.retries ?? 6),
              "--health-start-period",
              health.start_period ?? "30s",
            );
          }
          if (service === "api-gw") args.push("--entrypoint", "envoy");
          args.push(
            definition.image,
            ...(service === "api-gw"
              ? definition.command!.slice(1)
              : (definition.command ?? [])),
          );
          await this.docker(args);
          existing = await this.inspect(instance, service);
        }
        if (existing!.State.Status === "created") {
          if (service === "functions") {
            const helper = `${names.prefix}-config-${randomUUID()}`;
            try {
              await this.docker([
                "create",
                "--name",
                helper,
                ...this.labels(instance, "supabase-config"),
                "--network",
                "none",
                "--read-only",
                "--cap-drop",
                "ALL",
                "--user",
                "0",
                "--mount",
                `type=volume,source=${names.volume("functions-router")},target=/router,volume-nocopy`,
                "--mount",
                `type=volume,source=${names.volume("functions")},target=/functions,volume-nocopy`,
                "--entrypoint",
                "/bin/true",
                template.services.db.image,
              ]);
              await this.docker([
                "cp",
                `${path.join(SUPABASE_ASSETS, "functions")}/.`,
                `${helper}:/router/`,
              ]);
            } finally {
              await this.docker(["rm", "--force", helper], {
                allowFailure: true,
              });
            }
          }
          if (service === "db") {
            const files: Record<string, string> = {
              "realtime.sql": "migrations/99-realtime.sql",
              "webhooks.sql": "init-scripts/98-webhooks.sql",
              "roles.sql": "init-scripts/99-roles.sql",
              "jwt.sql": "init-scripts/99-jwt.sql",
              "_supabase.sql": "migrations/97-_supabase.sql",
              "logs.sql": "migrations/99-logs.sql",
              "pooler.sql": "migrations/99-pooler.sql",
            };
            for (const [source, target] of Object.entries(files))
              await this.docker([
                "cp",
                path.join(SUPABASE_ASSETS, "db", source),
                `${names.container(service)}:/docker-entrypoint-initdb.d/${target}`,
              ]);
          }
          if (service === "api-gw") {
            const dir = path.join(work, "envoy");
            fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
            fs.copyFileSync(
              path.join(SUPABASE_ASSETS, "envoy/envoy.yaml"),
              path.join(dir, "envoy.yaml"),
            );
            fs.copyFileSync(
              path.join(SUPABASE_ASSETS, "envoy/cds.yaml"),
              path.join(dir, "cds.yaml"),
            );
            fs.writeFileSync(path.join(dir, "lds.yaml"), template.gateway, {
              mode: 0o644,
            });
            const helper = `${names.prefix}-config-${randomUUID()}`;
            try {
              await this.docker([
                "create",
                "--name",
                helper,
                ...this.labels(instance, "supabase-config"),
                "--network",
                "none",
                "--read-only",
                "--cap-drop",
                "ALL",
                "--mount",
                `type=volume,source=${names.volume("gateway")},target=/etc/envoy,volume-nocopy`,
                "--entrypoint",
                "/bin/true",
                definition.image,
              ]);
              await this.docker(["cp", `${dir}/.`, `${helper}:/etc/envoy/`]);
            } finally {
              await this.docker(["rm", "--force", helper], {
                allowFailure: true,
              });
            }
            if (!existing!.NetworkSettings.Networks[names.frontend])
              await this.docker([
                "network",
                "connect",
                names.frontend,
                names.container(service),
              ]);
          }
        }
        if (
          existing!.Config.Labels["shelter.generation"] !== instance.generation
        )
          throw new Error("Supabase data generation mismatch");
        await this.docker(["start", names.container(service)]);
        await this.healthy(instance, service);
      }
      if (connectRouter) await this.connectRouter(instance);
      const db = await this.inspect(instance, "db");
      if (!requirePublishedDatabase) return undefined;
      const port = db?.NetworkSettings.Ports["5432/tcp"]?.find(
        (value) => value.HostIp === "127.0.0.1",
      )?.HostPort;
      if (!port || !/^\d+$/.test(port))
        throw new Error("Missing loopback database endpoint");
      return Number(port);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }
  /** Read only bounded regular entrypoints. Never follow a directory or file symlink. */
  async functionFiles(
    instance: SupabaseInstance,
  ): Promise<Map<string, string>> {
    await this.ensureVolumes(instance);
    const names = supabaseNames(instance);
    const helper = `${names.prefix}-config-${randomUUID()}`;
    const manifest = JSON.parse(
      fs.readFileSync(path.join(SUPABASE_ASSETS, "manifest.json"), "utf8"),
    ) as { images: { db: string } };
    try {
      await this.docker([
        "create",
        "--name",
        helper,
        ...this.labels(instance, "supabase-config"),
        "--network",
        "none",
        "--read-only",
        "--security-opt",
        "no-new-privileges:true",
        "--cap-drop",
        "ALL",
        "--memory",
        "96m",
        "--pids-limit",
        "16",
        "--mount",
        `type=volume,source=${names.volume("functions")},target=/functions,readonly,volume-nocopy`,
        "--entrypoint",
        "/bin/sh",
        manifest.images.db,
        "-c",
        'count=0; total=0; for d in /functions/*; do [ -d "$d" ] || continue; [ ! -L "$d" ] || exit 1; n=${d##*/}; [ "$n" != main ] || continue; case "$n" in *[!a-z0-9_-]*|[!a-z]*|????????????????????????????????????????????????????????????????*) continue;; esac; f="$d/index.ts"; [ ! -L "$f" ] || exit 1; [ -f "$f" ] || continue; size=$(stat -c %s "$f") || exit 1; [ "$size" -le 262144 ] || exit 1; count=$((count+1)); total=$((total+size)); [ "$count" -le 128 ] && [ "$total" -le 16777216 ] || exit 1; printf "%s:" "$n"; base64 -w 0 "$f"; printf "\\n"; done',
      ]);
      const out = await this.docker(["start", "--attach", helper], {
        maxOutputChars: 24_000_000,
      });
      const state = await this.docker([
        "inspect",
        "--format",
        "{{.State.ExitCode}}",
        helper,
      ]);
      if (state.stdout.trim() !== "0")
        throw new Error("Function catalog could not be read safely");
      const files = new Map<string, string>();
      for (const line of out.stdout.trim().split("\n").filter(Boolean)) {
        const split = line.indexOf(":");
        const name = line.slice(0, split);
        if (!/^[a-z][a-z0-9_-]{0,62}$/.test(name) || name === "main")
          throw new Error("Invalid function catalog");
        files.set(
          name,
          Buffer.from(line.slice(split + 1), "base64").toString("utf8"),
        );
      }
      return files;
    } finally {
      await this.docker(["rm", "--force", helper], { allowFailure: true });
    }
  }
  async removeFunction(instance: SupabaseInstance, name: string) {
    if (!/^[a-z][a-z0-9_-]{0,62}$/.test(name) || name === "main")
      throw new Error("Invalid function name");
    const names = supabaseNames(instance),
      helper = `${names.prefix}-config-${randomUUID()}`;
    const manifest = JSON.parse(
      fs.readFileSync(path.join(SUPABASE_ASSETS, "manifest.json"), "utf8"),
    ) as { images: { db: string } };
    try {
      await this.docker([
        "run",
        "--name",
        helper,
        ...this.labels(instance, "supabase-config"),
        "--network",
        "none",
        "--read-only",
        "--security-opt",
        "no-new-privileges:true",
        "--cap-drop",
        "ALL",
        "--memory",
        "64m",
        "--mount",
        `type=volume,source=${names.volume("functions")},target=/functions,volume-nocopy`,
        "--entrypoint",
        "/bin/sh",
        manifest.images.db,
        "-c",
        'test ! -L "/functions/$1" && test ! -L "/functions/$1/index.ts" && rm -f "/functions/$1/index.ts"',
        "sh",
        name,
      ]);
      if (await this.inspect(instance, "functions"))
        await this.docker(
          ["restart", "--time", "10", names.container("functions")],
          { timeoutMs: 45_000 },
        );
    } finally {
      await this.docker(["rm", "--force", helper], { allowFailure: true });
    }
  }
  /** Executes from an owned network namespace with request secrets in a 0600 file, never argv. */
  async request(
    instance: SupabaseInstance,
    input: {
      url: string;
      token?: string | undefined;
      method?: string | undefined;
      body?: string | undefined;
      network?: string | undefined;
      validation?: string | undefined;
    },
  ) {
    const names = supabaseNames(instance),
      helper = `${names.prefix}-config-${randomUUID()}`;
    const directory = fs.mkdtempSync(
      path.join(this.config.DATA_DIR, "supabase-request-"),
    );
    const manifest = JSON.parse(
      fs.readFileSync(path.join(SUPABASE_ASSETS, "manifest.json"), "utf8"),
    ) as { images: { db: string } };
    const quote = (value: string) => JSON.stringify(value);
    fs.writeFileSync(
      path.join(directory, "request.conf"),
      [
        `url = ${quote(input.url)}`,
        `request = ${quote(input.method ?? "GET")}`,
        ...(input.token
          ? [
              `header = ${quote(`Authorization: Bearer ${input.token}`)}`,
              `header = ${quote(`apikey: ${input.token}`)}`,
            ]
          : []),
        ...(input.validation
          ? [`header = ${quote(`x-shelter-validation: ${input.validation}`)}`]
          : []),
        ...(input.body !== undefined
          ? [
              'header = "Content-Type: application/json"',
              'data-binary = "@/work/body"',
            ]
          : []),
        "silent",
        "show-error",
        "max-time = 15",
        "connect-timeout = 5",
        "max-filesize = 65536",
        'noproxy = "*"',
        'output = "/work/response"',
        'write-out = "%{http_code} %{time_total}"',
      ].join("\n"),
      { mode: 0o600 },
    );
    fs.writeFileSync(path.join(directory, "body"), input.body ?? "", {
      mode: 0o600,
    });
    const transfer = `${helper}-transfer`;
    await this.resource(instance, "volume", transfer, "supabase-transfer");
    try {
      await this.docker([
        "create",
        "--name",
        helper,
        ...this.labels(instance, "supabase-config"),
        "--network",
        input.network ?? names.backend,
        "--read-only",
        "--security-opt",
        "no-new-privileges:true",
        "--cap-drop",
        "ALL",
        "--cap-add",
        "DAC_OVERRIDE",
        "--user",
        "0",
        "--memory",
        "64m",
        "--cpus",
        "0.25",
        "--pids-limit",
        "16",
        "--mount",
        `type=volume,source=${transfer},target=/work,volume-nocopy`,
        "--entrypoint",
        "/bin/sleep",
        manifest.images.db,
        "60",
      ]);
      await this.docker(["start", helper]);
      await this.docker(["cp", `${directory}/.`, `${helper}:/work/`]);
      const response = await this.docker(
        ["exec", helper, "curl", "--config", "/work/request.conf"],
        { timeoutMs: 20_000, maxOutputChars: 1000, allowFailure: true },
      );
      if (
        response.exitCode !== 0 ||
        !/^\d{3} [0-9.]+$/.test(response.stdout.trim())
      )
        throw new Error("REQUEST_FAILED");
      const body = await this.docker(
        ["exec", helper, "base64", "-w", "0", "/work/response"],
        { maxOutputChars: 90_000 },
      );
      return {
        status: Number(response.stdout.trim().split(" ")[0]),
        body: Buffer.from(body.stdout.trim(), "base64").toString("utf8"),
        durationMs: Math.round(
          Number(response.stdout.trim().split(" ")[1]) * 1000,
        ),
      };
    } finally {
      await this.docker(["rm", "--force", helper], { allowFailure: true });
      await this.docker(["volume", "rm", transfer], { allowFailure: true });
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
  async validateFunction(
    instance: SupabaseInstance,
    source: string,
    jobId: string,
    secrets: SupabaseSecrets,
  ) {
    const names = supabaseNames(instance),
      helper = `${names.prefix}-config-${randomUUID()}`;
    const directory = fs.mkdtempSync(
      path.join(this.config.DATA_DIR, "supabase-validate-"),
    );
    const manifest = JSON.parse(
      fs.readFileSync(path.join(SUPABASE_ASSETS, "manifest.json"), "utf8"),
    ) as { images: { db: string } };
    if (!/^sbj_[a-f0-9]{32}$/.test(jobId) || Buffer.byteLength(source) > 262144)
      throw new Error("Invalid candidate");
    fs.writeFileSync(path.join(directory, "index.ts"), source, { mode: 0o644 });
    try {
      await this.docker([
        "create",
        "--name",
        helper,
        ...this.labels(instance, "supabase-config"),
        "--network",
        "none",
        "--read-only",
        "--security-opt",
        "no-new-privileges:true",
        "--cap-drop",
        "ALL",
        "--memory",
        "64m",
        "--mount",
        `type=volume,source=${names.volume("functions")},target=/functions,volume-nocopy`,
        "--entrypoint",
        "/bin/sleep",
        manifest.images.db,
        "60",
      ]);
      await this.docker(["start", helper]);
      await this.docker([
        "exec",
        helper,
        "/bin/sh",
        "-c",
        'test ! -L /functions/.shelter-candidates && mkdir -p /functions/.shelter-candidates && test ! -L "/functions/.shelter-candidates/$1" && mkdir -p "/functions/.shelter-candidates/$1" && test ! -L "/functions/.shelter-candidates/$1/index.ts" && { test ! -e "/functions/.shelter-candidates/$1/index.ts" || test -f "/functions/.shelter-candidates/$1/index.ts"; }',
        "sh",
        jobId,
      ]);
      await this.docker([
        "cp",
        path.join(directory, "index.ts"),
        `${helper}:/functions/.shelter-candidates/${jobId}/index.ts`,
      ]);
      const result = await this.request(instance, {
        url: "http://functions:9000/__shelter_validate",
        method: "POST",
        token: secrets.serviceKey,
        validation: jobId,
      });
      if (result.status !== 204) throw new Error("FUNCTION_VALIDATION_FAILED");
    } finally {
      await this.docker(
        [
          "exec",
          helper,
          "/bin/sh",
          "-c",
          'test ! -L /functions/.shelter-candidates && test ! -L "/functions/.shelter-candidates/$1" && rm -f "/functions/.shelter-candidates/$1/index.ts" && rmdir "/functions/.shelter-candidates/$1"',
          "sh",
          jobId,
        ],
        { allowFailure: true },
      );
      await this.docker(["rm", "--force", helper], { allowFailure: true });
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }

  async writeFunction(
    instance: SupabaseInstance,
    name: string,
    source: string,
    jobId: string,
  ) {
    if (
      !/^[a-z][a-z0-9_-]{0,62}$/.test(name) ||
      name === "main" ||
      !/^sbj_[a-f0-9]{32}$/.test(jobId) ||
      Buffer.byteLength(source) > 262_144
    )
      throw new Error("Invalid function deployment");
    await this.ensureVolumes(instance);
    const names = supabaseNames(instance);
    const directory = fs.mkdtempSync(
      path.join(this.config.DATA_DIR, "supabase-function-"),
    );
    const local = path.join(directory, "index.ts");
    const helper = `${names.prefix}-config-${randomUUID()}`;
    const staged = `.${jobId}.tmp`;
    const manifest = JSON.parse(
      fs.readFileSync(path.join(SUPABASE_ASSETS, "manifest.json"), "utf8"),
    ) as { images: { db: string } };
    fs.writeFileSync(local, source, { mode: 0o600 });
    try {
      await this.docker([
        "create",
        "--name",
        helper,
        ...this.labels(instance, "supabase-config"),
        "--network",
        "none",
        "--read-only",
        "--user",
        "0",
        "--cap-drop",
        "ALL",
        "--cap-add",
        "FOWNER",
        "--memory",
        "64m",
        "--cpus",
        "0.25",
        "--pids-limit",
        "16",
        "--mount",
        `type=volume,source=${names.volume("functions")},target=/functions,volume-nocopy`,
        "--entrypoint",
        "/bin/sleep",
        manifest.images.db,
        "60",
      ]);
      await this.docker(["start", helper]);
      // The deterministic staging file belongs to this job; remove an interrupted
      // copy on retry, but never follow a pre-existing directory/file symlink.
      await this.docker([
        "exec",
        helper,
        "/bin/sh",
        "-c",
        'test ! -L "/functions/$1" && { test ! -e "/functions/$1" || test -d "/functions/$1"; } && mkdir -p "/functions/$1" && test ! -L "/functions/$1/index.ts" && { test ! -e "/functions/$1/index.ts" || test -f "/functions/$1/index.ts"; } && test ! -L "/functions/$1/$2" && { test ! -e "/functions/$1/$2" || { test -f "/functions/$1/$2" && rm -f "/functions/$1/$2"; }; }',
        "sh",
        name,
        staged,
      ]);
      await this.docker([
        "cp",
        local,
        `${helper}:/functions/${name}/${staged}`,
      ]);
      await this.docker([
        "exec",
        helper,
        "chmod",
        "644",
        `/functions/${name}/${staged}`,
      ]);
      await this.docker([
        "exec",
        helper,
        "mv",
        "-T",
        "-f",
        `/functions/${name}/${staged}`,
        `/functions/${name}/index.ts`,
      ]);
      // Recycle the runtime's worker pool so a replaced module cannot keep
      // serving its old code. First-time activation starts it in start().
      if (await this.inspect(instance, "functions")) {
        await this.docker(
          ["restart", "--time", "10", names.container("functions")],
          { timeoutMs: 45_000 },
        );
        await this.healthy(instance, "functions");
      }
    } finally {
      await this.docker(
        ["exec", helper, "rm", "-f", `/functions/${name}/${staged}`],
        { allowFailure: true },
      );
      await this.docker(["rm", "--force", helper], { allowFailure: true });
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
  async healthy(instance: SupabaseInstance, service: ServiceName) {
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const value = await this.inspect(instance, service);
      if (!value?.State.Running)
        throw new Error(`Supabase ${service} did not start`);
      if (!value.State.Health || value.State.Health.Status === "healthy")
        return;
      if (value.State.Health.Status === "unhealthy" && service !== "rest")
        throw new Error(`Supabase ${service} health check failed`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`Supabase ${service} health check timed out`);
  }
  async connectRouter(instance: SupabaseInstance) {
    const names = supabaseNames(instance);
    const result = await this.docker(
      ["container", "inspect", "shelter-traefik"],
      { allowFailure: true },
    );
    if (result.exitCode !== 0) throw new Error("Shelter router is unavailable");
    const router = (JSON.parse(result.stdout) as ContainerInspection[])[0];
    if (router?.Config.Labels["shelter.control-plane"] !== "traefik")
      throw new Error("Shelter router ownership mismatch");
    const network = await this.docker(["network", "inspect", names.frontend]);
    const attached =
      (
        JSON.parse(network.stdout) as { Containers: Record<string, unknown> }[]
      )[0]?.Containers ?? {};
    if (!attached[router.Id])
      await this.docker(["network", "connect", names.frontend, router.Id]);
  }
  async stop(instance: SupabaseInstance, remove = false) {
    for (const service of [...SERVICE_ORDER].reverse()) {
      if (!(await this.inspect(instance, service))) continue;
      await this.docker(
        ["stop", "--time", "30", supabaseNames(instance).container(service)],
        { timeoutMs: 45_000 },
      );
      if (remove)
        await this.docker(["rm", supabaseNames(instance).container(service)]);
    }
  }
  async removeAuth(instance: SupabaseInstance) {
    if (!(await this.inspect(instance, "auth"))) return;
    await this.docker(
      ["stop", "--time", "30", supabaseNames(instance).container("auth")],
      { timeoutMs: 45_000 },
    );
    await this.docker(["rm", supabaseNames(instance).container("auth")]);
  }
  async revokeSessions(instance: SupabaseInstance) {
    const db = await this.inspect(instance, "db");
    if (!db) throw new Error("Install Supabase before rotating keys");
    if (!db.State.Running)
      await this.docker(["start", supabaseNames(instance).container("db")]);
    await this.healthy(instance, "db");
    // Refresh tokens survive JWT secret rotation unless explicitly revoked.
    await this.docker([
      "exec",
      supabaseNames(instance).container("db"),
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      "BEGIN; DELETE FROM auth.refresh_tokens; DELETE FROM auth.sessions; COMMIT;",
    ]);
  }
  async removeGateway(instance: SupabaseInstance) {
    if (await this.inspect(instance, "api-gw")) {
      await this.docker([
        "stop",
        "--time",
        "10",
        supabaseNames(instance).container("api-gw"),
      ]);
      await this.docker(["rm", supabaseNames(instance).container("api-gw")]);
    }
  }
  async functionLogs(instance: SupabaseInstance, since: string) {
    const container = await this.inspect(instance, "functions");
    if (!container) return "";
    const result = await this.docker(
      [
        "logs",
        "--since",
        since,
        "--tail",
        "60",
        supabaseNames(instance).container("functions"),
      ],
      { maxOutputChars: 16000, allowFailure: true },
    );
    return (result.stdout + result.stderr).slice(-16000);
  }
  async discardNetworks(instance: SupabaseInstance) {
    const names = supabaseNames(instance);
    for (const [name, purpose] of [
      [names.frontend, "supabase-frontend"],
      [names.backend, "supabase-backend"],
    ]) {
      const inspection = await this.docker(["network", "inspect", name!], {
        allowFailure: true,
      });
      if (inspection.exitCode !== 0) continue;
      const network = (
        JSON.parse(inspection.stdout) as { Labels: Record<string, string> }[]
      )[0];
      if (
        network?.Labels["shelter.supabase"] !== instance.id ||
        network.Labels["shelter.purpose"] !== purpose
      )
        throw new Error("Network ownership mismatch");
      await this.docker(["network", "rm", name!]);
    }
  }
  async discardVolumes(instance: SupabaseInstance) {
    for (const volume of SUPABASE_VOLUMES) {
      const name = supabaseNames(instance).volume(volume);
      const result = await this.docker(["volume", "inspect", name], {
        allowFailure: true,
      });
      if (result.exitCode !== 0) continue;
      const found = (
        JSON.parse(result.stdout) as { Labels: Record<string, string> }[]
      )[0];
      if (
        found?.Labels["shelter.supabase"] !== instance.id ||
        found.Labels["shelter.purpose"] !== `supabase-volume-${volume}`
      )
        throw new Error("Discarded volume ownership mismatch");
      await this.docker(["volume", "rm", name]);
    }
  }
  async snapshot(
    instance: SupabaseInstance,
    localFile: string,
    restore = false,
  ) {
    const names = supabaseNames(instance);
    await this.ensureVolumes(instance);
    const image = (
      JSON.parse(
        fs.readFileSync(path.join(SUPABASE_ASSETS, "manifest.json"), "utf8"),
      ) as { images: { db: string } }
    ).images.db;
    const helper = `${names.prefix}-snapshot-${randomUUID()}`;
    const temporaryVolume = `${helper}-transfer`;
    await this.resource(
      instance,
      "volume",
      temporaryVolume,
      "supabase-transfer",
    );
    const args = [
      "create",
      "--name",
      helper,
      ...this.labels(instance, "supabase-transfer"),
      "--network",
      "none",
      "--read-only",
      "--security-opt",
      "no-new-privileges:true",
      "--cap-drop",
      "ALL",
      "--cap-add",
      "CHOWN",
      "--cap-add",
      "DAC_OVERRIDE",
      "--cap-add",
      "FOWNER",
      "--memory",
      "256m",
      "--cpus",
      "1",
      "--pids-limit",
      "64",
      "--mount",
      `type=volume,source=${temporaryVolume},target=/transfer`,
      "--entrypoint",
      "/bin/sh",
    ];
    for (const volume of SUPABASE_VOLUMES)
      args.push(
        "--mount",
        `type=volume,source=${names.volume(volume)},target=/snapshot/${volume}${restore ? "" : ",readonly"}`,
      );
    // All values in this script are fixed template paths, never user input.
    // Monitor the Docker-volume filesystem as well as the worker's DATA_DIR.
    const archiveCommand = restore
      ? "tar -xzf /transfer/snapshot.tgz -C /snapshot"
      : `tar -czf /transfer/snapshot.tgz -C /snapshot ${SUPABASE_VOLUMES.join(" ")}`;
    const script = `${archiveCommand} &
archive=$!
watcher=""
trap 'kill "$archive" "$watcher" 2>/dev/null || true' EXIT INT TERM
(
  while kill -0 "$archive" 2>/dev/null; do
    available=$(df -Pk /transfer | awk 'END {print $4}')
    case "$available" in
      ""|*[!0-9]*) kill "$archive"; exit 1 ;;
      *) [ "$available" -gt 5242880 ] || { kill "$archive"; exit 1; } ;;
    esac
    sleep 1
  done
) &
watcher=$!
wait "$archive"
result=$?
kill "$watcher" 2>/dev/null || true
wait "$watcher" 2>/dev/null || true
exit "$result"`;
    args.push(image, "-c", script);
    const guard = new AbortController();
    const timer = setInterval(() => {
      void this.diskBudget(0).catch(() => guard.abort());
    }, 1000);
    timer.unref();
    const guarded = (command: string[], timeoutMs = 30 * 60_000) =>
      this.docker(command, { timeoutMs, signal: guard.signal });
    try {
      const capacity = await this.docker([
        "run",
        "--rm",
        "--name",
        `${helper}-capacity`,
        ...this.labels(instance, "supabase-transfer"),
        "--network",
        "none",
        "--read-only",
        "--security-opt",
        "no-new-privileges:true",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--memory",
        "64m",
        "--pids-limit",
        "32",
        "--mount",
        `type=volume,source=${temporaryVolume},target=/transfer`,
        "--entrypoint",
        "df",
        image,
        "-Pk",
        "/transfer",
      ]);
      const fields = capacity.stdout
        .trim()
        .split("\n")
        .at(-1)
        ?.trim()
        .split(/\s+/);
      const freeBytes = Number(fields?.[3]) * 1024;
      const required =
        5 * 1024 ** 3 + (restore ? fs.statSync(localFile).size * 2 : 0);
      if (!Number.isFinite(freeBytes) || freeBytes < required)
        throw new Error("Insufficient Docker volume space for snapshot");
      await guarded(args);
      if (restore)
        await guarded(["cp", localFile, `${helper}:/transfer/snapshot.tgz`]);
      await guarded(["start", "--attach", helper]);
      const result = await this.docker([
        "inspect",
        "--format",
        "{{.State.ExitCode}}",
        helper,
      ]);
      if (result.stdout.trim() !== "0")
        throw new Error("Snapshot transfer failed");
      if (!restore)
        await guarded(["cp", `${helper}:/transfer/snapshot.tgz`, localFile]);
    } finally {
      clearInterval(timer);
      await this.docker(["rm", "--force", helper], { allowFailure: true });
      await this.docker(["volume", "rm", temporaryVolume], {
        allowFailure: true,
      });
    }
  }
}
