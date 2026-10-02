import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseShelterVersion } from "./development-policy.mjs";

export function cliManifest(source, version) {
  parseShelterVersion(version);
  if (!/^@[a-z0-9-]+\/[a-z0-9-]+$/.test(source.name) || source.bin?.shelter !== "dist/index.js") {
    throw new Error("Unexpected CLI package identity.");
  }
  // Only distribution metadata enters the public package. Workspace build
  // scripts, development dependencies and local configuration stay behind.
  const { name, description, license, homepage, repository, bugs, type, bin, engines } = source;
  return {
    name, version, description, license, homepage, repository, bugs, type, bin, engines,
    files: ["dist", "src", "README.md", "LICENSE"],
    publishConfig: { access: "public", registry: "https://registry.npmjs.org/" }
  };
}

export function npmDistTag(version) {
  return parseShelterVersion(version).prerelease.length ? "next" : "latest";
}

export async function verifyCliArchive(archive, metadata, name, version) {
  parseShelterVersion(version);
  if (metadata.name !== name || metadata.version !== version || metadata.tag !== npmDistTag(version)) {
    throw new Error("CLI artifact identity does not match the release.");
  }
  const integrity = `sha512-${createHash("sha512").update(await readFile(archive)).digest("base64")}`;
  if (metadata.integrity !== integrity) throw new Error("CLI archive integrity mismatch.");
}
