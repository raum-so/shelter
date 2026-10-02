import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShelterClient } from "../src/api.js";
import { agentCommands, readJsonInput, runAgentCommand } from "../src/agent-commands.js";
import { run } from "../src/index.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
async function input(text: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "shelter-cli-test-"));
  directories.push(directory);
  const path = join(directory, "input.json");
  await writeFile(path, text);
  return path;
}
function client() {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ ok: true }));
  return { fetcher, api: new ShelterClient({ serverUrl: "https://example.test", token: "test-credential" }, fetcher) };
}

describe("agent commands", () => {
  it.each(Object.entries(agentCommands))("routes %s with positional IDs and JSON bodies", async (name, command) => {
    const { api, fetcher } = client();
    const ids = command.path.match(/\{\w+\}/g)?.map(() => "resource_123") ?? [];
    const args = [...ids, ...(command.body ? ["--input", await input('{"variables":[]}')] : [])];
    await runAgentCommand(name, args, api);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://example.test${command.path.replace(/\{\w+\}/g, "resource_123")}`);
    expect(init?.method).toBe(command.method);
    if (command.body) expect(JSON.parse(init?.body as string)).toEqual({ variables: [] });
  });

  it("rejects missing bodies, bad IDs, unknown flags, and extra arguments before any request", async () => {
    const { api, fetcher } = client();
    for (const [name, args] of [
      ["environment", ["prj_123"]], ["previews", ["../outside"]],
      ["zones", ["--force"]], ["overview", ["extra"]], ["api", ["TRACE", "/api/projects"]],
      ["api", ["GET", "/api/projects", "--input", "-"]]
    ] as const) await expect(runAgentCommand(name, [...args], api)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("preserves query parameters on generic API requests", async () => {
    const { api, fetcher } = client();
    await runAgentCommand("api", ["GET", "/api/deployments/dep_123/logs?after=42"], api);
    expect(String(fetcher.mock.calls[0]?.[0])).toContain("?after=42");
  });

  it("does not expose malformed sensitive JSON in parser errors", async () => {
    for (const text of ['{"password":"private-input",', "[]", "null"]) {
      await expect(readJsonInput(await input(text))).rejects.toThrow("Input must be a valid JSON object.");
    }
  });

  it("discovers commands without credentials and keeps JSON help machine-readable", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await run(["commands", "--json"]);
    const catalog = JSON.parse(String(stdout.mock.calls[0]?.[0]));
    expect(catalog.commands.environment.scope).toBe("environment:write");
    stdout.mockClear();
    await run(["--help", "--json"]);
    expect(JSON.parse(String(stdout.mock.calls[0]?.[0])).help).toContain("create upload");
  });
});
