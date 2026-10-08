import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider, LOCALE_STORAGE_KEY } from '../i18n';
import type { ControlPlaneUpdateState } from '../types';
import { UpdatesPage } from './UpdatesPage';

function render(overrides: Partial<ControlPlaneUpdateState> = {}) {
  vi.stubGlobal('window', { localStorage: { getItem: (key: string) => key === LOCALE_STORAGE_KEY ? 'de' : null }, navigator: { language: 'de', languages: ['de'] } });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const state: ControlPlaneUpdateState = { currentVersion: '0.7.1', release: { tag: 'v0.7.2', version: '0.7.2', publishedAt: '2026-10-08T00:00:00Z', notes: '<script>untrusted()</script>' },
    checkedAt: null, updateAvailable: true, updaterReady: true, releaseInstallation: true, workerOnline: true, job: null, ...overrides };
  client.setQueryData(['control-plane-updates'], state);
  try {
    return renderToStaticMarkup(<QueryClientProvider client={client}><I18nProvider><MemoryRouter initialEntries={['/settings/updates']}><UpdatesPage /></MemoryRouter></I18nProvider></QueryClientProvider>);
  } finally { client.clear(); }
}

function updateButton(html: string) {
  const index = html.indexOf('Auf 0.7.2 aktualisieren');
  expect(index).toBeGreaterThan(0);
  return html.slice(html.lastIndexOf('<button', index), html.indexOf('</button>', index));
}

afterEach(() => vi.unstubAllGlobals());

describe('panel update availability and progress', () => {
  it('shows both versions, an actionable update and escaped provider notes in German', () => {
    const html = render();
    expect(html).toContain('0.7.1'); expect(html).toContain('0.7.2');
    expect(updateButton(html)).not.toContain('disabled=""');
    expect(html).toContain('&lt;script&gt;untrusted()&lt;/script&gt;');
    expect(html).not.toContain('<script>untrusted()');
  });

  it.each([{ updaterReady: false }, { workerOnline: false }])('prevents starting when a required host capability is unavailable: %j', (state) => {
    expect(updateButton(render(state))).toContain('disabled=""');
  });

  it('keeps controls disabled while a persistent host job is installing', () => {
    const html = render({ job: { id: 'a'.repeat(32), tag: 'v0.7.2', fromVersion: '0.7.1', phase: 'installing' } });
    expect(updateButton(html)).toContain('disabled=""');
    expect(html).toContain('Shelter wird installiert und geprüft');
    expect(html).toContain('aria-live="polite"');
  });

  it('describes operator recovery after failure without offering an automatic rollback', () => {
    const html = render({ job: { id: 'a'.repeat(32), tag: 'v0.7.2', fromVersion: '0.7.1', phase: 'failed' } });
    expect(html).toContain('Update fehlgeschlagen');
    expect(html).toContain('Nutze rollback nur, wenn doctor ein bereites Rollback-Paket meldet.');
    expect(updateButton(html)).not.toContain('disabled=""');
  });
});
