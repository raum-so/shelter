// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { api, ApiError } from '@/api/client';
import { I18nProvider } from '@/i18n';
import type { Domain } from '@/types';
import { ExternalCustomerDomains, ExternalDomainSettingsCard } from './ExternalDomains';

const clients: QueryClient[] = [];
const input = { zoneId: 'a'.repeat(32), cnameTarget: 'hosting.example.com' };
const settings = { configured: false, zoneId: null, cnameTarget: null, suggestedZoneId: input.zoneId, suggestedCnameTarget: input.cnameTarget };
const plan = { token: 'preview-token', expiresAt: new Date(Date.now() + 300000).toISOString(), changes: [
  { id: 'rule-1', description: 'HTTP to HTTPS', before: 'http.request.scheme eq "http"', after: '(http.request.scheme eq "http") and not starts_with(http.request.uri.path, "/.well-known/acme-challenge/")' },
] };

function mount() {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  clients.push(client);
  client.setQueryData(['external-domain-settings'], settings);
  client.setQueryData(['external-domain-zones'], [{ id: input.zoneId, name: 'example.com' }]);
  const save = vi.spyOn(api, 'configureExternalDomains').mockResolvedValue({ ...settings, ...input, configured: true });
  render(<QueryClientProvider client={client}><I18nProvider><MemoryRouter initialEntries={['/settings/cloudflare?project=app']}><ExternalDomainSettingsCard authMethod="oauth" oauthAvailable /></MemoryRouter></I18nProvider></QueryClientProvider>);
  return { user: userEvent.setup(), save };
}

afterEach(() => {
  cleanup(); clients.splice(0).forEach(client => client.clear()); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it('shows the actual redirect changes and waits for approval before saving', async () => {
  const inspect = vi.spyOn(api, 'planExternalDomainRedirects').mockResolvedValue(plan);
  const { user, save } = mount();
  await user.click(screen.getByRole('button', { name: 'Save and return to project' }));
  expect(inspect.mock.calls[0]?.[0]).toEqual(input);
  expect(await screen.findByRole('dialog')).toBeTruthy();
  expect(screen.getByText(plan.changes[0]!.after)).toBeTruthy();
  expect(save).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Apply exception and save' }));
  await waitFor(() => expect(save.mock.calls[0]?.[0]).toEqual({ ...input, redirectPlanToken: plan.token }));
});

it('preserves the manual setup option without requesting or changing redirect rules', async () => {
  const inspect = vi.spyOn(api, 'planExternalDomainRedirects');
  const { user, save } = mount();
  await user.click(screen.getByRole('checkbox', { name: 'Allow certificate validation automatically' }));
  await user.click(screen.getByRole('button', { name: 'Save and return to project' }));
  await waitFor(() => expect(save.mock.calls[0]?.[0]).toEqual(input));
  expect(inspect).not.toHaveBeenCalled();
});

it.each(['inspection', 'apply'])('explains missing rights during %s and offers the feature-specific OAuth reconnect', async phase => {
  const error = new ApiError('Permission denied', 400, { code: 'ACME_REDIRECT_PERMISSION_REQUIRED' });
  const inspect = vi.spyOn(api, 'planExternalDomainRedirects');
  if (phase === 'inspection') inspect.mockRejectedValue(error);
  else inspect.mockResolvedValue(plan);
  const reconnect = vi.spyOn(api, 'startCloudflareOAuth').mockRejectedValue(new Error('Client must allow the scope first'));
  const { user, save } = mount();
  if (phase === 'apply') save.mockRejectedValue(error);
  await user.click(screen.getByRole('button', { name: 'Save and return to project' }));
  if (phase === 'apply') await user.click(await screen.findByRole('button', { name: 'Apply exception and save' }));
  await user.click(await screen.findByRole('button', { name: 'Reconnect for automatic exceptions' }));
  await waitFor(() => expect(reconnect).toHaveBeenCalledWith(true));
  if (phase === 'inspection') expect(save).not.toHaveBeenCalled();
  else expect(screen.getByRole('status').textContent).toContain('Some exceptions may already be saved');
});

it('accepts a root hostname in the project form and shows the provider-neutral ALIAS instructions', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  clients.push(client);
  client.setQueryData(['external-domain-settings'], { ...settings, ...input, configured: true });
  client.setQueryData(['project-domains', 'app'], []);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(document, 'getElementById').mockImplementation(() => null);
  const domain: Domain = {
    id: 'dom_apex', hostname: 'customer.de', connection: 'external', status: 'pending',
    external: {
      dnsMode: 'apex', phase: 'ownership', cnameTarget: input.cnameTarget, ownershipVerified: false, dnsReady: false,
      hostnameStatus: 'pending', tlsStatus: 'pending', lastCheckedAt: null, error: null,
      records: [{ type: 'ALIAS', name: 'customer.de', value: input.cnameTarget }]
    }
  };
  vi.spyOn(api, 'projectDomains').mockResolvedValue([domain]);
  const add = vi.spyOn(api, 'addExternalDomain').mockResolvedValue(domain);
  render(<QueryClientProvider client={client}><I18nProvider>
    <MemoryRouter initialEntries={['/projects/app?connectDomain=external']}>
      <ExternalCustomerDomains projectId="app" projectName="App" projectDomains={[]}
        onRemove={() => {}} onAddManaged={() => {}} onEditManaged={() => {}} />
    </MemoryRouter>
  </I18nProvider></QueryClientProvider>);
  const user = userEvent.setup();
  await user.type(await screen.findByRole('textbox', { name: 'Customer domain' }), domain.hostname);
  await user.click(screen.getByRole('button', { name: 'Continue to DNS setup' }));
  expect(await screen.findByText(/Set an ALIAS, ANAME or flattened CNAME at the zone root/)).toBeTruthy();
  expect(add).toHaveBeenCalledWith('app', domain.hostname);
});
