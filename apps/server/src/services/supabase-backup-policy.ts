import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import dns from "node:dns";
import net from "node:net";
import { createHash, randomBytes } from "node:crypto";
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from "@aws-sdk/client-s3";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { Database } from "../lib/database.js";
import { decryptString, encryptString } from "../lib/security.js";
import { conflict } from "../lib/errors.js";
import { SupabaseStore } from "./supabase-store.js";

export const BackupPolicyInput = z
  .object({
    enabled: z.boolean(),
    verifyWeekly: z.boolean().default(false),
    hourUtc: z.number().int().min(0).max(23),
    destination: z.enum(["local", "s3"]),
    s3: z
      .object({
        endpoint: z
          .url()
          .max(2048)
          .refine((value) => {
            const u = new URL(value);
            return (
              u.protocol === "https:" &&
              !net.isIP(u.hostname.replace(/^\[|\]$/g, "")) &&
              u.hostname !== "localhost" &&
              !u.hostname.endsWith(".localhost") &&
              !u.username &&
              !u.password &&
              !u.search &&
              !u.hash &&
              u.pathname === "/"
            );
          }),
        region: z.string().regex(/^[a-z0-9-]{1,64}$/),
        bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
        accessKeyId: z.string().min(1).max(256),
        secretAccessKey: z.string().min(1).max(1024).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
type PolicyRow = {
  instance_id: string;
  enabled: number;
  hour_utc: number;
  next_at: string | null;
  encrypted_destination: string | null;
};
type Destination = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
};
const blocked = new net.BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["100.64.0.0", 10],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["::ffff:0:0", 96],
] as const)
  blocked.addSubnet(network, prefix, "ipv6");
function agent() {
  // Pin DNS resolution to public addresses for every connection, including retries.
  return new https.Agent({
    lookup: (hostname, options, callback) => {
      dns.lookup(hostname, { all: true }, (error, addresses) => {
        if (error) return callback(error, "", 4);
        const safe = addresses.filter(
          (entry) =>
            !blocked.check(entry.address, entry.family === 6 ? "ipv6" : "ipv4"),
        );
        if (!safe.length || safe.length !== addresses.length)
          return callback(
            new Error("Private backup destination is not allowed"),
            "",
            4,
          );
        if (options.all) callback(null, safe);
        else callback(null, safe[0]!.address, safe[0]!.family);
      });
    },
  });
}
function nextAt(hour: number, now = new Date()) {
  const next = new Date(now);
  next.setUTCHours(hour, 0, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString();
}
export class SupabaseBackupPolicy {
  constructor(
    private readonly config: AppConfig,
    private readonly db: Database,
  ) {}
  private row(id: string) {
    return this.db.sqlite
      .prepare("SELECT * FROM supabase_backup_policies WHERE instance_id=?")
      .get(id) as PolicyRow | undefined;
  }
  private destination(row: PolicyRow | undefined): Destination | null {
    return row?.encrypted_destination
      ? (JSON.parse(
          decryptString(row.encrypted_destination, this.config.APP_SECRET),
        ) as Destination)
      : null;
  }
  get(id: string) {
    const row = this.row(id),
      s3 = this.destination(row);
    return {
      enabled: Boolean(row?.enabled),
      verifyWeekly:
        this.db.getSetting(`supabase.backup.verify.${id}`) === "weekly",
      hourUtc: row?.hour_utc ?? 3,
      nextAt: row?.next_at ?? null,
      destination: s3 ? ("s3" as const) : ("local" as const),
      s3: s3
        ? {
            endpoint: s3.endpoint,
            region: s3.region,
            bucket: s3.bucket,
            accessKeyId: s3.accessKeyId,
            hasSecret: true,
          }
        : null,
    };
  }
  set(id: string, input: z.infer<typeof BackupPolicyInput>) {
    new SupabaseStore(this.db).get(id);
    let destination: Destination | null = null;
    if (input.destination === "s3") {
      if (!input.s3)
        throw conflict("Configure S3 first", "BACKUP_DESTINATION_REQUIRED");
      const prior = this.destination(this.row(id));
      const secret =
        input.s3.secretAccessKey ??
        (prior?.endpoint === input.s3.endpoint &&
        prior.accessKeyId === input.s3.accessKeyId
          ? prior.secretAccessKey
          : undefined);
      if (!secret)
        throw conflict("Enter the S3 secret", "BACKUP_DESTINATION_REQUIRED");
      destination = { ...input.s3, secretAccessKey: secret };
    }
    this.db.sqlite
      .prepare(
        "INSERT INTO supabase_backup_policies(instance_id,enabled,hour_utc,next_at,encrypted_destination,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(instance_id) DO UPDATE SET enabled=excluded.enabled,hour_utc=excluded.hour_utc,next_at=excluded.next_at,encrypted_destination=excluded.encrypted_destination,updated_at=excluded.updated_at",
      )
      .run(
        id,
        input.enabled ? 1 : 0,
        input.hourUtc,
        input.enabled ? nextAt(input.hourUtc) : null,
        destination
          ? encryptString(JSON.stringify(destination), this.config.APP_SECRET)
          : null,
        new Date().toISOString(),
      );
    this.db.setSetting(
      `supabase.backup.verify.${id}`,
      input.verifyWeekly ? "weekly" : "manual",
    );
    return this.get(id);
  }
  verificationDue(id: string) {
    if (this.db.getSetting(`supabase.backup.verify.${id}`) !== "weekly")
      return false;
    const row = this.db.sqlite
      .prepare(
        "SELECT max(c.restored_at) AS checked FROM supabase_backup_checks c JOIN supabase_backups b ON b.id=c.backup_id WHERE b.instance_id=?",
      )
      .get(id) as { checked: string | null };
    return (
      !row.checked ||
      Date.now() - new Date(row.checked).getTime() >= 7 * 24 * 60 * 60 * 1000
    );
  }
  schedule() {
    const store = new SupabaseStore(this.db);
    const due = this.db.sqlite
      .prepare(
        "SELECT * FROM supabase_backup_policies WHERE enabled=1 AND next_at<=?",
      )
      .all(new Date().toISOString()) as PolicyRow[];
    for (const row of due) {
      const instance = store.get(row.instance_id);
      if (
        !["running", "stopped"].includes(instance.status) ||
        store
          .jobs(instance.id)
          .some((j) => ["queued", "running"].includes(j.status))
      )
        continue;
      this.db.sqlite.transaction(() => {
        store.enqueue(instance.id, "backup");
        this.db.sqlite
          .prepare(
            "UPDATE supabase_backup_policies SET next_at=? WHERE instance_id=?",
          )
          .run(nextAt(row.hour_utc), instance.id);
      })();
    }
  }
  private client(target: Destination) {
    return new S3Client({
      endpoint: target.endpoint,
      region: target.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: target.accessKeyId,
        secretAccessKey: target.secretAccessKey,
      },
      maxAttempts: 2,
      requestHandler: {
        httpsAgent: agent(),
        connectionTimeout: 10_000,
        requestTimeout: 300_000,
      },
    });
  }
  async verifyDestination(id: string) {
    const target = this.destination(this.row(id));
    if (!target) throw new Error("BACKUP_DESTINATION_REQUIRED");
    const client = this.client(target),
      Key = `shelter/${id}/.connection-check-${randomBytes(12).toString("hex")}`,
      Body = randomBytes(64),
      ChecksumSHA256 = createHash("sha256").update(Body).digest("base64");
    try {
      await client.send(
        new PutObjectCommand({
          Bucket: target.bucket,
          Key,
          Body,
          ChecksumSHA256,
        }),
      );
      const head = await client.send(
        new HeadObjectCommand({
          Bucket: target.bucket,
          Key,
          ChecksumMode: "ENABLED",
        }),
      );
      if (
        head.ContentLength !== Body.length ||
        head.ChecksumSHA256 !== ChecksumSHA256
      )
        throw new Error("BACKUP_DESTINATION_CHECKSUM");
    } finally {
      try {
        await client.send(
          new DeleteObjectCommand({ Bucket: target.bucket, Key }),
        );
      } finally {
        client.destroy();
      }
    }
  }
  async upload(id: string, backupId: string, sha256: string) {
    const target = this.destination(this.row(id));
    if (!target) return;
    const file = path.join(
        this.config.DATA_DIR,
        "supabase-backups",
        id,
        `${backupId}.enc`,
      ),
      size = fs.statSync(file).size;
    const client = this.client(target),
      Key = `shelter/${id}/${backupId}.enc`,
      ChecksumSHA256 = Buffer.from(sha256, "hex").toString("base64");
    try {
      let expectedChecksum = ChecksumSHA256;
      if (size <= 32 * 1024 ** 2) {
        await client.send(
          new PutObjectCommand({
            Bucket: target.bucket,
            Key,
            Body: fs.createReadStream(file),
            ContentLength: size,
            ChecksumSHA256,
          }),
        );
      } else {
        const created = await client.send(
          new CreateMultipartUploadCommand({
            Bucket: target.bucket,
            Key,
            ChecksumAlgorithm: "SHA256",
            ChecksumType: "COMPOSITE",
          }),
        );
        if (!created.UploadId)
          throw new Error("Multipart upload was not created");
        const UploadId = created.UploadId,
          parts: {
            PartNumber: number;
            ETag: string;
            ChecksumSHA256: string;
          }[] = [],
          hashes: Buffer[] = [];
        const handle = await fs.promises.open(file, "r");
        let completed = false;
        try {
          // Bounded sequential parts avoid buffering large backups or saturating the VPS.
          const partSize = Math.max(32 * 1024 ** 2, Math.ceil(size / 9999));
          for (
            let offset = 0, part = 1;
            offset < size;
            offset += partSize, part++
          ) {
            const buffer = Buffer.alloc(Math.min(partSize, size - offset));
            let read = 0;
            while (read < buffer.length) {
              const result = await handle.read(
                buffer,
                read,
                buffer.length - read,
                offset + read,
              );
              if (!result.bytesRead)
                throw new Error("Backup changed during upload");
              read += result.bytesRead;
            }
            const hash = createHash("sha256").update(buffer).digest();
            hashes.push(hash);
            const checksum = hash.toString("base64");
            const sent = await client.send(
              new UploadPartCommand({
                Bucket: target.bucket,
                Key,
                UploadId,
                PartNumber: part,
                Body: buffer,
                ContentLength: buffer.length,
                ChecksumSHA256: checksum,
              }),
            );
            if (!sent.ETag || sent.ChecksumSHA256 !== checksum)
              throw new Error("Part checksum mismatch");
            parts.push({
              PartNumber: part,
              ETag: sent.ETag,
              ChecksumSHA256: checksum,
            });
          }
          expectedChecksum = `${createHash("sha256").update(Buffer.concat(hashes)).digest("base64")}-${parts.length}`;
          await client.send(
            new CompleteMultipartUploadCommand({
              Bucket: target.bucket,
              Key,
              UploadId,
              MultipartUpload: { Parts: parts },
              ChecksumType: "COMPOSITE",
            }),
          );
          completed = true;
        } finally {
          await handle.close();
          if (!completed)
            await client.send(
              new AbortMultipartUploadCommand({
                Bucket: target.bucket,
                Key,
                UploadId,
              }),
            );
        }
      }
      const head = await client.send(
        new HeadObjectCommand({
          Bucket: target.bucket,
          Key,
          ChecksumMode: "ENABLED",
        }),
      );
      if (
        head.ContentLength !== size ||
        head.ChecksumSHA256 !== expectedChecksum
      )
        throw new Error("BACKUP_DESTINATION_CHECKSUM");
      this.db.sqlite
        .prepare(
          "INSERT INTO supabase_backup_checks(backup_id,offsite_at) VALUES(?,?) ON CONFLICT(backup_id) DO UPDATE SET offsite_at=excluded.offsite_at,error=NULL",
        )
        .run(backupId, new Date().toISOString());
    } catch {
      this.db.sqlite
        .prepare(
          "INSERT INTO supabase_backup_checks(backup_id,error) VALUES(?,'BACKUP_UPLOAD_FAILED') ON CONFLICT(backup_id) DO UPDATE SET error=excluded.error",
        )
        .run(backupId);
      throw new Error("BACKUP_UPLOAD_FAILED");
    } finally {
      client.destroy();
    }
  }
}
