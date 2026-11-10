import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import { ExternalDomainSettingsCard } from './ExternalDomains';

function renderSettings(configured: boolean, entry = '/settings/cloudflare') {
  vi.stubGlobal('window', { localStorage: { getItem: () => 'en' }, navigator: { language: 'en', languages: ['en'] } });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['external-domain-settings'], { configured, zoneId: configured ? 'a'.repeat(32) : null, cnameTarget: configured ? 'connect.example.com' : null });
  client.setQueryData(['external-domain-zones'], [{ id: 'a'.repeat(32), name: 'example.com' }]);
  try {
    return renderToStaticMarkup(<QueryClientProvider client={client}><I18nProvider><MemoryRouter initialEntries={[entry]}><ExternalDomainSettingsCard /></MemoryRouter></I18nProvider></QueryClientProvider>);
  } finally { client.clear(); }
}

afterEach(() => vi.unstubAllGlobals());

describe('project-first customer domain setup', () => {
  it.each([false, true])('keeps the shared setup form out of the default settings view (configured: %s)', configured => {
    const html = renderSettings(configured);
    expect(html).not.toContain('<form');
    expect(html).not.toContain('id="saas-zone"');
    expect(html).toContain(configured ? 'Edit basic setup' : 'Set up Cloudflare for SaaS');
  });

  it.each([
    ['customer-app', '/projects/customer-app?tab=domains&amp;connectDomain=external'],
    ['https://outside.example/path', '/projects/https%3A%2F%2Foutside.example%2Fpath?tab=domains&amp;connectDomain=external'],
  ])('opens the requested setup and keeps the return to %s inside a project route', (projectId, expectedHref) => {
    const html = renderSettings(false, `/settings/cloudflare?project=${encodeURIComponent(projectId)}#external-domains`);
    expect(html).toContain('id="external-domain-settings-form"');
    expect(html).toContain(`href="${expectedHref}"`);
    expect(html).toContain('Save and return to project');
  });
});
