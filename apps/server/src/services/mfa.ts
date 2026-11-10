import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { AppConfig } from "../config.js";
import type { Database } from "../lib/database.js";
import { encryptString, decryptString, hashToken } from "../lib/security.js";
import { conflict } from "../lib/errors.js";

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32(bytes: Buffer): string {
  let bits = 0,
    value = 0,
    result = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      result += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits) result += alphabet[(value << (5 - bits)) & 31];
  return result;
}
function codeAt(secret: string, counter: number): string {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const hash = createHmac("sha1", Buffer.from(secret, "hex"))
    .update(buffer)
    .digest();
  const offset = hash[hash.length - 1]! & 15;
  return String((hash.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(
    6,
    "0",
  );
}
function counterFor(
  secret: string,
  code: string,
  after = -1,
  now = Date.now(),
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const current = Math.floor(now / 30_000);
  for (const counter of [current, current - 1, current + 1]) {
    if (counter < 0 || counter <= after) continue;
    if (
      timingSafeEqual(Buffer.from(code), Buffer.from(codeAt(secret, counter)))
    )
      return counter;
  }
  return null;
}
interface Factor {
  encrypted_secret: string;
  last_counter: number;
  recovery_json: string;
}
interface Challenge {
  user_id: string;
  password_hash: string;
  expires_at: number;
  attempts: number;
}

export class MfaService {
  constructor(
    private readonly config: AppConfig,
    private readonly db: Database,
  ) {}
  status(userId: string) {
    const row = this.factor(userId);
    return {
      enabled: !!row,
      recoveryCodesRemaining: row
        ? (JSON.parse(row.recovery_json) as string[]).length
        : 0,
    };
  }
  private factor(userId: string) {
    return this.db.sqlite
      .prepare("SELECT * FROM user_mfa WHERE user_id=?")
      .get(userId) as Factor | undefined;
  }
  setup(userId: string, email: string, passwordHash: string) {
    if (this.factor(userId))
      throw conflict(
        "Two-factor authentication is already enabled",
        "MFA_ENABLED",
      );
    const secret = randomBytes(20),
      encoded = base32(secret);
    this.db.sqlite
      .prepare(
        "INSERT INTO mfa_enrollments(user_id,encrypted_secret,password_hash,expires_at) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET encrypted_secret=excluded.encrypted_secret,password_hash=excluded.password_hash,expires_at=excluded.expires_at",
      )
      .run(
        userId,
        encryptString(secret.toString("hex"), this.config.APP_SECRET),
        passwordHash,
        Date.now() + 300_000,
      );
    return {
      secret: encoded,
      uri: `otpauth://totp/${encodeURIComponent("Shelter:" + email)}?secret=${encoded}&issuer=Shelter&algorithm=SHA1&digits=6&period=30`,
    };
  }
  enable(
    userId: string,
    passwordHash: string,
    code: string,
    currentSession: string,
  ) {
    return this.db.sqlite
      .transaction(() => {
        const enrollment = this.db.sqlite
          .prepare("SELECT * FROM mfa_enrollments WHERE user_id=?")
          .get(userId) as
          | {
              encrypted_secret: string;
              password_hash: string;
              expires_at: number;
            }
          | undefined;
        if (this.db.findUserById(userId)?.password_hash !== passwordHash)
          return null;
        if (
          !enrollment ||
          enrollment.expires_at < Date.now() ||
          enrollment.password_hash !== passwordHash ||
          this.factor(userId)
        )
          return null;
        const counter = counterFor(
          decryptString(enrollment.encrypted_secret, this.config.APP_SECRET),
          code,
        );
        if (counter === null) return null;
        const codes = Array.from({ length: 10 }, () =>
          randomBytes(10).toString("hex"),
        );
        this.db.sqlite
          .prepare(
            "INSERT INTO user_mfa(user_id,encrypted_secret,last_counter,recovery_json) VALUES(?,?,?,?)",
          )
          .run(
            userId,
            enrollment.encrypted_secret,
            counter,
            JSON.stringify(codes.map(hashToken)),
          );
        this.db.sqlite
          .prepare("DELETE FROM mfa_enrollments WHERE user_id=?")
          .run(userId);
        this.revokeOthers(userId, currentSession);
        return { recoveryCodes: codes };
      })
      .immediate();
  }
  challenge(userId: string, passwordHash: string) {
    const token = randomBytes(32).toString("hex");
    this.db.sqlite
      .prepare("DELETE FROM mfa_challenges WHERE expires_at<?")
      .run(Date.now());
    this.db.sqlite
      .prepare(
        "DELETE FROM mfa_challenges WHERE token_hash IN (SELECT token_hash FROM mfa_challenges WHERE user_id=? ORDER BY rowid DESC LIMIT -1 OFFSET 9)",
      )
      .run(userId);
    this.db.sqlite
      .prepare(
        "INSERT INTO mfa_challenges(token_hash,user_id,password_hash,expires_at,attempts) VALUES(?,?,?,?,0)",
      )
      .run(hashToken(token), userId, passwordHash, Date.now() + 300_000);
    return token;
  }
  private consumeCode(userId: string, code: string): boolean {
    const factor = this.factor(userId);
    if (!factor) return false;
    const counter = counterFor(
      decryptString(factor.encrypted_secret, this.config.APP_SECRET),
      code,
      factor.last_counter,
    );
    if (counter !== null) {
      return (
        this.db.sqlite
          .prepare(
            "UPDATE user_mfa SET last_counter=? WHERE user_id=? AND last_counter<?",
          )
          .run(counter, userId, counter).changes === 1
      );
    }
    if (!/^[a-f0-9]{20}$/.test(code)) return false;
    const codes = JSON.parse(factor.recovery_json) as string[],
      hashed = hashToken(code);
    if (!codes.includes(hashed)) return false;
    this.db.sqlite
      .prepare("UPDATE user_mfa SET recovery_json=? WHERE user_id=?")
      .run(JSON.stringify(codes.filter((value) => value !== hashed)), userId);
    return true;
  }
  verifyChallenge(token: string, code: string) {
    return this.db.sqlite
      .transaction(() => {
        const hash = hashToken(token),
          challenge = this.db.sqlite
            .prepare("SELECT * FROM mfa_challenges WHERE token_hash=?")
            .get(hash) as Challenge | undefined;
        if (
          !challenge ||
          challenge.expires_at < Date.now() ||
          challenge.attempts >= 5
        )
          return null;
        this.db.sqlite
          .prepare(
            "UPDATE mfa_challenges SET attempts=attempts+1 WHERE token_hash=?",
          )
          .run(hash);
        const user = this.db.findUserById(challenge.user_id);
        if (
          !user ||
          user.password_hash !== challenge.password_hash ||
          !this.consumeCode(user.id, code)
        )
          return null;
        this.db.sqlite
          .prepare("DELETE FROM mfa_challenges WHERE token_hash=?")
          .run(hash);
        return user;
      })
      .immediate();
  }
  disable(
    userId: string,
    code: string,
    currentSession: string,
    passwordHash: string,
  ) {
    return this.db.sqlite
      .transaction(() => {
        if (
          this.db.findUserById(userId)?.password_hash !== passwordHash ||
          !this.consumeCode(userId, code)
        )
          return false;
        this.db.sqlite
          .prepare("DELETE FROM user_mfa WHERE user_id=?")
          .run(userId);
        this.db.sqlite
          .prepare("DELETE FROM mfa_challenges WHERE user_id=?")
          .run(userId);
        this.db.sqlite
          .prepare("DELETE FROM mfa_enrollments WHERE user_id=?")
          .run(userId);
        this.revokeOthers(userId, currentSession);
        return true;
      })
      .immediate();
  }
  private revokeOthers(userId: string, session: string) {
    this.db.sqlite
      .prepare("DELETE FROM sessions WHERE user_id=? AND token_hash!=?")
      .run(userId, session);
    this.db.sqlite
      .prepare(
        "UPDATE api_tokens SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL",
      )
      .run(new Date().toISOString(), userId);
  }
}
