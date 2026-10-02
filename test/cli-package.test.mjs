import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { cliManifest, npmDistTag, verifyCliArchive } from "../ops/lib/cli-package.mjs";

const root = resolve(import.meta.dirname, "..");
const source = JSON.parse(await readFile(join(root, "apps/cli/package.json"), "utf8"));

test("distribution metadata follows root release version and excludes build scripts", () => {
  const manifest = cliManifest(source, "1.2.3-rc.1");
  assert.equal(manifest.version, "1.2.3-rc.1");
  assert.equal(manifest.private, undefined);
  assert.equal(manifest.scripts, undefined);
  assert.equal(manifest.devDependencies, undefined);
  assert.equal(manifest.publishConfig.access, "public");
  assert.equal(npmDistTag("1.2.3-rc.1"), "next");
  assert.equal(npmDistTag("1.2.3"), "latest");
  for (const version of ["v1.2.3", "1.2.3+foo", "1.2.3-01", "../version"]) {
    assert.throws(() => cliManifest(source, version));
  }
  assert.throws(() => cliManifest({ ...source, bin: { shelter: "other.js" } }, "1.2.3"));
});

test("the exact packed artifact installs offline without the repository or lifecycle scripts", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "shelter-cli-install-"));
  try {
    const output = join(root, "dist/cli");
    const archive = join(output, "shelter-cli.tgz");
    const metadata = JSON.parse(await readFile(join(output, "metadata.json"), "utf8"));
    const version = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
    await verifyCliArchive(archive, metadata, source.name, version);
    const files = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split("\n");
    assert.ok(files.length > 5);
    for (const file of files) {
      assert.match(file, /^package\/(?:package\.json|README\.md|LICENSE|(?:dist|src)\/[a-z-]+\.(?:js|ts|d\.ts)(?:\.map)?)$/);
    }
    await assert.rejects(verifyCliArchive(archive, { ...metadata, version: "99.0.0" }, source.name, version));
    await assert.rejects(verifyCliArchive(archive, { ...metadata, tag: "other" }, source.name, version));
    const prefix = join(temporary, "install");
    execFileSync("npm", ["install", "--global", "--prefix", prefix, "--ignore-scripts", "--offline", "--no-audit", "--no-fund", archive], { cwd: temporary, stdio: "pipe" });
    const binary = join(prefix, "bin/shelter");
    const reported = JSON.parse(execFileSync(binary, ["--version", "--json"], { cwd: temporary, encoding: "utf8" }));
    assert.equal(reported.version, version);
    const executed = JSON.parse(execFileSync("npm", [
      "exec", "--yes", "--offline", "--ignore-scripts", "--cache", join(temporary, "npm-cache"),
      "--package", archive, "--", "shelter", "--version", "--json"
    ], { cwd: temporary, encoding: "utf8" }));
    assert.equal(executed.version, version);
    const catalog = JSON.parse(execFileSync(binary, ["commands", "--json"], { cwd: temporary, encoding: "utf8" }));
    assert.equal(catalog.commands.environment.scope, "environment:write");
    const installed = join(prefix, "lib/node_modules", source.name);
    const manifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
    assert.equal(manifest.scripts, undefined);
    assert.ok((await readFile(join(installed, "LICENSE"), "utf8")).includes("GNU AFFERO"));
    const corrupted = join(temporary, "corrupted.tgz");
    await copyFile(archive, corrupted);
    await writeFile(corrupted, "corrupted archive");
    await assert.rejects(verifyCliArchive(corrupted, metadata, source.name, version), /integrity mismatch/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});


test("npm publication is gated behind the immutable release and uses only the tested artifact", async () => {
  const workflow = await readFile(join(root, ".github/workflows/release.yml"), "utf8");
  const publication = workflow.slice(workflow.indexOf("\n  npm-cli:"));
  assert.match(publication, /needs: \[verify, publish\]/);
  assert.match(publication, /SHELTER_NPM_PUBLISH_ENABLED == 'true'/);
  assert.match(publication, /environment: npm/);
  assert.match(publication, /id-token: write/);
  assert.match(publication, /verifyCliArchive\("dist\/cli\/shelter-cli\.tgz"/);
  assert.match(publication, /npm publish \.\/dist\/cli\/shelter-cli\.tgz --access public --provenance --ignore-scripts/);
  assert.doesNotMatch(publication, /NODE_AUTH_TOKEN|NPM_TOKEN|npm run build|npm ci/);
});
