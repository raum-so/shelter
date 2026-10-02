import { execFileSync } from "node:child_process";
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cliManifest, npmDistTag, verifyCliArchive } from "./lib/cli-package.mjs";
import { readConsistentRepositoryVersion } from "./lib/development-policy.mjs";

const root = resolve(import.meta.dirname, "..");
const version = readConsistentRepositoryVersion(
  await readFile(join(root, "package.json"), "utf8"),
  await readFile(join(root, "package-lock.json"), "utf8"), "repository"
);
const source = JSON.parse(await readFile(join(root, "apps/cli/package.json"), "utf8"));
const manifest = cliManifest(source, version);
const destination = resolve(process.argv[2] ?? join(root, "dist/cli"));
const stage = await mkdtemp(join(tmpdir(), "shelter-cli-package-"));
try {
  await mkdir(destination, { recursive: true });
  await cp(join(root, "apps/cli/dist"), join(stage, "dist"), { recursive: true });
  await cp(join(root, "apps/cli/src"), join(stage, "src"), { recursive: true });
  await copyFile(join(root, "apps/cli/README.md"), join(stage, "README.md"));
  await copyFile(join(root, "LICENSE"), join(stage, "LICENSE"));
  await writeFile(join(stage, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await chmod(join(stage, "dist/index.js"), 0o755);
  const [packed] = JSON.parse(execFileSync("npm", ["pack", "--json", "--ignore-scripts"], {
    cwd: stage, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"]
  }));
  if (packed.name !== manifest.name || packed.version !== version || !/^[a-z0-9.-]+\.tgz$/.test(packed.filename)) {
    throw new Error("npm packed an unexpected artifact.");
  }
  const metadata = { name: manifest.name, version, tag: npmDistTag(version), integrity: packed.integrity };
  await verifyCliArchive(join(stage, packed.filename), metadata, manifest.name, version);
  await copyFile(join(stage, packed.filename), join(destination, "shelter-cli.tgz"));
  await writeFile(join(destination, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  console.log(`Packed ${manifest.name}@${version} in ${destination}`);
} finally {
  await rm(stage, { recursive: true, force: true });
}
