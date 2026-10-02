import { useBranding } from '@/lib/brand';
import { useI18n } from '@/i18n';

export function BrandFooter() {
  const { profile } = useBranding();
  const { t } = useI18n();
  const links = [
    [profile.supportUrl, t('Support', 'Hilfe')],
    [profile.documentationUrl, t('Documentation', 'Dokumentation')],
    [profile.privacyUrl, t('Privacy', 'Datenschutz')],
    [profile.legalUrl, t('Legal', 'Impressum')],
  ].filter(([url]) => url);
  if (!links.length && !profile.footer) return null;
  return <footer className="grid gap-2 px-4 py-5 text-center text-xs text-muted-foreground">
    {profile.footer && <p className="break-words">{profile.footer}</p>}
    {links.length > 0 && <nav className="flex flex-wrap justify-center gap-x-4 gap-y-2" aria-label={t('Support and legal links', 'Hilfe und rechtliche Hinweise')}>
      {links.map(([url, label]) => <a key={label} href={url} rel="noreferrer" className="underline underline-offset-4 focus-visible:outline-2">{label}</a>)}
    </nav>}
  </footer>;
}
