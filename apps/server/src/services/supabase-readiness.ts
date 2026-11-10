import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { Database } from "../lib/database.js";
import type { SupabaseCommand } from "./supabase-runtime.js";

const GiB = 1024 ** 3;
function ipv4(value: string): number | null {
  const parts = value.split(".");
  if (
    parts.length !== 4 ||
    parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)
  )
    return null;
  return parts.reduce((number, part) => number * 256 + Number(part), 0);
}
function overlaps(candidate: string, occupied: string): boolean {
  const [ip, mask] = occupied.split("/");
  const base = ipv4(ip!),
    value = ipv4(candidate);
  const bits = Number(mask);
  if (
    base === null ||
    value === null ||
    !Number.isInteger(bits) ||
    bits < 0 ||
    bits > 32
  )
    return false;
  const span = 2 ** (32 - bits),
    begin = Math.floor(base / span) * span;
  return value < begin + span && value + 256 > begin;
}

export async function sampleSupabaseNetworks(
  config: AppConfig,
  db: Database,
  command: SupabaseCommand,
): Promise<void> {
  if (!config.SUPABASE_NETWORK_POOL) return;
  try {
    const result = await command("docker", ["network", "ls", "-q"], {
      timeoutMs: 10_000,
    });
    const ids = result.stdout.trim().split(/\s+/).filter(Boolean);
    if (ids.some((id) => !/^[a-f0-9]{12,64}$/.test(id)) || ids.length > 4096)
      throw new Error("Invalid network inventory");
    const inspect = ids.length
      ? await command("docker", ["network", "inspect", ...ids], {
          timeoutMs: 10_000,
        })
      : { stdout: "[]" };
    const networks = z
      .array(
        z.object({
          IPAM: z
            .object({
              Config: z
                .array(z.object({ Subnet: z.string().optional() }))
                .nullish(),
            })
            .optional(),
        }),
      )
      .parse(JSON.parse(inspect.stdout));
    const subnets: string[] = [];
    for (const network of networks) {
      for (const entry of network?.IPAM?.Config ?? []) {
        if (typeof entry?.Subnet === "string") subnets.push(entry.Subnet);
      }
    }
    const prefix = config.SUPABASE_NETWORK_POOL.split(".")
      .slice(0, 2)
      .join(".");
    let free = 0;
    for (let index = 0; index < 256; index++)
      if (!subnets.some((subnet) => overlaps(`${prefix}.${index}.0`, subnet)))
        free++;
    db.setSetting(
      "supabase.network-capacity",
      JSON.stringify({ sampledAt: Date.now(), free }),
    );
  } catch {
    db.setSetting(
      "supabase.network-capacity",
      JSON.stringify({ sampledAt: Date.now(), free: null }),
    );
  }
}

export function supabaseReadiness(db: Database) {
  const row = db.sqlite
    .prepare(
      "SELECT sampled_at,memory_available_bytes,storage_available_bytes,cpu_logical_cores,memory_total_bytes,docker_available,service_worker FROM server_metric_samples ORDER BY sampled_at DESC LIMIT 1",
    )
    .get() as
    | {
        sampled_at: number;
        memory_available_bytes: number;
        storage_available_bytes: number;
        cpu_logical_cores: number;
        memory_total_bytes: number;
        docker_available: number;
        service_worker: string;
      }
    | undefined;
  const fresh =
    !!row &&
    Date.now() - row.sampled_at >= -30_000 &&
    Date.now() - row.sampled_at < 120_000;
  let network: { sampledAt: number; free: number | null } | null = null;
  try {
    network = z
      .object({
        sampledAt: z.number(),
        free: z.number().int().min(0).max(256).nullable(),
      })
      .nullable()
      .parse(JSON.parse(db.getSetting("supabase.network-capacity") ?? "null"));
  } catch {
    /* unknown capacity stays advisory */
  }
  const networks =
    network && Date.now() - network.sampledAt < 120_000 ? network.free : null;
  const checks = {
    memory: fresh
      ? row.memory_available_bytes >= 6 * GiB &&
        row.memory_total_bytes >= 7.5 * GiB
      : null,
    storage: fresh ? row.storage_available_bytes >= 20 * GiB : null,
    cpu: fresh ? row.cpu_logical_cores >= 4 : null,
    docker: fresh ? row.docker_available === 1 : null,
    worker: fresh ? row.service_worker === "online" : null,
    network: networks === null ? null : networks >= 2,
    cloudflare: !!db.getSetting("cloudflare.tunnel_id"),
  };
  return {
    status: Object.values(checks).some((value) => value === false)
      ? ("blocked" as const)
      : Object.values(checks).some((value) => value === null)
        ? ("unknown" as const)
        : ("ready" as const),
    sampledAt: fresh ? new Date(row.sampled_at).toISOString() : null,
    checks,
    available: {
      memoryBytes: fresh ? row.memory_available_bytes : null,
      storageBytes: fresh ? row.storage_available_bytes : null,
      networks,
    },
  };
}
