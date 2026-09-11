import { describe, expect, it } from 'vitest';
import type { CloudflareSettings } from '../types';
import { setupProgress } from './setup';

const cloudflare: CloudflareSettings = {
  configured: true,
  connected: true,
  authorized: true,
  authMethod: 'api_token',
  oauthAvailable: false,
  oauthRedirectUri: null,
  oauthPending: false,
  accounts: [],
  oauthExpiresAt: null,
  reconnectRequired: false,
  accountId: 'a'.repeat(32),
  tunnelId: 'tunnel',
  tunnelName: 'shelter',
  panelDomain: 'panel.example.com',
  hasApiToken: true,
  accessProtection: {
    status: 'confirmed_by_admin',
    panelDomain: 'panel.example.com',
    confirmedHostname: 'panel.example.com',
    confirmedAt: '2026-09-11T10:00:00Z',
  },
};

describe('setup progress', () => {
  it('allows deployments without GitHub but requires worker, domain and hostname-bound protection', () => {
    const state = setupProgress(
      { system: { workerOnline: true }, stats: { running: 1 } },
      cloudflare,
      false,
    );
    expect(state.complete).toBe(true);
    expect(state.github).toBe(false);
    expect(
      setupProgress(
        { system: { workerOnline: false }, stats: { running: 1 } },
        cloudflare,
        true,
      ).complete,
    ).toBe(false);
  });
  it('does not count stale protection, missing domain, disconnection or an empty project list as complete', () => {
    const overview = { system: { workerOnline: true }, stats: { running: 1 } };
    expect(
      setupProgress(
        overview,
        { ...cloudflare, panelDomain: 'new.example.com' },
        true,
      ).protection,
    ).toBe(false);
    expect(
      setupProgress(overview, { ...cloudflare, panelDomain: null }, true)
        .complete,
    ).toBe(false);
    expect(
      setupProgress(overview, { ...cloudflare, connected: false }, true)
        .complete,
    ).toBe(false);
    expect(
      setupProgress(
        { system: { workerOnline: true }, projects: [] },
        cloudflare,
        true,
      ).complete,
    ).toBe(false);
  });
});
