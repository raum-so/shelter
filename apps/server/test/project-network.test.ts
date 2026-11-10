import { loadConfig } from "../src/config.js";
import { describe, expect, it, vi } from "vitest";
import {
  disconnectContainerFromNetwork,
  ensureContainerOnProjectNetwork,
  ensureProjectNetwork,
  ensureTraefikOnProjectNetwork,
  projectNetworkName,
  removeProjectNetwork,
  type ProjectNetworkCommandRunner
} from "../src/services/project-network.js";

function result(stdout = "", exitCode = 0, stderr = "") {
  return { stdout, stderr, exitCode };
}

describe("project runtime networks", () => {
  it("derives a stable bounded network name without exposing the project id", () => {
    const first = projectNetworkName("prj_0123456789abcdef0123456789abcdef");
    expect(first).toMatch(/^shelter-prj-[a-f0-9]{20}$/);
    expect(first).toBe(projectNetworkName("prj_0123456789abcdef0123456789abcdef"));
    expect(first).not.toContain("0123456789abcdef");
    expect(() => projectNetworkName("../escape")).toThrow(/Projekt-ID/);
  });

  it("creates a labelled network and verifies ownership after a possible race", async () => {
    const projectId = "prj_network";
    const network = projectNetworkName(projectId);
    const command = vi.fn<ProjectNetworkCommandRunner>()
      .mockResolvedValueOnce(result("", 1, `Error response from daemon: network ${network} not found`))
      .mockResolvedValueOnce(result("", 1, "already exists"))
      .mockResolvedValueOnce(result(JSON.stringify({
        "shelter.managed": "true",
        "shelter.project": projectId,
        "shelter.purpose": "project"
      })));

    await expect(ensureProjectNetwork(projectId, command)).resolves.toBe(network);
    expect(command).toHaveBeenNthCalledWith(2, "docker", [
      "network", "create", "--driver", "bridge",
      "--label", "shelter.managed=true",
      "--label", `shelter.project=${projectId}`,
      "--label", "shelter.purpose=project",
      network
    ], { allowFailure: true });
  });

  it("fails closed when a colliding network is not owned by this project", async () => {
    const command = vi.fn<ProjectNetworkCommandRunner>().mockResolvedValue(result(JSON.stringify({
      "shelter.managed": "true",
      "shelter.project": "prj_other",
      "shelter.purpose": "project"
    })));
    await expect(ensureProjectNetwork("prj_expected", command)).rejects.toThrow(/gehört nicht eindeutig/);
  });

  it("connects a container and verifies the resulting attachment", async () => {
    const projectId = "prj_connect";
    const network = projectNetworkName(projectId);
    const labels = JSON.stringify({
      "shelter.managed": "true",
      "shelter.project": projectId,
      "shelter.purpose": "project"
    });
    const command = vi.fn<ProjectNetworkCommandRunner>()
      .mockResolvedValueOnce(result(labels))
      .mockResolvedValueOnce(result("{}"))
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result(JSON.stringify({ [network]: { NetworkID: "network" } })));

    await expect(ensureContainerOnProjectNetwork(projectId, "shelter-run-app", command)).resolves.toBe(network);
    expect(command).toHaveBeenNthCalledWith(3, "docker", ["network", "connect", network, "shelter-run-app"], { allowFailure: true });
  });

  it("attaches only the current safely-bound Shelter Traefik generation", async () => {
    const projectId = "prj_traefik";
    const network = projectNetworkName(projectId);
    const traefikId = "a".repeat(64);
    const labels = JSON.stringify({
      "shelter.managed": "true",
      "shelter.project": projectId,
      "shelter.purpose": "project"
    });
    const command = vi.fn<ProjectNetworkCommandRunner>(async (_binary, args) => {
      if (args[0] === "network" && args[1] === "inspect" && args.includes("{{json .Labels}}")) return result(labels);
      if (args[0] === "inspect" && args.at(-1) === "shelter-traefik" && args.includes("--type")) {
        return result(JSON.stringify({
          id: traefikId,
          name: "/shelter-traefik",
          running: true,
          labels: {
            "shelter.control-plane": "traefik",
            "com.docker.compose.project": "shelter",
            "com.docker.compose.service": "traefik"
          }
        }));
      }
      if (args[0] === "inspect") return result(JSON.stringify({ [network]: {} }));
      return result();
    });

    await expect(ensureTraefikOnProjectNetwork(projectId, command)).resolves.toEqual({
      networkName: network,
      traefikIds: [traefikId]
    });
    expect(command.mock.calls.some(([, args]) => args.includes("label=com.docker.compose.project=portsmith"))).toBe(false);
  });

  it("rejects the exact Traefik name when its control-plane identity is forged", async () => {
    const projectId = "prj_traefik_spoof";
    const labels = JSON.stringify({
      "shelter.managed": "true",
      "shelter.project": projectId,
      "shelter.purpose": "project"
    });
    const command = vi.fn<ProjectNetworkCommandRunner>(async (_binary, args) => {
      if (args[0] === "network" && args[1] === "inspect") return result(labels);
      if (args[0] === "inspect" && args.at(-1) === "shelter-traefik") {
        return result(JSON.stringify({
          id: "b".repeat(64),
          name: "/shelter-traefik",
          running: true,
          labels: {
            "shelter.control-plane": "traefik",
            "com.docker.compose.project": "attacker",
            "com.docker.compose.service": "traefik"
          }
        }));
      }
      return result();
    });

    await expect(ensureTraefikOnProjectNetwork(projectId, command))
      .rejects.toThrow(/Identität oder Control-Plane-Labels/);
    expect(command.mock.calls.some(([, args]) => args[0] === "network" && args[1] === "connect")).toBe(false);
    expect(command.mock.calls.some(([, args]) => args[0] === "ps")).toBe(false);
  });

  it("fails closed on transient Docker inspect errors instead of treating the network as absent", async () => {
    const command = vi.fn<ProjectNetworkCommandRunner>()
      .mockResolvedValue(result("", 1, "Cannot connect to the Docker daemon"));
    await expect(ensureProjectNetwork("prj_transient", command)).rejects.toThrow(/konnte nicht geprüft werden/);
    expect(command).toHaveBeenCalledTimes(1);
  });

  it("fails closed when a container network inspection cannot reach Docker", async () => {
    const projectId = "prj_inspect_failure";
    const network = projectNetworkName(projectId);
    const labels = JSON.stringify({
      "shelter.managed": "true",
      "shelter.project": projectId,
      "shelter.purpose": "project"
    });
    const command = vi.fn<ProjectNetworkCommandRunner>()
      .mockResolvedValueOnce(result(labels))
      .mockResolvedValueOnce(result("", 1, "Cannot connect to the Docker daemon"));
    await expect(ensureContainerOnProjectNetwork(projectId, "shelter-run-app", command))
      .rejects.toThrow(/Netzwerkprüfung nicht gelesen/);
    expect(command).toHaveBeenCalledTimes(2);
    expect(command).not.toHaveBeenCalledWith("docker", ["network", "connect", network, "shelter-run-app"], expect.anything());
  });

  it("disconnects idempotently and refuses to remove a network with unknown endpoints", async () => {
    const projectId = "prj_remove";
    const network = projectNetworkName(projectId);
    const labels = JSON.stringify({
      "shelter.managed": "true",
      "shelter.project": projectId,
      "shelter.purpose": "project"
    });
    const command = vi.fn<ProjectNetworkCommandRunner>(async (_binary, args) => {
      if (args[0] === "network" && args[1] === "inspect" && args.includes("{{json .Labels}}")) return result(labels);
      if (args[0] === "network" && args[1] === "inspect" && args.includes("{{json .Containers}}")) {
        return result(JSON.stringify({ endpoint: { Name: "unexpected-app" } }));
      }
      if (args[0] === "inspect" && args.at(-1) === "shelter-traefik" && args.includes("--type")) {
        return result("", 1, "Error: No such container: shelter-traefik");
      }
      if (args[0] === "inspect") return result("{}");
      return result();
    });

    await expect(disconnectContainerFromNetwork(network, "missing", command)).resolves.toBeUndefined();
    await expect(removeProjectNetwork(projectId, command)).rejects.toThrow(/unerwartete Endpunkte: unexpected-app/);
    expect(command).not.toHaveBeenCalledWith("docker", ["network", "rm", network]);
  });
});

describe("reserved project address pool", () => {
  it("allocates a free /24 while leaving occupied subnets alone", async () => {
    const attempted: string[] = [];
    let labels: string | null = null;
    const command: ProjectNetworkCommandRunner = async (_binary, args) => {
      if (args[1] === "inspect") return labels ? result(labels) : result("", 1, "No such network");
      if (args[1] === "create") {
        if (!args.includes("--subnet")) return result("", 1, "all predefined address pools have been fully subnetted");
        attempted.push(args[args.indexOf("--subnet") + 1]!);
        if (attempted.length === 1) return result("", 1, "Pool overlaps with other one on this address space");
        labels = JSON.stringify({
          "shelter.managed": "true", "shelter.project": "prj_pool", "shelter.purpose": "project"
        });
        return result("created");
      }
      throw new Error("Unexpected mutation");
    };
    await expect(ensureProjectNetwork("prj_pool", command, "10.251.0.0/16")).resolves.toBe(projectNetworkName("prj_pool"));
    expect(attempted).toHaveLength(2);
    expect(new Set(attempted).size).toBe(2);
    for (const subnet of attempted) expect(subnet).toMatch(/^10\.251\.\d+\.0\/24$/);
  });

  it("reports exhausted capacity without deleting or renumbering any network", async () => {
    const command = vi.fn<ProjectNetworkCommandRunner>(async (_binary, args) => args[1] === "inspect"
      ? result("", 1, "No such network")
      : result("", 1, "all predefined address pools have been fully subnetted"));
    await expect(ensureProjectNetwork("prj_full", command)).rejects.toMatchObject({ code: "PROJECT_NETWORK_CAPACITY" });
    expect(command.mock.calls.every(([, args]) => ["inspect", "create"].includes(args[1]!))).toBe(true);
  });

  it("reuses existing project networks even after the reserved pool changes", async () => {
    const command = vi.fn<ProjectNetworkCommandRunner>().mockResolvedValue(result(JSON.stringify({
      "shelter.managed": "true", "shelter.project": "prj_existing", "shelter.purpose": "project"
    })));
    await expect(ensureProjectNetwork("prj_existing", command, "10.251.0.0/16"))
      .resolves.toBe(projectNetworkName("prj_existing"));
    expect(command).toHaveBeenCalledTimes(1);
  });

  it("validates the pool and keeps it separate from Supabase and control networking", () => {
    expect(loadConfig({ NODE_ENV: "test", PROJECT_NETWORK_POOL: "10.251.0.0/16", SUPABASE_NETWORK_POOL: "10.252.0.0/16" })
      .PROJECT_NETWORK_POOL).toBe("10.251.0.0/16");
    for (const pool of [
      "192.168.0.0/16", "10.251.1.0/16", "10.251.0.0/24", "10.999.0.0/16",
      "10.251.0.0/16;touch /tmp/test", "10.253.0.0/16", "10.252.0.0/16"
    ]) {
      expect(() => loadConfig({ NODE_ENV: "test", PROJECT_NETWORK_POOL: pool, SUPABASE_NETWORK_POOL: "10.252.0.0/16" })).toThrow();
    }
  });

  it("bounds allocation and fails closed when the entire configured pool overlaps", async () => {
    const attempted = new Set<string>();
    const command: ProjectNetworkCommandRunner = async (_binary, args) => {
      if (args[1] === "inspect") return result("", 1, "No such network");
      if (args[1] === "create") {
        attempted.add(args[args.indexOf("--subnet") + 1]!);
        return result("", 1, "Pool overlaps with other one on this address space");
      }
      throw new Error("Unexpected mutation");
    };
    await expect(ensureProjectNetwork("prj_overlap", command, "10.251.0.0/16"))
      .rejects.toMatchObject({ code: "PROJECT_NETWORK_CAPACITY" });
    expect(attempted.size).toBe(256);
  });
});
