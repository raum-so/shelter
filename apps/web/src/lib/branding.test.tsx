import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { Brand } from '../components/Brand';
import { BrandFooter } from '../components/BrandFooter';
import { I18nProvider, localize } from '../i18n';
import { DEFAULT_BRANDING, setBranding } from './brand';

afterEach(() => { vi.unstubAllGlobals(); setBranding({ profile: DEFAULT_BRANDING, revision: '' }); });
describe('platform brand presentation', () => {
  it('encodes bootstrap revisions when updating browser asset URLs', () => {
    const icon = { href: '' }, theme = { href: '' };
    vi.stubGlobal('document', {
      title: '', documentElement: { classList: { contains: () => false } },
      querySelector: (selector: string) => selector === '#branding-theme' ? theme : null,
      querySelectorAll: () => [icon],
    });
    setBranding({ profile: DEFAULT_BRANDING, revision: '"><img src=x onerror=alert(1)>&v=other' });
    expect(icon.href).toBe('/api/branding/assets/icon?v=%22%3E%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E%26v%3Dother');
    expect(theme.href).toBe('/api/branding/theme.css?v=%22%3E%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E%26v%3Dother');
  });
  it('renders the selected identity and footer and preserves user values in translated copy', () => {
    setBranding({ revision: 'test', profile: { ...DEFAULT_BRANDING, name: 'Acme <Cloud>', claim: 'Your $& workspace', footer: 'Acme Ltd.', supportUrl: 'https://support.example.com' } });
    const html = renderToStaticMarkup(<MemoryRouter><I18nProvider><Brand showClaim /><BrandFooter /></I18nProvider></MemoryRouter>);
    expect(html).toContain('Acme &lt;Cloud&gt;');
    expect(html).toContain('Your $&amp; workspace');
    expect(html).toContain('Acme Ltd.');
    expect(html).toContain('href="https://support.example.com"');
    expect(html).not.toContain('Shelter home');
    expect(localize('Shelter project {name}', 'Shelter-Projekt {name}', { name: 'Shelter test' }, 'en')).toBe('Acme <Cloud> project Shelter test');
    setBranding({ profile: DEFAULT_BRANDING, revision: '' });
    expect(localize('Shelter home', 'Shelter Startseite', undefined, 'en')).toBe('Shelter home');
  });
});
