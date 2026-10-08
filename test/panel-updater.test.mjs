import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { test } from 'node:test';

const runner = new URL('../ops/panel-updater.sh', import.meta.url).pathname;
const request = { id: 'a'.repeat(32), tag: 'v1.0.0', fromVersion: '0.7.1' };

function sandbox(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shelter-panel-driver-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const installation = path.join(directory, 'installation');
  const bin = path.join(directory, 'bin');
  const bridge = path.join(installation, '.shelter-updates');
  for (const name of [bin, `${installation}/ops/lib`, `${bridge}/requests`, `${bridge}/status`]) fs.mkdirSync(name, { recursive: true });
  const executable = (name, content) => fs.writeFileSync(name, content, { mode: 0o700 });
  executable(`${bin}/id`, '#!/bin/sh\necho 0\n');
  executable(`${bin}/gh`, '#!/bin/sh\nprintf "lookup\\n" >> "$TEST_LOG"\nprintf "%s\\n" "$TEST_LATEST"\n');
  executable(`${bin}/docker`, `#!/bin/sh
case "$1" in
  compose) echo abcdef123456 ;;
  inspect) printf '%s\n' "$TEST_RUNNING" ;;
  exec) printf 'pause\n' >> "$TEST_LOG"
        if [ -n "$TEST_PAUSE_FILE" ]; then
          attempts=0
          while [ ! -f "$TEST_PAUSE_FILE" ]; do attempts=$((attempts+1)); [ "$attempts" -le 100 ] || exit 1; /bin/sleep 0.1; done
        fi
        printf '%s\n' "$TEST_ACK" ;;
  *) exit 1 ;;
esac
`);
  executable(`${bin}/sleep`, '#!/bin/sh\nexit 0\n');
  if (spawnSync('sh', ['-c', 'command -v flock'], { encoding: 'utf8' }).status !== 0) {
    executable(`${bin}/flock`, '#!/usr/bin/env python3\nimport fcntl,sys\ntry: fcntl.flock(int(sys.argv[-1]),fcntl.LOCK_EX|fcntl.LOCK_NB)\nexcept BlockingIOError: sys.exit(1)\n');
  }
  // macOS does not ship coreutils timeout. Preserve a real bounded process call.
  executable(`${bin}/timeout`, `#!${process.execPath}
const {spawnSync}=require('node:child_process');
const [duration, command, ...args]=process.argv.slice(2);
const result=spawnSync(command,args,{timeout:Number(duration.replace('s',''))*1000});
if(result.stdout) process.stdout.write(result.stdout);
process.exit(result.status ?? 1);
`);
  executable(`${bin}/rsync`, '#!/bin/sh\nprintf "transfer\\n" >> "$TEST_LOG"\n');
  executable(`${installation}/ops/download-release.sh`, `#!/bin/sh
printf 'verify-bundle\n' >> "$TEST_LOG"
[ "$TEST_DOWNLOAD_FAIL" != 1 ] || exit 1
[ "$1" = --repo ] && [ "$2" = raum-so/shelter ] && [ "$3" = --tag ] && [ "$4" = "$TEST_LATEST" ] || exit 1
mkdir -p "$6"
`);
  fs.writeFileSync(`${installation}/ops/lib/release-bundle.sh`, `shelter_release_load() { SHELTER_RELEASE_MANIFEST_SHA256=${'b'.repeat(64)}; }
`);
  // Installer verification and rollback are owned by deploy-release.test.sh.
  // This test owns only the IPC admission and delegation order around that helper.
  fs.writeFileSync(`${installation}/ops/lib/deploy-release-remote.sh`, `
printf '%s\n' "$1" >> "$TEST_LOG"
case "$1" in
 prepare) mkdir -p "$2/releases/.incoming/$3-$4" ;;
 activate) [ "$(jq -r .phase "$2/.shelter-updates/status/job.json")" = installing ] || exit 1
           [ "$TEST_ACTIVATE_FAIL" != 1 ] || exit 1 ;;
 cleanup) exit 0 ;;
 *) exit 1 ;;
esac
`);
  const logfile = path.join(directory, 'calls'); fs.writeFileSync(logfile, '');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_LOG: logfile,
    TEST_LATEST: request.tag, TEST_RUNNING: request.fromVersion, TEST_ACK: request.id, ...overrides };
  return {
    run: () => spawnSync('bash', [runner, installation], { env, encoding: 'utf8', timeout: 15000 }),
    runAsync: () => spawn('bash', [runner, installation], { env, stdio: 'ignore' }),
    submit: (value = request) => fs.writeFileSync(`${bridge}/requests/request.json`, JSON.stringify(value)),
    status: () => JSON.parse(fs.readFileSync(`${bridge}/status/job.json`, 'utf8')),
    calls: () => fs.readFileSync(logfile, 'utf8').trim().split('\n').filter(Boolean), bridge, directory
  };
}

test('idle service advertises readiness without fetching or installing', (t) => {
  const c = sandbox(t); assert.equal(c.run().status, 0);
  assert.ok(Date.parse(JSON.parse(fs.readFileSync(`${c.bridge}/status/ready.json`, 'utf8')).checkedAt));
  assert.deepEqual(c.calls(), []);
});

test('host waits for the exact worker acknowledgement and delegates the authenticated release in order', (t) => {
  const c = sandbox(t); c.submit(); const result = c.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(c.calls(), ['lookup', 'pause', 'verify-bundle', 'prepare', 'transfer', 'activate']);
  assert.equal(c.status().phase, 'succeeded');
  assert.equal(c.status().id, request.id);
  assert.equal(fs.existsSync(`${c.bridge}/requests/request.json`), false);
});

for (const [name, env, prohibited] of [
  ['a different latest release', { TEST_LATEST: 'v2.0.0' }, 'pause'],
  ['a changed installed version', { TEST_RUNNING: '0.7.0' }, 'pause'],
  ['a missing worker acknowledgement', { TEST_ACK: 'c'.repeat(32) }, 'verify-bundle'],
  ['a failed bundle verification', { TEST_DOWNLOAD_FAIL: '1' }, 'prepare'],
  ['a failed activation', { TEST_ACTIVATE_FAIL: '1' }, 'succeeded']
]) test(`fails safely on ${name}`, (t) => {
  const c = sandbox(t, env); c.submit(); assert.notEqual(c.run().status, 0);
  assert.equal(c.status().phase, 'failed');
  assert.ok(!c.calls().includes(prohibited));
  if (name === 'a failed activation') assert.equal(c.calls().at(-1), 'cleanup');
});

test('rejects path-bearing input and symlinks before provider access', (t) => {
  const c = sandbox(t); c.submit({ ...request, tag: 'v1.0.0/../../evil' });
  assert.notEqual(c.run().status, 0); assert.deepEqual(c.calls(), []);
  fs.unlinkSync(`${c.bridge}/requests/request.json`);
  fs.symlinkSync('/missing-fixture', `${c.bridge}/requests/request.json`);
  assert.notEqual(c.run().status, 0); assert.deepEqual(c.calls(), []);
});

test('an interrupted operation fails without retrying or removing the shared installation lock', (t) => {
  const c = sandbox(t); c.submit();
  fs.writeFileSync(`${c.bridge}/status/job.json`, JSON.stringify({ ...request, phase: 'installing', updatedAt: new Date().toISOString() }));
  assert.notEqual(c.run().status, 0); assert.equal(c.status().phase, 'failed');
  assert.deepEqual(c.calls(), []);
});

test('completed request identifiers cannot replay an older worker acknowledgement', (t) => {
  const c = sandbox(t); c.submit();
  fs.writeFileSync(`${c.bridge}/status/job.json`, JSON.stringify({ ...request, phase: 'succeeded', updatedAt: new Date().toISOString() }));
  assert.notEqual(c.run().status, 0); assert.equal(c.status().phase, 'failed'); assert.deepEqual(c.calls(), []);
});

test('concurrent host invocations do not overwrite status or consume the active request', async (t) => {
  const pauseFile = path.join(os.tmpdir(), `shelter-pause-${process.pid}-${Date.now()}`);
  t.after(() => fs.rmSync(pauseFile, { force: true }));
  const c = sandbox(t, { TEST_PAUSE_FILE: pauseFile }); c.submit();
  const running = c.runAsync();
  const finished = new Promise((resolve) => running.once('exit', resolve));
  t.after(() => running.kill('SIGTERM'));
  try {
    for (let attempt = 0; !c.calls().includes('pause') && attempt < 100; attempt++) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(c.calls().includes('pause'));
    assert.equal(c.run().status, 0);
    assert.deepEqual(c.calls(), ['lookup', 'pause']);
    assert.equal(c.status().phase, 'verifying');
    assert.equal(fs.existsSync(`${c.bridge}/requests/request.json`), true);
  } finally { fs.writeFileSync(pauseFile, 'resume'); await finished; }
  assert.equal(c.status().phase, 'succeeded');
});
