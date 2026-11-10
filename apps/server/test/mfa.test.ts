import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { Database } from "../src/lib/database.js";
import { encryptString, hashToken } from "../src/lib/security.js";
import { MfaService } from "../src/services/mfa.js";

const directories: string[] = [];
const apps: Awaited<ReturnType<typeof createApp>>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const app of apps.splice(0)) await app.close();
  for (const dir of directories.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});
async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shelter-mfa-"));
  directories.push(dir);
  const config = loadConfig({
    NODE_ENV: "test",
    DATA_DIR: dir,
    WEB_DIST: path.join(dir, "absent"),
    APP_SECRET: "m".repeat(64),
    ADMIN_EMAIL: "admin@example.com",
    ADMIN_PASSWORD: "correct horse battery staple",
    LOG_LEVEL: "silent",
  });
  const db = new Database(config),
    app = await createApp(config, db);
  apps.push(app);
  const user = db.findUserByEmail(config.ADMIN_EMAIL)!;
  const secret = Buffer.from("12345678901234567890").toString("hex"); // RFC 6238 public test key.
  return { config, db, app, user, secret, mfa: new MfaService(config, db) };
}
it("accepts RFC 6238 vectors through the persisted challenge boundary and rejects replay", async () => {
  const { db, config, user, secret, mfa } = await fixture();
  db.sqlite
    .prepare("INSERT INTO user_mfa VALUES(?,?,-1,'[]')")
    .run(user.id, encryptString(secret, config.APP_SECRET));
  for (const [seconds, code] of [
    [59, "287082"],
    [1111111109, "081804"],
    [1111111111, "050471"],
    [1234567890, "005924"],
    [2000000000, "279037"],
    [20000000000, "353130"],
  ] as const) {
    vi.spyOn(Date, "now").mockReturnValue(seconds * 1000);
    const challenge = mfa.challenge(user.id, user.password_hash);
    expect(mfa.verifyChallenge(challenge, code)?.id).toBe(user.id);
    expect(mfa.verifyChallenge(challenge, code)).toBeNull();
    const second = mfa.challenge(user.id, user.password_hash);
    expect(mfa.verifyChallenge(second, code)).toBeNull();
  }
});
it("bounds guesses, expires challenges and invalidates them after a password change", async () => {
  const { db, config, user, secret, mfa } = await fixture();
  const time = vi.spyOn(Date, "now").mockReturnValue(59000);
  db.sqlite
    .prepare("INSERT INTO user_mfa VALUES(?,?,-1,'[]')")
    .run(user.id, encryptString(secret, config.APP_SECRET));
  const exhausted = mfa.challenge(user.id, user.password_hash);
  for (let i = 0; i < 5; i++)
    expect(mfa.verifyChallenge(exhausted, "000000")).toBeNull();
  expect(mfa.verifyChallenge(exhausted, "287082")).toBeNull();
  const expired = mfa.challenge(user.id, user.password_hash);
  time.mockReturnValue(400000);
  expect(mfa.verifyChallenge(expired, "287082")).toBeNull();
  time.mockReturnValue(59000);
  const stale = mfa.challenge(user.id, user.password_hash);
  db.sqlite
    .prepare("UPDATE users SET password_hash='changed' WHERE id=?")
    .run(user.id);
  expect(mfa.verifyChallenge(stale, "287082")).toBeNull();
});
it("enables only after confirmation, revokes other sessions and stores single-use recovery hashes", async () => {
  const { db, config, user, secret, mfa } = await fixture();
  vi.spyOn(Date, "now").mockReturnValue(59000);
  db.sqlite
    .prepare("INSERT INTO mfa_enrollments VALUES(?,?,?,?)")
    .run(
      user.id,
      encryptString(secret, config.APP_SECRET),
      user.password_hash,
      500000,
    );
  db.createSession({
    token_hash: "keep",
    user_id: user.id,
    csrf_hash: "x",
    csrf_token: "x",
    expires_at: "2099-01-01",
    created_at: new Date().toISOString(),
  });
  db.createSession({
    token_hash: "remove",
    user_id: user.id,
    csrf_hash: "x",
    csrf_token: "x",
    expires_at: "2099-01-01",
    created_at: new Date().toISOString(),
  });
  expect(mfa.enable(user.id, user.password_hash, "000000", "keep")).toBeNull();
  const result = mfa.enable(user.id, user.password_hash, "287082", "keep")!;
  expect(result.recoveryCodes).toHaveLength(10);
  expect(db.sqlite.prepare("SELECT token_hash FROM sessions").all()).toEqual([
    { token_hash: "keep" },
  ]);
  const persisted = db.sqlite.prepare("SELECT * FROM user_mfa").get();
  expect(JSON.stringify(persisted)).not.toContain(secret);
  expect(JSON.stringify(persisted)).not.toContain(result.recoveryCodes[0]);
  expect(
    mfa.verifyChallenge(
      mfa.challenge(user.id, user.password_hash),
      result.recoveryCodes[0]!,
    )?.id,
  ).toBe(user.id);
  expect(
    mfa.verifyChallenge(
      mfa.challenge(user.id, user.password_hash),
      result.recoveryCodes[0]!,
    ),
  ).toBeNull();
});
it("requires the browser-bound second factor before issuing a session and audits without credentials", async () => {
  const { app, db, config, user, secret } = await fixture();
  db.sqlite
    .prepare("INSERT INTO user_mfa VALUES(?,?,-1,?)")
    .run(
      user.id,
      encryptString(secret, config.APP_SECRET),
      JSON.stringify([hashToken("11223344556677889900")]),
    );
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: user.email, password: config.ADMIN_PASSWORD },
  });
  expect(login.json()).toEqual({ mfaRequired: true });
  expect(
    login.cookies.some((cookie) => cookie.name === "shelter_session"),
  ).toBe(false);
  const challenge = login.cookies.find(
    (cookie) => cookie.name === "shelter_mfa",
  )!;
  expect(challenge.httpOnly).toBe(true);
  const withoutCookie = await app.inject({
    method: "POST",
    url: "/api/auth/mfa/challenge",
    payload: { code: "11223344556677889900" },
  });
  expect(withoutCookie.statusCode).toBe(401);
  const crossOrigin = await app.inject({ method: "POST", url: "/api/auth/mfa/challenge", headers: { cookie: `shelter_mfa=${challenge.value}`, origin: "https://untrusted.example.com" }, payload: { code: "11223344556677889900" } });
  expect(crossOrigin.statusCode).toBe(403);
  const verified = await app.inject({
    method: "POST",
    url: "/api/auth/mfa/challenge",
    headers: { cookie: `shelter_mfa=${challenge.value}` },
    payload: { code: "11223344556677889900" },
  });
  expect(verified.statusCode).toBe(200);
  const session = verified.cookies.find(
    (cookie) => cookie.name === "shelter_session",
  )!;
  expect(session).toBeDefined();
  const events = await app.inject({
    url: "/api/auth/security-events",
    headers: { cookie: `shelter_session=${session.value}` },
  });
  expect(events.statusCode).toBe(200);
  expect(
    events
      .json()
      .events.some((event: { event: string }) => event.event === "auth.login"),
  ).toBe(true);
  const stored = JSON.stringify(
    db.sqlite.prepare("SELECT * FROM security_events").all(),
  );
  for (const credential of [
    secret,
    challenge.value,
    session.value,
    "11223344556677889900",
  ])
    expect(stored).not.toContain(credential);
  const denied = await app.inject({ url: "/api/auth/security-events" });
  expect(denied.statusCode).toBe(401);
});
