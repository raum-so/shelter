import { afterEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { Brand } from '../components/Brand';
import { BrandFooter } from '../components/BrandFooter';
import { I18nProvider, localize } from '../i18n';
import { DEFAULT_BRANDING, setBranding } from './brand';

afterEach(() => setBranding({ profile: DEFAULT_BRANDING, revision: '' }));
describe('platform brand presentation', () => {
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
