import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { Database } from "../lib/database.js";
import { conflict, upstreamError } from "../lib/errors.js";

export const StableVersion = z.string().regex(/^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/);
const Tag = z.string().refine((value) => value.startsWith("v") && StableVersion.safeParse(value.slice(1)).success);
const RequestSchema = z.object({ id: z.string().regex(/^[a-f0-9]{32}$/), tag: Tag, fromVersion: StableVersion }).strict();
const JobSchema = RequestSchema.extend({ phase: z.enum(["verifying", "installing", "succeeded", "failed"]), updatedAt: z.iso.datetime() }).strict();
const ReadySchema = z.object({ checkedAt: z.iso.datetime() }).strict();
const ReleaseSchema = z.object({ tag: Tag, version: StableVersion, publishedAt: z.iso.datetime(), notes: z.string().max(16_000) });
const CachedRelease = z.object({ checkedAt: z.iso.datetime(), release: ReleaseSchema });
export type UpdateJob = z.infer<typeof RequestSchema> & { phase: "queued" | z.infer<typeof JobSchema>["phase"]; updatedAt?: string };
export type UpdateRelease = z.infer<typeof ReleaseSchema>;
export const installedVersion = z.string().max(128).parse(JSON.parse(fs.readFileSync(new URL("../../../../package.json", import.meta.url), "utf8")).version);

function readFile(directory: string, name: string): unknown {
  const filename = path.join(directory, name);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 32_768) throw new Error("Invalid update state");
    const buffer = Buffer.alloc(32_769);
    const size = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    if (size > 32_768) throw new Error("Invalid update state");
    return JSON.parse(buffer.subarray(0, size).toString("utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw conflict("Update status is unavailable. Check the VPS updater.", "UPDATE_STATE_INVALID");
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function updateJob(config: AppConfig): UpdateJob | null {
  const request = readFile(config.UPDATE_REQUESTS_DIR, "request.json");
  const job = readFile(config.UPDATE_STATUS_DIR, "job.json");
  const parsedJob = JobSchema.safeParse(job);
  if (job !== null && !parsedJob.success) throw conflict("Update status is invalid. Check the VPS updater.", "UPDATE_STATE_INVALID");
  if (request !== null) {
    const parsed = RequestSchema.safeParse(request);
    if (!parsed.success) throw conflict("Update request is invalid. Check the VPS updater.", "UPDATE_STATE_INVALID");
    if (parsedJob.success && parsedJob.data.id === parsed.data.id && parsedJob.data.tag === parsed.data.tag && parsedJob.data.fromVersion === parsed.data.fromVersion) return parsedJob.data;
    return { ...parsed.data, phase: "queued" };
  }
  return parsedJob.success ? parsedJob.data : null;
}

export function updatePending(config: AppConfig): boolean {
  try {
    const job = updateJob(config);
    return job !== null && !["succeeded", "failed"].includes(job.phase);
  } catch {
    // Unreadable update state must not let a worker start writing during an install.
    return true;
  }
}

function newer(candidate: string, current: string): boolean {
  const left = candidate.split(".").map(Number), right = current.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index]! > right[index]!;
  }
  return false;
}

async function githubRelease(): Promise<UpdateRelease> {
  const response = await fetch("https://api.github.com/repos/raum-so/shelter/releases/latest", {
    headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
    redirect: "error", signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok || !response.body) throw new Error("Release lookup failed");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 512_000) throw new Error("Release response too large");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const result = z.object({
    tag_name: Tag, draft: z.literal(false), prerelease: z.literal(false), immutable: z.literal(true),
    published_at: z.iso.datetime(), body: z.string().nullable(),
    assets: z.array(z.object({ name: z.string(), state: z.string() })).max(100)
  }).parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  if (!result.assets.some((asset) => asset.name === `shelter-${result.tag_name}.tar.gz` && asset.state === "uploaded")) throw new Error("Incomplete release");
  return { tag: result.tag_name, version: result.tag_name.slice(1), publishedAt: result.published_at, notes: (result.body ?? "").slice(0, 16_000) };
}

export class ControlPlaneUpdates {
  constructor(private readonly config: AppConfig, private readonly database: Database) {}

  state() {
    const ready = ReadySchema.safeParse(readFile(this.config.UPDATE_STATUS_DIR, "ready.json"));
    const age = ready.success ? Date.now() - Date.parse(ready.data.checkedAt) : Infinity;
    let cache: unknown = null;
    try { cache = JSON.parse(this.database.getSetting("system.release-cache") ?? "null"); } catch { /* An invalid cache never authorizes an update. */ }
    const cached = CachedRelease.safeParse(cache);
    const release = cached.success ? cached.data.release : null;
    const releaseInstallation = /^shelter\/control-plane:release-[a-f0-9]{64}$/.test(this.config.CONTROL_PLANE_IMAGE);
    const heartbeat = Date.parse(this.database.getSetting("worker.heartbeat") ?? "");
    const workerOnline = Number.isFinite(heartbeat) && Date.now() - heartbeat >= 0 && Date.now() - heartbeat < 15_000;
    return {
      currentVersion: installedVersion,
      release, checkedAt: cached.success ? cached.data.checkedAt : null,
      updateAvailable: release !== null && StableVersion.safeParse(installedVersion).success && newer(release.version, installedVersion),
      updaterReady: age >= 0 && age < 90_000 && releaseInstallation && StableVersion.safeParse(installedVersion).success,
      releaseInstallation, workerOnline, job: updateJob(this.config)
    };
  }

  async check() {
    try {
      const release = await githubRelease();
      this.database.setSetting("system.release-cache", JSON.stringify({ checkedAt: new Date().toISOString(), release }));
    } catch {
      throw upstreamError("Release information could not be verified. Try again later.", "UPDATE_CHECK_FAILED");
    }
    return this.state();
  }

  async start(tag: string, fromVersion: string) {
    // Recheck upstream immediately before admission; cached metadata never authorizes an install.
    const state = await this.check();
    if (!state.updaterReady) throw conflict("Enable the VPS updater before starting a panel update.", "UPDATER_UNAVAILABLE");
    if (!state.workerOnline) throw conflict("The worker must be online before updating.", "UPDATE_WORKER_OFFLINE");
    if (fromVersion !== installedVersion || !state.updateAvailable || state.release?.tag !== tag) throw conflict("Release information changed. Check for updates again.", "UPDATE_RELEASE_CHANGED");
    if (updatePending(this.config)) throw conflict("An update is already active.", "UPDATE_BUSY");
    const busy = this.database.sqlite.prepare("SELECT 1 FROM deployments WHERE status IN ('queued','preparing','building','checking','switching') LIMIT 1").get()
      || this.database.sqlite.prepare("SELECT 1 FROM project_deletions WHERE status IN ('preparing','queued','running') LIMIT 1").get();
    if (busy) throw conflict("Wait for deployments and project deletions to finish before updating.", "UPDATE_PROJECTS_BUSY");
    const request = RequestSchema.parse({ id: randomBytes(16).toString("hex"), tag, fromVersion });
    const temporary = path.join(this.config.UPDATE_REQUESTS_DIR, `.${request.id}.json`);
    try {
      fs.writeFileSync(temporary, JSON.stringify(request), { flag: "wx", mode: 0o600 });
      // Atomic, exclusive admission across API processes. The host never sees a partial request.
      fs.linkSync(temporary, path.join(this.config.UPDATE_REQUESTS_DIR, "request.json"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw conflict("An update is already active.", "UPDATE_BUSY");
      throw conflict("The VPS updater could not receive the request.", "UPDATER_UNAVAILABLE");
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    return this.state();
  }
}
