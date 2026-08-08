import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider, LOCALE_STORAGE_KEY } from '../i18n';
import { EnvironmentImportDialog } from './EnvironmentImportDialog';

function render(locale: 'en' | 'de') {
  vi.stubGlobal('window', {
    localStorage: { getItem: (key: string) => key === LOCALE_STORAGE_KEY ? locale : null },
    navigator: { language: locale, languages: [locale] },
  });
  return renderToStaticMarkup(
    <I18nProvider>
      <EnvironmentImportDialog existingKeys={['EXISTING_KEY']} onImport={() => undefined} />
    </I18nProvider>,
  );
}

describe('EnvironmentImportDialog', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('offers the localized paste action without rendering pasted values outside the dialog', () => {
    expect(render('en')).toContain('Paste .env');
    expect(render('de')).toContain('.env einfügen');
  });
});
