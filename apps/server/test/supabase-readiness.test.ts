import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { Database } from "../src/lib/database.js";
import {
  sampleSupabaseNetworks,
  supabaseReadiness,
} from "../src/services/supabase-readiness.js";
const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});
it("counts only non-overlapping /24s and never mutates Docker during preflight", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "shelter-readiness-"),
  );
  directories.push(directory);
  const config = loadConfig({
    NODE_ENV: "test",
    DATA_DIR: directory,
    SUPABASE_NETWORK_POOL: "10.252.0.0/16",
  });
  const db = new Database(config);
  db.setSetting("cloudflare.tunnel_id", "fixture");
  try {
    await sampleSupabaseNetworks(config, db, async (_command, args) => {
      if (args.join(" ") === "network ls -q")
        return { stdout: "a".repeat(12), stderr: "", exitCode: 0 };
      if (args[0] === "network" && args[1] === "inspect")
        return {
          stdout: JSON.stringify([
            {
              IPAM: {
                Config: [
                  { Subnet: "10.252.0.0/17" },
                  { Subnet: "10.252.128.0/24" },
                  { Subnet: "10.251.0.0/16" },
                ],
              },
            },
          ]),
          stderr: "",
          exitCode: 0,
        };
      throw new Error("Preflight must not mutate Docker");
    });
    expect(supabaseReadiness(db).available.networks).toBe(127);
    expect(supabaseReadiness(db).checks.memory).toBeNull();
    db.setSetting(
      "supabase.network-capacity",
      JSON.stringify({ sampledAt: Date.now(), free: 1 }),
    );
    expect(supabaseReadiness(db).status).toBe("blocked");
    db.setSetting(
      "supabase.network-capacity",
      JSON.stringify({ sampledAt: Date.now() - 130000, free: 0 }),
    );
    expect(supabaseReadiness(db).checks.network).toBeNull();
  } finally {
    db.close();
  }
});
