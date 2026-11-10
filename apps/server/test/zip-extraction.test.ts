import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { zipSync, strToU8 } from "fflate";
import { afterEach, expect, it } from "vitest";
import { extractZipArchive } from "../src/services/uploads.js";

const directories: string[] = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shelter-zip-"));
  directories.push(root);
  const destination = path.join(root, "source");
  fs.mkdirSync(destination);
  return { root, destination, archive: path.join(root, "source.zip") };
}
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

it("extracts bounded regular files and executable scripts without granting special permissions", async () => {
  const { root, destination, archive } = fixture();
  fs.writeFileSync(
    archive,
    zipSync({
      "app/index.html": strToU8("<h1>Hello</h1>"),
      "start.sh": [
        strToU8("#!/bin/sh\nexit 0"),
        { os: 3, attrs: 0o104755 << 16 },
      ],
    }),
  );
  await extractZipArchive(archive, destination, 4096);
  expect(
    fs.readFileSync(path.join(destination, "app/index.html"), "utf8"),
  ).toBe("<h1>Hello</h1>");
  expect(fs.statSync(path.join(destination, "start.sh")).mode & 0o7777).toBe(
    0o755,
  );
  expect(fs.readdirSync(root).sort()).toEqual(["source", "source.zip"]);
});

it("rejects symlink pivots before any write can escape the extraction directory", async () => {
  const { root, destination, archive } = fixture();
  const outside = path.join(root, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "victim"), "preserve");
  fs.writeFileSync(
    archive,
    zipSync({
      pivot: [strToU8(outside), { os: 3, attrs: 0o120777 << 16 }],
      "pivot/victim": strToU8("overwrite"),
    }),
  );
  await expect(extractZipArchive(archive, destination, 4096)).rejects.toThrow();
  expect(fs.readFileSync(path.join(outside, "victim"), "utf8")).toBe(
    "preserve",
  );
  expect(fs.readdirSync(destination)).toEqual([]);
});

it("refuses path aliases that overwrite earlier archive entries and enforces the expansion limit", async () => {
  const { destination, archive } = fixture();
  fs.writeFileSync(
    archive,
    zipSync({ same: strToU8("first"), "./same": strToU8("second") }),
  );
  await expect(extractZipArchive(archive, destination, 4096)).rejects.toThrow();
  expect(fs.readFileSync(path.join(destination, "same"), "utf8")).toBe("first");
  const other = fixture();
  fs.writeFileSync(
    other.archive,
    zipSync({ "too-large": strToU8("123456789") }),
  );
  await expect(
    extractZipArchive(other.archive, other.destination, 8),
  ).rejects.toThrow("groß");
  expect(fs.readdirSync(other.destination)).toEqual([]);
});
