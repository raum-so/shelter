import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Database } from '../src/lib/database.js';
import { DEFAULT_BRANDING } from '../src/services/branding.js';

const contexts: Array<{ app: FastifyInstance; directory: string }> = [];
async function context() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shelter-branding-'));
  const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: directory, WEB_DIST: path.join(directory, 'web'), ADMIN_EMAIL: 'admin@example.com', ADMIN_PASSWORD: 'correct horse battery staple', APP_SECRET: 'b'.repeat(64), LOG_LEVEL: 'silent' });
  fs.mkdirSync(path.join(config.WEB_DIST, 'brand'), { recursive: true });
  fs.copyFileSync(new URL('../../web/index.html', import.meta.url), path.join(config.WEB_DIST, 'index.html'));
  const icon = fs.readFileSync(new URL('../../web/public/brand/shelter-icon-64.png', import.meta.url));
  fs.writeFileSync(path.join(config.WEB_DIST, 'brand/shelter-icon-512.png'), icon);
  const database = new Database(config);
  const app = await createApp(config, database);
  contexts.push({ app, directory });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@example.com', password: 'correct horse battery staple' } });
  const headers = { cookie: `shelter_session=${login.cookies.find((c) => c.name === 'shelter_session')!.value}`, 'x-csrf-token': login.json().csrfToken as string };
  const state = (await app.inject('/api/branding')).json();
  return { app, database, headers, state, icon, config };
}
afterEach(async () => { for (const { app, directory } of contexts.splice(0)) { await app.close(); fs.rmSync(directory, { recursive: true, force: true }); } });

describe('platform branding API', () => {
  it('exports a portable profile, previews imports without publishing, rejects stale writes and resets atomically', async () => {
    const { app, headers, state, icon } = await context();
    const profile = { ...state.profile, name: 'Acme Cloud', claim: 'Your workspace', icon: `data:image/png;base64,${icon.toString('base64')}`, supportUrl: 'https://support.example.com' };
    const validate = await app.inject({ method: 'POST', url: '/api/settings/branding/validate', headers, payload: { profile } });
    expect(validate.statusCode).toBe(200);
    expect((await app.inject('/api/branding')).json()).toEqual(state);
    const save = await app.inject({ method: 'PUT', url: '/api/settings/branding', headers, payload: { profile, revision: state.revision } });
    expect(save.statusCode).toBe(200);
    const exported = await app.inject({ url: '/api/settings/branding/export', headers });
    expect(exported.json()).toEqual(profile);
    expect(exported.headers['content-disposition']).toContain('branding.json');
    const stale = await app.inject({ method: 'PUT', url: '/api/settings/branding', headers, payload: { profile: state.profile, revision: state.revision } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('BRANDING_CONFLICT');
    const staleReset = await app.inject({ method: 'POST', url: '/api/settings/branding/reset', headers, payload: { revision: state.revision } });
    expect(staleReset.statusCode).toBe(409);
    const reset = await app.inject({ method: 'POST', url: '/api/settings/branding/reset', headers, payload: { revision: save.json().revision } });
    expect(reset.statusCode).toBe(200);
    expect(reset.json().profile).toEqual(DEFAULT_BRANDING);
    const restore = await app.inject({ method: 'PUT', url: '/api/settings/branding', headers, payload: { profile: exported.json(), revision: reset.json().revision } });
    expect(restore.statusCode).toBe(200);
    expect(restore.json().profile).toEqual(profile);
  });

  it('brands initial HTML, deep links, app metadata, theme and image responses without executing supplied text', async () => {
    const { app, headers, state, icon, database, config } = await context();
    const name = 'Acme </script><script>alert(1)</script> $&';
    const profile = { ...state.profile, name, description: 'A "private" <cloud>', icon: `data:image/png;base64,${icon.toString('base64')}`, light: { ...state.profile.light, primary: '#123456' } };
    expect((await app.inject({ method: 'PUT', url: '/api/settings/branding', headers, payload: { profile, revision: state.revision } })).statusCode).toBe(200);
    for (const url of ['/', '/index.html', '/settings/branding']) {
      const page = await app.inject({ url, headers: { accept: 'text/html' } });
      expect(page.statusCode).toBe(200);
      expect(page.headers['cache-control']).toBe('no-store');
      expect(page.body).toContain('Acme &lt;/script&gt;');
      expect(page.body).not.toContain('<script>alert(1)</script>');
      const embedded = page.body.match(/<script id="platform-branding" type="application\/json">([^]*?)<\/script>/)?.[1];
      expect(JSON.parse(embedded!).profile.name).toBe(name);
      expect(page.body).toContain('content="A &quot;private&quot; &lt;cloud&gt;"');
    }
    const manifest = await app.inject('/site.webmanifest');
    expect(manifest.json()).toMatchObject({ name, theme_color: '#123456' });
    expect((await app.inject('/api/branding/theme.css')).body).toContain('--primary:#123456');
    const asset = await app.inject('/api/branding/assets/icon');
    expect(asset.headers['content-type']).toContain('image/png');
    expect(asset.rawPayload).toEqual(icon);
    // A new database connection reads the same saved profile; state is not process-local.
    const reopened = new Database(config);
    expect(reopened.getSetting('platform.branding.v1')).toBe(database.getSetting('platform.branding.v1'));
    reopened.close();
  });

  it('allows public appearance reads but requires a session and CSRF for changes', async () => {
    const { app, headers, state } = await context();
    expect((await app.inject('/api/branding')).statusCode).toBe(200);
    expect((await app.inject('/api/settings/branding/export')).statusCode).toBe(401);
    expect((await app.inject({ method: 'PUT', url: '/api/settings/branding', payload: state })).statusCode).toBe(401);
    expect((await app.inject({ method: 'PUT', url: '/api/settings/branding', headers: { cookie: headers.cookie }, payload: state })).statusCode).toBe(403);
    const token = await app.inject({ method: 'POST', url: '/api/settings/api-tokens', headers, payload: { name: 'Branding test', access: 'write', currentPassword: 'correct horse battery staple' } });
    expect(token.statusCode, token.statusCode === 201 ? '' : token.body).toBe(201);
    expect((await app.inject({ method: 'PUT', url: '/api/settings/branding', headers: { authorization: `Bearer ${token.json().secret}` }, payload: state })).statusCode).toBe(403);
    expect((await app.inject('/api/branding')).json()).toEqual(state);
  });

  it.each([
    { version: 2 }, { name: '' }, { supportUrl: 'javascript:alert(1)' },
    { legalUrl: 'https://user:password@example.com' }, { icon: 'data:image/svg+xml,<svg onload="alert(1)"/>' },
    { icon: 'data:image/png;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==' },
    { APP_SECRET: 'not-an-appearance-field' },
    { light: { primary: '#123456', background: '#ffffff', foreground: '#ffffff', surface: '#ffffff' } },
    { light: { primary: 'red;display:none', background: '#ffffff', foreground: '#000000', surface: '#ffffff' } },
  ])('rejects unsafe or unsupported imported fields: %j', async (patch) => {
    const { app, headers, state } = await context();
    const response = await app.inject({ method: 'PUT', url: '/api/settings/branding', headers, payload: { profile: { ...state.profile, ...patch }, revision: state.revision } });
    expect(response.statusCode, response.body).toBe(400);
    expect((await app.inject('/api/branding')).json()).toEqual(state);
  });
});
