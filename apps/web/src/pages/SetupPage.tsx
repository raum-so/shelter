import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { ArrowRight, Check, Circle, RefreshCw } from 'lucide-react';
import { api } from '../api/client';
import { useI18n } from '../i18n';
import { Button, ErrorState, PageIntro, Skeleton } from '../components/ui';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert';
import { setupProgress } from '../utils/setup';
import { SettingsPage } from './SettingsPage';
import { NewProjectPage } from './NewProjectPage';

export function SetupPage() {
  const { t } = useI18n();
  const { step } = useParams();
  const overview = useQuery({
    queryKey: ['overview'],
    queryFn: api.overview,
    refetchInterval: 10_000,
  });
  const cloudflare = useQuery({
    queryKey: ['cloudflare-settings'],
    queryFn: api.cloudflare,
    refetchInterval: 10_000,
  });
  const github = useQuery({
    queryKey: ['github-settings'],
    queryFn: api.github,
  });
  const refresh = () => {
    void overview.refetch();
    void cloudflare.refetch();
    void github.refetch();
  };
  if (overview.isPending || cloudflare.isPending || github.isPending)
    return (
      <Skeleton
        className="h-72"
        aria-label={t('Loading setup', 'Einrichtung wird geladen')}
      />
    );
  if (overview.isError || cloudflare.isError || github.isError)
    return (
      <ErrorState
        title={t(
          'Setup status unavailable',
          'Einrichtungsstatus nicht verfügbar',
        )}
        message={t(
          'Check your connection and load the current status again.',
          'Prüfe deine Verbindung und lade den aktuellen Status erneut.',
        )}
        action={
          <Button onClick={refresh}>
            {t('Try again', 'Erneut versuchen')}
          </Button>
        }
      />
    );
  const state = setupProgress(
    overview.data,
    cloudflare.data,
    github.data.connected &&
      github.data.installations.some(
        (installation) => !installation.suspendedAt,
      ),
  );
  const steps = [
    {
      id: 'server',
      title: t('Server ready', 'Server bereit'),
      done: state.server,
      to: '/server',
      description: t(
        'The API is reachable. The worker must be online before deployments can run.',
        'Die API ist erreichbar. Der Worker muss für Deployments online sein.',
      ),
    },
    {
      id: 'cloudflare',
      title: t(
        'Connect Cloudflare & choose a domain',
        'Cloudflare verbinden & Domain wählen',
      ),
      done: state.connection,
      to: '/setup/cloudflare',
      description: t(
        'Use the token template, select a domain and let Shelter create the tunnel and DNS record.',
        'Nutze die Token-Vorlage, wähle eine Domain und lasse Shelter Tunnel und DNS-Eintrag erstellen.',
      ),
    },
    {
      id: 'protection',
      title: t('Protect your panel', 'Panel schützen'),
      done: state.protection,
      to: '/setup/protection',
      description: t(
        'Configure Cloudflare Access for the exact panel hostname and confirm your review. Shelter does not inspect the policy automatically.',
        'Richte Cloudflare Access für den genauen Panel-Hostnamen ein und bestätige deine Prüfung. Shelter prüft die Richtlinie nicht automatisch.',
      ),
    },
    {
      id: 'github',
      title: t('Connect GitHub (optional)', 'GitHub verbinden (optional)'),
      done: state.github,
      to: '/setup/github',
      description: t(
        'Confirm your dedicated GitHub App and choose the repositories it may access. You can also use an upload or public Git URL.',
        'Bestätige deine eigene GitHub App und wähle die erlaubten Repositories. Alternativ kannst du einen Upload oder eine öffentliche Git-URL nutzen.',
      ),
    },
    {
      id: 'project',
      title: t('Deploy your first project', 'Erstes Projekt deployen'),
      done: state.deployed,
      to: '/setup/project',
      description: t(
        'Select your source. Shelter analyzes it and suggests build settings.',
        'Wähle deine Quelle. Shelter analysiert sie und schlägt Build-Einstellungen vor.',
      ),
    },
  ];
  const current = steps.find((item) => item.id === step);
  return (
    <div className="flex flex-col gap-6">
      <PageIntro
        title={t('Make yourself at home', 'Richte dein Shelter ein')}
        description={t(
          'From a fresh server to your first deployment. Progress comes from your actual configuration, so you can continue at any time.',
          'Vom frischen Server zum ersten Deployment. Der Fortschritt wird aus deiner Konfiguration ermittelt; du kannst jederzeit fortfahren.',
        )}
        actions={
          <Button variant="outline" onClick={refresh}>
            <RefreshCw aria-hidden="true" />
            {t('Refresh status', 'Status aktualisieren')}
          </Button>
        }
      />
      <nav aria-label={t('Setup progress', 'Einrichtungsfortschritt')}>
        <ol className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          {steps.map((item, index) => (
            <li key={item.id}>
              <Button
                asChild
                variant={current?.id === item.id ? 'default' : 'outline'}
                className="h-full min-h-11 w-full justify-start whitespace-normal text-left"
              >
                <Link
                  to={item.to}
                  aria-current={current?.id === item.id ? 'step' : undefined}
                >
                  {item.done ? (
                    <Check aria-hidden="true" />
                  ) : (
                    <Circle aria-hidden="true" />
                  )}
                  <span>
                    {index + 1}. {item.title}
                    <span className="sr-only">
                      {' '}
                      ·{' '}
                      {item.done
                        ? t('Complete', 'Abgeschlossen')
                        : t('Pending', 'Ausstehend')}
                    </span>
                  </span>
                </Link>
              </Button>
            </li>
          ))}
        </ol>
      </nav>
      {state.complete && (
        <Alert>
          <Check aria-hidden="true" />
          <AlertTitle>
            {t('Your Shelter is ready', 'Dein Shelter ist bereit')}
          </AlertTitle>
          <AlertDescription>
            {t(
              'A project is running and you have confirmed the panel protection.',
              'Ein Projekt läuft und du hast den Panel-Schutz bestätigt.',
            )}{' '}
            <Link to="/dashboard">
              {t('Open dashboard', 'Dashboard öffnen')}
            </Link>
          </AlertDescription>
        </Alert>
      )}
      {!step && (
        <div className="grid gap-4 md:grid-cols-2">
          {steps.map((item) => (
            <Card key={item.id}>
              <CardHeader>
                <CardTitle>{item.title}</CardTitle>
                <CardDescription>{item.description}</CardDescription>
              </CardHeader>
              <CardContent>
                <Button asChild variant={item.done ? 'outline' : 'default'}>
                  <Link to={item.to}>
                    {item.done
                      ? t('Review', 'Prüfen')
                      : t('Continue', 'Fortfahren')}
                    <ArrowRight aria-hidden="true" />
                  </Link>
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      {(step === 'cloudflare' || step === 'protection') && (
        <>
          <SettingsPage key="cloudflare" section="cloudflare" />
          <Button asChild className="self-start">
            <Link
              to={step === 'cloudflare' ? '/setup/protection' : '/setup/github'}
            >
              {t('Continue setup', 'Einrichtung fortsetzen')}
              <ArrowRight aria-hidden="true" />
            </Link>
          </Button>
        </>
      )}
      {step === 'github' && (
        <>
          <SettingsPage key="github" section="github" />
          <Button asChild className="self-start">
            <Link to="/setup/project">
              {state.github
                ? t('Choose first project', 'Erstes Projekt wählen')
                : t('Continue without GitHub', 'Ohne GitHub fortfahren')}
              <ArrowRight aria-hidden="true" />
            </Link>
          </Button>
        </>
      )}
      {step === 'project' && <NewProjectPage />}
    </div>
  );
}
