import fs from "node:fs";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { pipeline } from "node:stream/promises";

const MAGIC = Buffer.from("SHSBK001");
function key(secret: string) {
  return createHash("sha256")
    .update("shelter:supabase:backup:v1\0")
    .update(secret)
    .digest();
}

export async function encryptSupabaseBackup(
  source: string,
  target: string,
  secret: string,
  identity: string,
) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(secret), iv);
  cipher.setAAD(Buffer.from(identity));
  fs.writeFileSync(target, Buffer.concat([MAGIC, iv]), {
    mode: 0o600,
    flag: "wx",
  });
  try {
    await pipeline(
      fs.createReadStream(source),
      cipher,
      fs.createWriteStream(target, { flags: "a", mode: 0o600 }),
    );
    fs.appendFileSync(target, cipher.getAuthTag());
  } catch (error) {
    fs.rmSync(target, { force: true });
    throw error;
  }
}

export async function decryptSupabaseBackup(
  source: string,
  target: string,
  secret: string,
  identity: string,
) {
  const size = fs.statSync(source).size;
  if (size < 36) throw new Error("Invalid backup");
  const fd = fs.openSync(source, "r");
  const header = Buffer.alloc(20);
  const tag = Buffer.alloc(16);
  try {
    fs.readSync(fd, header, 0, 20, 0);
    fs.readSync(fd, tag, 0, 16, size - 16);
  } finally {
    fs.closeSync(fd);
  }
  if (!header.subarray(0, 8).equals(MAGIC))
    throw new Error("Invalid backup format");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key(secret),
    header.subarray(8),
  );
  decipher.setAAD(Buffer.from(identity));
  decipher.setAuthTag(tag);
  try {
    await pipeline(
      fs.createReadStream(source, { start: 20, end: size - 17 }),
      decipher,
      fs.createWriteStream(target, { flags: "wx", mode: 0o600 }),
    );
  } catch {
    fs.rmSync(target, { force: true });
    throw new Error("Backup authentication failed");
  }
}
export async function supabaseBackupHash(file: string) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
