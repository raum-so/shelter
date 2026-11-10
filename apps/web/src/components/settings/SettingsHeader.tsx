import { useEffect, useRef, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useI18n } from '@/i18n';
import { Button, PageIntro } from '@/components/ui';

export type SettingsSection = 'cloudflare' | 'github' | 'api' | 'security' | 'branding' | 'updates' | 'smtp';

export function SettingsHeader({
  section,
  status,
}: {
  section: SettingsSection;
  status?: ReactNode;
}) {
  const { t } = useI18n();
  const activeItem = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    const active = activeItem.current;
    const navigation = active?.parentElement;
    if (!active || !navigation) return;
    const reveal = () => {
      const item = active.getBoundingClientRect(), viewport = navigation.getBoundingClientRect();
      // Keep the selected section visible without moving the page, including
      // width changes after fonts or asynchronously loaded content arrive.
      if (item.right > viewport.right) navigation.scrollLeft += item.right - viewport.right + 16;
      else if (item.left < viewport.left) navigation.scrollLeft += item.left - viewport.left - 16;
    };
    const observer = new ResizeObserver(reveal);
    observer.observe(navigation);
    observer.observe(active);
    reveal();
    return () => observer.disconnect();
  }, [section]);
  const copy = {
    smtp: {title:t('Email & SMTP','E-Mail & SMTP'),description:t('Configure one secure mail server for this installation and its services.','Konfiguriere einen sicheren Mailserver für diese Installation und ihre Dienste.')},
    updates: { title: t('Updates', 'Updates'), description: t('Check your installed version and update Shelter from a verified release.', 'Prüfe deine installierte Version und aktualisiere Shelter mit einem verifizierten Release.') },
    branding: { title: t('Branding', 'Branding'), description: t('Make this platform your own. Preview, save and transfer your brand identity.', 'Gestalte diese Plattform mit deiner Marke. Identität vorschauen, speichern und übertragen.') },
    cloudflare: {
      title: t('Cloudflare & routing', 'Cloudflare & Routing'),
      description: t(
        'Manage Cloudflare access, your tunnel, and this panel’s domain.',
        'Verwalte den Cloudflare-Zugang, deinen Tunnel und die Domain dieses Panels.',
      ),
    },
    github: {
      title: 'GitHub',
      description: t(
        'Connect repositories securely and deploy new commits automatically.',
        'Verbinde Repositories sicher und deploye neue Commits automatisch.',
      ),
    },
    api: {
      title: 'API & CLI',
      description: t(
        'Create and revoke access tokens for automations and the Shelter CLI.',
        'Erstelle und widerrufe Zugriffstoken für Automationen und die Shelter CLI.',
      ),
    },
    security: {
      title: t('Security', 'Sicherheit'),
      description: t(
        'Protect administrative access to this Shelter workspace.',
        'Schütze den administrativen Zugang zu diesem Shelter-Workspace.',
      ),
    },
  } satisfies Record<SettingsSection, { title: string; description: string }>;

  const items = [
    { key: 'branding' as const, to: '/settings/branding', label: t('Branding', 'Branding') },
    { key: 'cloudflare' as const, to: '/settings/cloudflare', label: 'Cloudflare & Routing' },
    { key: 'github' as const, to: '/settings/github', label: 'GitHub' },
    { key: 'smtp' as const, to: '/settings/smtp', label: t('Email & SMTP', 'E-Mail & SMTP') },
    { key: 'api' as const, to: '/settings/api', label: 'API & CLI' },
    { key: 'security' as const, to: '/settings/security', label: t('Security', 'Sicherheit') },
    { key: 'updates' as const, to: '/settings/updates', label: t('Updates', 'Updates') },
  ];

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageIntro
        eyebrow={t('Settings', 'Einstellungen')}
        title={copy[section].title}
        description={copy[section].description}
        actions={<div className="flex flex-wrap items-center gap-3">{status}<Button asChild variant="ghost" size="sm"><Link to="/setup">{t('Setup guide', 'Einrichtung')}</Link></Button></div>}
      />
      <nav className="flex h-11 min-w-0 gap-2 overflow-x-auto overflow-y-hidden border-b [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" aria-label={t('Settings sections', 'Einstellungsbereiche')}>
        {items.map(({ key, to, label }) => {
          const active = section === key;
          return (
            <Link
              key={key}
              ref={active ? activeItem : undefined}
              to={to}
              aria-current={active ? 'page' : undefined}
              className="relative inline-flex h-full shrink-0 items-center px-3 text-sm font-medium whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40 aria-[current=page]:text-foreground after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:rounded-full aria-[current=page]:after:bg-foreground"
            >
              {label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
