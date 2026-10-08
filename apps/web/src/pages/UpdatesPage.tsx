import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { Check, Download, ExternalLink, RefreshCw, ShieldCheck, AlertTriangle } from 'lucide-react';
import { api, ApiError } from '@/api/client';
import { SettingsHeader } from '@/components/settings/SettingsHeader';
import { ErrorState, Skeleton } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Separator } from '@/components/ui/separator';
import { useI18n } from '@/i18n';
import type { ControlPlaneUpdateState } from '@/types';
import { formatDate } from '@/utils/format';

const pendingKey = 'shelter.pending-update';
function rememberedUpdate(): string | null {
  try { return sessionStorage.getItem(pendingKey); } catch { return null; }
}

export function UpdatesPage() {
  const { t } = useI18n();
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [backup, setBackup] = useState(false);
  const [pendingId, setPendingId] = useState(rememberedUpdate);
  const query = useQuery({ queryKey: ['control-plane-updates'], queryFn: api.controlPlaneUpdates, refetchInterval: 4_000, retry: false });
  const check = useMutation({ mutationFn: api.checkControlPlaneUpdates, onSuccess: (state) => client.setQueryData(['control-plane-updates'], state) });
  const start = useMutation({ mutationFn: api.startControlPlaneUpdate, onSuccess: (state) => {
    client.setQueryData(['control-plane-updates'], state);
    setOpen(false); setPassword(''); setBackup(false);
    if (state.job) {
      setPendingId(state.job.id);
      try { sessionStorage.setItem(pendingKey, state.job.id); } catch { /* Polling still works without browser storage. */ }
    }
  } });
  const state = query.data;
  const busy = state?.job && !['succeeded', 'failed'].includes(state.job.phase);

  useEffect(() => {
    if (!pendingId || state?.job?.id !== pendingId || !['succeeded', 'failed'].includes(state.job.phase)) return;
    if (state.job.phase === 'succeeded' && `v${state.currentVersion}` !== state.job.tag) return;
    try { sessionStorage.removeItem(pendingKey); } catch { /* Storage is optional. */ }
    setPendingId(null);
    if (state.job.phase === 'succeeded') window.location.reload();
  }, [pendingId, state]);

  function errorCopy(error: unknown): string {
    const code = error instanceof ApiError && error.details && typeof error.details === 'object' && 'code' in error.details ? String(error.details.code) : '';
    switch (code) {
      case 'CURRENT_PASSWORD_INVALID': return t('Your current password is incorrect.', 'Dein aktuelles Passwort ist nicht korrekt.');
      case 'UPDATER_UNAVAILABLE': return t('The VPS updater is unavailable. Enable it on the server or use the SSH update command.', 'Der VPS-Updater ist nicht verfügbar. Aktiviere ihn auf dem Server oder nutze den SSH-Update-Befehl.');
      case 'UPDATE_PROJECTS_BUSY': return t('Wait for deployments and project deletions to finish, then try again.', 'Warte, bis Deployments und Projektlöschungen abgeschlossen sind, und versuche es erneut.');
      case 'UPDATE_WORKER_OFFLINE': return t('The worker must be online before an update can start.', 'Der Worker muss online sein, bevor ein Update starten kann.');
      case 'UPDATE_RELEASE_CHANGED': return t('The release information changed. Check for updates again.', 'Die Release-Informationen haben sich geändert. Prüfe erneut auf Updates.');
      case 'UPDATE_STATE_INVALID': return t('The update status is unavailable. Check the updater on the VPS.', 'Der Update-Status ist nicht verfügbar. Prüfe den Updater auf dem VPS.');
      case 'UPDATE_BUSY': return t('An update is already in progress.', 'Ein Update läuft bereits.');
      default: return t('The request failed. Check the connection and try again.', 'Die Anfrage ist fehlgeschlagen. Prüfe die Verbindung und versuche es erneut.');
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (state?.release && backup && password) start.mutate({ tag: state.release.tag, fromVersion: state.currentVersion, currentPassword: password, backupConfirmed: true });
  }

  return <div className="flex flex-col gap-6">
    <SettingsHeader section="updates" status={state && <Badge variant="outline">Shelter {state.currentVersion}</Badge>} />
    {query.isPending && <Skeleton className="h-64" />}
    {query.isError && !state && <ErrorState title={t('Updates could not be loaded', 'Updates konnten nicht geladen werden')} message={errorCopy(query.error)} action={<Button variant="outline" onClick={() => void query.refetch()}>{t('Try again', 'Erneut versuchen')}</Button>} />}
    {state && <>
      {query.isError && <Alert role="status"><RefreshCw /><AlertTitle>{busy ? t('Reconnecting to Shelter', 'Verbindung zu Shelter wird wiederhergestellt') : t('Connection interrupted', 'Verbindung unterbrochen')}</AlertTitle><AlertDescription>{busy ? t('The panel briefly disconnects during an update. This page reconnects automatically.', 'Während eines Updates wird die Verbindung kurz unterbrochen. Diese Seite verbindet sich automatisch wieder.') : errorCopy(query.error)}</AlertDescription></Alert>}
      <Card>
        <CardHeader><CardTitle>{t('Shelter version', 'Shelter-Version')}</CardTitle><CardDescription>{t('Install a published release while keeping your configuration and projects.', 'Installiere ein veröffentlichtes Release und behalte deine Konfiguration und Projekte.')}</CardDescription></CardHeader>
        <CardContent className="flex flex-col gap-6">
          <dl className="grid gap-5 sm:grid-cols-2">
            <div><dt className="text-sm text-muted-foreground">{t('Installed', 'Installiert')}</dt><dd className="mt-1 text-2xl font-semibold tracking-tight">{state.currentVersion}</dd></div>
            <div><dt className="text-sm text-muted-foreground">{t('Latest release', 'Neuestes Release')}</dt><dd className="mt-1 text-2xl font-semibold tracking-tight">{state.release?.version ?? t('Not checked yet', 'Noch nicht geprüft')}</dd></div>
          </dl>
          {state.checkedAt && <p className="text-sm text-muted-foreground">{t('Last checked: {date}', 'Zuletzt geprüft: {date}', { date: formatDate(state.checkedAt) })}</p>}
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="outline" onClick={() => check.mutate()} disabled={check.isPending || Boolean(busy)}>{check.isPending ? <Spinner data-icon="inline-start" /> : <RefreshCw data-icon="inline-start" />}{t('Check for updates', 'Auf Updates prüfen')}</Button>
            {state.updateAvailable && <Button onClick={() => { start.reset(); setOpen(true); }} disabled={!state.updaterReady || !state.workerOnline || Boolean(busy)}><Download data-icon="inline-start" />{t('Update to {version}', 'Auf {version} aktualisieren', { version: state.release!.version })}</Button>}
            {state.release && !state.updateAvailable && <Badge variant="secondary"><Check data-icon="inline-start" />{t('No newer stable release', 'Kein neueres stabiles Release')}</Badge>}
          </div>
          {check.isError && <Alert variant="destructive" role="alert"><AlertTriangle /><AlertTitle>{t('Update check failed', 'Update-Prüfung fehlgeschlagen')}</AlertTitle><AlertDescription>{errorCopy(check.error)}</AlertDescription></Alert>}
        </CardContent>
      </Card>
      {state.job && <UpdateProgress state={state} />}
      {!state.updaterReady && !busy && <Card>
        <CardHeader><CardTitle>{t('Enable updates from this panel', 'Updates aus dem Panel aktivieren')}</CardTitle><CardDescription>{t('An administrator enables the updater once on the VPS. Until then, update using SSH.', 'Ein Administrator aktiviert den Updater einmalig auf dem VPS. Bis dahin erfolgt das Update über SSH.')}</CardDescription></CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">{state.releaseInstallation ? t('The updater needs GitHub CLI authentication as root and an active systemd timer.', 'Der Updater benötigt eine GitHub-CLI-Anmeldung als root und einen aktiven systemd-Timer.') : t('Install a verified Shelter release before enabling panel updates.', 'Installiere ein verifiziertes Shelter-Release, bevor du Panel-Updates aktivierst.')}</p>
          <pre className="overflow-x-auto rounded-md border bg-muted p-4 text-sm"><code>cd /opt/shelter{'\n'}./ops/enable-panel-updates.sh</code></pre>
          {state.release && <p className="text-sm">{t('From your local Shelter checkout:', 'Aus deinem lokalen Shelter-Checkout:')} <code className="break-all">./ops/deploy-release.sh --tag {state.release.tag}</code></p>}
        </CardContent>
      </Card>}
      {state.release && <Card>
        <CardHeader><CardTitle>{t('Release notes', 'Release-Informationen')}</CardTitle><CardDescription>{formatDate(state.release.publishedAt)}</CardDescription></CardHeader>
        <CardContent className="flex flex-col gap-4"><p className="whitespace-pre-wrap break-words text-sm leading-6">{state.release.notes || t('No release notes provided.', 'Keine Release-Informationen vorhanden.')}</p><Separator /><Button asChild variant="outline"><a href={`https://github.com/raum-so/shelter/releases/tag/${encodeURIComponent(state.release.tag)}`} target="_blank" rel="noopener noreferrer"><ExternalLink data-icon="inline-start" />{t('Open release on GitHub', 'Release auf GitHub öffnen')}</a></Button></CardContent>
      </Card>}
      <Dialog open={open} onOpenChange={(value) => { if (start.isPending) return; setOpen(value); setPassword(''); setBackup(false); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t('Update Shelter to {version}', 'Shelter auf {version} aktualisieren', { version: state.release?.version ?? '' })}</DialogTitle><DialogDescription>{t('The installer saves a database snapshot and checks the new version. The panel briefly disconnects; your project containers keep running during the snapshot.', 'Der Installer sichert die Datenbank und prüft die neue Version. Das Panel wird kurz getrennt; deine Projektcontainer laufen während der Sicherung weiter.')}</DialogDescription></DialogHeader>
          <form onSubmit={submit} className="flex flex-col gap-6">
            <FieldGroup>
              <Field orientation="horizontal"><Checkbox id="update-backup" checked={backup} onCheckedChange={(value) => setBackup(value === true)} disabled={start.isPending} /><FieldLabel htmlFor="update-backup">{t('I have a current, complete backup.', 'Ich habe ein aktuelles, vollständiges Backup.')}</FieldLabel></Field>
              <Field><FieldLabel htmlFor="update-password">{t('Current password', 'Aktuelles Passwort')}</FieldLabel><Input id="update-password" type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} disabled={start.isPending} /></Field>
            </FieldGroup>
            {start.isError && <Alert variant="destructive" role="alert"><AlertTriangle /><AlertTitle>{t('Update could not start', 'Update konnte nicht starten')}</AlertTitle><AlertDescription>{errorCopy(start.error)}</AlertDescription></Alert>}
            <DialogFooter><Button type="button" variant="outline" onClick={() => { setOpen(false); setPassword(''); setBackup(false); }} disabled={start.isPending}>{t('Cancel', 'Abbrechen')}</Button><Button type="submit" disabled={!backup || !password || start.isPending || Boolean(busy)}>{start.isPending ? <Spinner data-icon="inline-start" /> : <ShieldCheck data-icon="inline-start" />}{t('Start update', 'Update starten')}</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>}
  </div>;
}

function UpdateProgress({ state }: { state: ControlPlaneUpdateState }) {
  const { t } = useI18n();
  const job = state.job!;
  const phases = {
    queued: t('Update queued', 'Update vorgemerkt'),
    verifying: t('Downloading and verifying release', 'Release wird geladen und geprüft'),
    installing: t('Installing and checking Shelter', 'Shelter wird installiert und geprüft'),
    succeeded: t('Update completed', 'Update abgeschlossen'),
    failed: t('Update failed', 'Update fehlgeschlagen'),
  };
  return <Alert variant={job.phase === 'failed' ? 'destructive' : 'default'} role="status" aria-live="polite">
    {job.phase === 'succeeded' ? <Check /> : job.phase === 'failed' ? <AlertTriangle /> : <Spinner />}
    <AlertTitle>{phases[job.phase]} · {job.tag}</AlertTitle>
    <AlertDescription>{job.phase === 'failed'
      ? t('Check the updater and run doctor over SSH before retrying. Use rollback only when doctor reports a ready rollback package.', 'Prüfe den Updater und führe doctor über SSH aus, bevor du es erneut versuchst. Nutze rollback nur, wenn doctor ein bereites Rollback-Paket meldet.')
      : job.phase === 'succeeded'
        ? t('The release was installed and the server health checks passed.', 'Das Release wurde installiert und die Server-Prüfungen waren erfolgreich.')
        : t('You can leave this page and return to check progress. Shelter reconnects after the update.', 'Du kannst diese Seite verlassen und später den Fortschritt prüfen. Shelter verbindet sich nach dem Update wieder.')}</AlertDescription>
  </Alert>;
}
