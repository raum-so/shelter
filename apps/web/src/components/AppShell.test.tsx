// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { AppShell } from './AppShell';
import { ThemeProvider } from './ThemeProvider';
import { I18nProvider, LOCALE_STORAGE_KEY } from '@/i18n';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it.each(['/settings/cloudflare', '/settings/smtp', '/settings/security'])(
  'keeps the settings destination active on %s',
  (path) => {
    vi.stubGlobal('localStorage', { getItem: (key: string) => key === LOCALE_STORAGE_KEY ? 'en' : null, setItem() {}, removeItem() {} });
    vi.stubGlobal('scrollTo', () => {});
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData(['overview'], { projects: [], stats: { projects: 0 }, system: { workerOnline: true } });
    render(
      <QueryClientProvider client={client}>
        <I18nProvider>
          <ThemeProvider defaultTheme="light">
            <MemoryRouter initialEntries={[path]}>
              <AppShell session={{ user: { id: 'admin', email: 'admin@example.com' }, csrfToken: null }} />
            </MemoryRouter>
          </ThemeProvider>
        </I18nProvider>
      </QueryClientProvider>,
    );
    expect(screen.getByRole('link', { name: 'Settings' }).getAttribute('aria-current')).toBe('page');
    client.clear();
  },
);
