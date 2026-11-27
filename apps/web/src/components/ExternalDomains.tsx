import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, Check, CheckCircle2, ChevronDown, Circle, Clock3, Cloud, Copy, ExternalLink, Globe2, Info, LoaderCircle, MoreHorizontal, Pencil, Plus, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { api, ApiError } from '@/api/client';
import { currentLocale, useI18n } from '@/i18n';
import type { AcmeRedirectPlan, Domain, ExternalDomainDetails } from '@/types';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from './ui/accordion';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from './ui/card';
import { Checkbox } from './ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from './ui/dropdown-menu';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from './ui/empty';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from './ui/field';
import { Input } from './ui/input';
import { NativeSelect, NativeSelectOption } from './ui/native-select';
import { Skeleton } from './ui/skeleton';
import { DomainAccessSettings } from './DomainAccessSettings';

function Failure({ error, retry }: { error: unknown; retry?: () => void }) {
  const { t } = useI18n();
  const code = error instanceof ApiError && error.details && typeof error.details === 'object' && 'code' in error.details ? error.details.code : null;
  const redirectErrors: Record<string, string> = {
    ACME_REDIRECT_PERMISSION_REQUIRED: t('Automatic exceptions need Dynamic URL Redirects Write for OAuth, or Dynamic URL Redirects Edit for an API token. Allow this permission in the Cloudflare client and reconnect, or update the token for this zone.', 'Automatische Ausnahmen benötigen „Dynamic URL Redirects Write“ bei OAuth oder „Dynamic URL Redirects Edit“ beim API-Token. Erlaube das Recht im Cloudflare-Client und verbinde dich erneut, oder aktualisiere den Token für diese Zone.'),
    ACME_REDIRECT_PLAN_EXPIRED: t('The preview expired. Check the setup again.', 'Die Vorschau ist abgelaufen. Prüfe die Grundeinrichtung erneut.'),
    ACME_REDIRECT_DRIFT: t('The Cloudflare rules changed. Some exceptions may already be saved. Check the setup again to review the remaining changes.', 'Die Cloudflare-Regeln haben sich geändert. Einige Ausnahmen können bereits gespeichert sein. Prüfe die Grundeinrichtung erneut, um die verbleibenden Änderungen zu sehen.'),
    ACME_REDIRECT_UNSUPPORTED: t('These redirect rules cannot be changed safely automatically. Add the certificate-path exception manually in Cloudflare, then turn off automatic setup below.', 'Diese Weiterleitungsregeln können nicht sicher automatisch angepasst werden. Ergänze die Ausnahme für den Zertifikatspfad manuell in Cloudflare und deaktiviere unten die automatische Einrichtung.'),
    ACME_REDIRECT_BUSY: t('Another redirect update is running. Wait for it to finish, then check again.', 'Eine andere Änderung der Weiterleitungen läuft bereits. Warte kurz und prüfe danach erneut.'),
  };
  return <Alert variant="destructive">
    <Info />
    <AlertTitle>{t('This request could not be completed', 'Die Anfrage konnte nicht abgeschlossen werden')}</AlertTitle>
    <AlertDescription>{typeof code === 'string' && redirectErrors[code] || (error instanceof Error ? error.message : t('Check the connection and try again.', 'Prüfe die Verbindung und versuche es erneut.'))}</AlertDescription>
    {retry && <Button variant="outline" size="sm" className="col-start-2 mt-2 w-fit" onClick={retry}>{t('Try again', 'Erneut versuchen')}</Button>}
  </Alert>;
}

function domainCheckIsRunning(error: unknown): boolean {
  return error instanceof ApiError && error.details !== null && typeof error.details === 'object'
    && 'code' in error.details && error.details.code === 'DOMAIN_MUTATION_ACTIVE';
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return <Button type="button" variant="ghost" size="sm" className="shrink-0" aria-label={label} onClick={async () => {
    try { await navigator.clipboard.writeText(value); setCopied(true); }
    catch { toast.error(t('Select the text and copy it manually.', 'Markiere den Text und kopiere ihn manuell.')); }
  }}>
    {copied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
    <span aria-live="polite">{copied ? t('Copied', 'Kopiert') : t('Copy', 'Kopieren')}</span>
  </Button>;
}

export function ExternalDomainSettingsCard({ tunnelId, authMethod, oauthAvailable }: {
  tunnelId?: string | null; authMethod?: 'oauth' | 'api_token' | null; oauthAvailable?: boolean;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const projectId = searchParams.get('project');
  const projectReturn = projectId ? `/projects/${encodeURIComponent(projectId)}?tab=domains&connectDomain=external` : undefined;
  const settings = useQuery({ queryKey: ['external-domain-settings'], queryFn: api.externalDomainSettings });
  const [editing, setEditing] = useState(Boolean(projectId));
  const [zoneId, setZoneId] = useState('');
  const [cnameTarget, setTarget] = useState('');
  const [automaticRedirects, setAutomaticRedirects] = useState(true);
  const [preview, setPreview] = useState<{ plan: AcmeRedirectPlan; zoneId: string; cnameTarget: string } | null>(null);
  const showForm = editing;
  const usesPrimaryDomain = Boolean(settings.data?.suggestedCnameTarget && cnameTarget === settings.data.suggestedCnameTarget);
  const zones = useQuery({ queryKey: ['external-domain-zones'], queryFn: () => api.cloudflareZones(), enabled: showForm });
  useEffect(() => { if (projectId) setEditing(true); }, [projectId]);
  useEffect(() => {
    if (settings.data) { setZoneId(settings.data.zoneId ?? settings.data.suggestedZoneId ?? ''); setTarget(settings.data.cnameTarget ?? settings.data.suggestedCnameTarget ?? ''); }
  }, [settings.data]);
  useEffect(() => {
    if (settings.isSuccess && window.location.hash === '#external-domains') {
      document.getElementById('external-domains')?.scrollIntoView({ block: 'start' });
    }
  }, [settings.isSuccess]);
  const save = useMutation({
    mutationFn: api.configureExternalDomains,
    onError: () => setPreview(null),
    onSuccess: data => {
      setPreview(null);
      queryClient.setQueryData(['external-domain-settings'], data);
      setEditing(false);
      toast.success(t('Cloudflare for SaaS setup saved', 'Cloudflare-for-SaaS-Grundeinrichtung gespeichert'));
      if (projectReturn) navigate(projectReturn);
    },
  });
  const inspect = useMutation({
    mutationFn: api.planExternalDomainRedirects,
    onSuccess: (plan, input) => {
      if (plan.changes.length) setPreview({ plan, ...input });
      else save.mutate({ ...input, redirectPlanToken: plan.token });
    },
  });
  const reconnect = useMutation({ mutationFn: () => api.startCloudflareOAuth(true), onSuccess: result => { window.location.assign(result.authorizationUrl); } });
  const busy = save.isPending || inspect.isPending || reconnect.isPending;
  const permissionRequired = [inspect.error, save.error].some(error => error instanceof ApiError && typeof error.details === 'object'
    && error.details !== null && 'code' in error.details && error.details.code === 'ACME_REDIRECT_PERMISSION_REQUIRED');
  return <Card id="external-domains" className="scroll-mt-6">
    <CardHeader>
      <CardTitle>{t('Cloudflare for SaaS — basic setup', 'Cloudflare for SaaS – Grundeinrichtung')}</CardTitle>
      <CardDescription>{t('Shared technical connection for all projects. Add and manage customer domains in each project’s Domains tab.', 'Gemeinsame technische Verbindung für alle Projekte. Kundendomains legst du im Tab „Domains“ des jeweiligen Projekts an.')}</CardDescription>
      {projectReturn && <Button asChild variant="ghost" className="mt-2 w-fit"><Link to={projectReturn}><ArrowLeft data-icon="inline-start" />{t('Back to project', 'Zurück zum Projekt')}</Link></Button>}
    </CardHeader>
    <CardContent className="flex flex-col gap-5">
      {settings.isPending ? <Skeleton className="h-24" /> : settings.isError ? <Failure error={settings.error} retry={() => { void settings.refetch(); }} /> : <>
        {!showForm ? <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            {settings.data.configured ? <ShieldCheck className="mt-0.5 size-5 shrink-0 text-success" /> : <Cloud className="mt-0.5 size-5 shrink-0 text-muted-foreground" />}
            <div className="min-w-0"><p className="text-sm font-medium">{settings.data.configured ? t('Ready for customer domains', 'Bereit für Kundendomains') : t('Optional · not configured', 'Optional · noch nicht eingerichtet')}</p>
              {settings.data.configured ? <code className="mt-1 block break-all text-sm text-muted-foreground">{settings.data.cnameTarget}</code> : <><p className="mt-1 text-sm text-muted-foreground">{t('Only needed when a project uses external customer domains.', 'Nur erforderlich, wenn ein Projekt externe Kundendomains nutzen soll.')}</p>{settings.data.suggestedCnameTarget && <p className="mt-2 text-xs text-muted-foreground">{t('Suggested destination: your Shelter primary domain', 'Vorgeschlagenes Ziel: deine Shelter-Hauptdomain')} <code className="break-all">{settings.data.suggestedCnameTarget}</code></p>}</>}
            </div>
          </div>
          <Button variant="outline" onClick={() => { setEditing(true); save.reset(); inspect.reset(); }}><Pencil data-icon="inline-start" />{settings.data.configured ? t('Edit basic setup', 'Grundeinrichtung bearbeiten') : t('Set up Cloudflare for SaaS', 'Cloudflare for SaaS einrichten')}</Button>
        </div> : <>
          <div className="rounded-lg border bg-muted/30 p-4">
            <p className="text-sm font-medium">{t('First, in Cloudflare', 'Zuerst in Cloudflare')}</p>
            <ol className="mt-3 flex list-decimal flex-col gap-3 pl-5 text-sm text-muted-foreground">
              <li>{t('Select the provider domain, then enable SSL/TLS → Custom Hostnames.', 'Wähle die Anbieter-Domain und aktiviere SSL/TLS → Custom Hostnames.')}</li>
              <li>{t('Set the CNAME destination below as the SaaS fallback origin and wait for Active.', 'Trage das CNAME-Ziel unten als SaaS-Fallback-Origin ein und warte auf „Active“.')}
                {cnameTarget && <div className="mt-2 flex items-start justify-between gap-2 rounded-md border bg-background p-2"><code className="min-w-0 break-all pt-1 text-xs">{cnameTarget}</code><CopyButton value={cnameTarget} label={t('Copy CNAME destination', 'CNAME-Ziel kopieren')} /></div>}
                {usesPrimaryDomain && <p className="mt-2">{t('Your Shelter primary domain already points to this installation. Customers use this domain as their CNAME destination; the tunnel stays internal.', 'Deine Shelter-Hauptdomain zeigt bereits auf diese Installation. Kunden verwenden diese Domain als CNAME-Ziel; der Tunnel bleibt intern.')}</p>}
                {!usesPrimaryDomain && <details className="mt-2"><summary className="cursor-pointer">{t('DNS for a custom destination', 'DNS für ein eigenes Ziel')}</summary><p className="mt-2">{t('Create a proxied CNAME for this destination, pointing to the Shelter tunnel:', 'Erstelle für dieses Ziel einen CNAME mit aktiviertem Proxy zum Shelter-Tunnel:')}</p><div className="mt-2 flex items-start justify-between gap-2 rounded-md border bg-background p-2"><code className="min-w-0 break-all pt-1 text-xs">{tunnelId ? `${tunnelId}.cfargotunnel.com` : t('Connect Cloudflare first', 'Verbinde zuerst Cloudflare')}</code>{tunnelId && <CopyButton value={`${tunnelId}.cfargotunnel.com`} label={t('Copy tunnel destination', 'Tunnel-Ziel kopieren')} />}</div></details>}
              </li>
              <li>{t('Grant SSL and Certificates Write to the connected credential.', 'Erlaube dem verbundenen Zugang „SSL and Certificates Write“.')}</li>
            </ol>
            <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-sm">
              <a className="inline-flex items-center gap-1 underline underline-offset-4" href="https://dash.cloudflare.com/?to=%2F%3Aaccount%2F%3Azone%2Fssl-tls%2Fcustom-hostnames" target="_blank" rel="noreferrer">{t('Open Cloudflare', 'Cloudflare öffnen')}<ExternalLink className="size-3.5" /></a>
              <a className="text-muted-foreground underline underline-offset-4" href="https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/plans/" target="_blank" rel="noreferrer">{t('Check Cloudflare pricing', 'Cloudflare-Kosten prüfen')}</a>
            </div>
          </div>
          <form id="external-domain-settings-form" onSubmit={event => {
            event.preventDefault(); save.reset(); inspect.reset();
            if (automaticRedirects) inspect.mutate({ zoneId, cnameTarget });
            else save.mutate({ zoneId, cnameTarget });
          }}>
            <FieldGroup>
              <Field><FieldLabel htmlFor="saas-zone">{t('Provider domain', 'Anbieter-Domain')}</FieldLabel>
                <NativeSelect id="saas-zone" value={zoneId} disabled={busy || zones.isPending} required onChange={event => {
                  setZoneId(event.target.value);
                  const zone = zones.data?.find(item => item.id === event.target.value);
                  if (zone && !cnameTarget) setTarget(`connect.${zone.name}`);
                }}><NativeSelectOption value="">{zones.isPending ? t('Loading domains…', 'Domains werden geladen …') : t('Choose a Cloudflare domain', 'Cloudflare-Domain auswählen')}</NativeSelectOption>
                  {zones.data?.map(zone => <NativeSelectOption key={zone.id} value={zone.id}>{zone.name}</NativeSelectOption>)}
                  {zoneId && !zones.data?.some(zone => zone.id === zoneId) && <NativeSelectOption value={zoneId}>{t('Configured zone', 'Eingerichtete Zone')} · {zoneId.slice(0, 8)}</NativeSelectOption>}
                </NativeSelect>
                <FieldDescription>{t('An active domain in the connected Cloudflare account.', 'Eine aktive Domain im verbundenen Cloudflare-Konto.')}</FieldDescription>
              </Field>
              {zones.isError && <Failure error={zones.error} retry={() => { void zones.refetch(); }} />}
              <Field><FieldLabel htmlFor="saas-target">{t('Destination for customer CNAMEs', 'Ziel für Kunden-CNAMEs')}</FieldLabel>
                <Input id="saas-target" value={cnameTarget} onChange={event => setTarget(event.target.value.trim().toLowerCase())} placeholder="connect.example.com" required disabled={busy} autoCapitalize="none" autoCorrect="off" spellCheck={false} />
                <FieldDescription>{t('Use your Shelter primary domain or an existing dedicated fallback. Customers point their CNAME here. Existing connections keep their saved destination.', 'Verwende deine Shelter-Hauptdomain oder ein bestehendes eigenes Fallback-Ziel. Kunden richten ihren CNAME hierhin. Bestehende Verbindungen behalten ihr gespeichertes Ziel.')}</FieldDescription>
              </Field>
              <Field orientation="horizontal">
                <Checkbox id="saas-acme-redirects" checked={automaticRedirects} disabled={busy} onCheckedChange={value => setAutomaticRedirects(value === true)} />
                <div className="flex flex-col gap-2">
                  <FieldLabel htmlFor="saas-acme-redirects">{t('Allow certificate validation automatically', 'Zertifikatsprüfung automatisch ermöglichen')}</FieldLabel>
                  <FieldDescription>{t('Inspect enabled Single Redirects in this zone and preview an exception for /.well-known/acme-challenge/. Other paths keep their redirects. Requires Dynamic URL Redirects Write (OAuth) or Edit (API token).', 'Prüft aktive Single Redirects dieser Zone und zeigt eine Ausnahme für /.well-known/acme-challenge/ zur Freigabe an. Andere Pfade behalten ihre Weiterleitungen. Benötigt „Dynamic URL Redirects Write“ (OAuth) oder „Edit“ (API-Token).')}</FieldDescription>
                  {!automaticRedirects && <FieldDescription>{t('Ensure the certificate path is excluded manually. Bulk Redirects, Workers and other rules must be checked separately.', 'Stelle die Ausnahme für den Zertifikatspfad manuell sicher. Bulk Redirects, Workers und andere Regeln müssen separat geprüft werden.')}</FieldDescription>}
                </div>
              </Field>
            </FieldGroup>
          </form>
          {save.isError && <>
            <Failure error={save.error} />
            {save.variables?.redirectPlanToken && <p className="text-sm text-muted-foreground" role="status">{t('Some exceptions may already be saved. Check the setup again to review the remaining changes.', 'Einige Ausnahmen können bereits gespeichert sein. Prüfe die Grundeinrichtung erneut, um die verbleibenden Änderungen zu sehen.')}</p>}
          </>}
          {inspect.isError && <Failure error={inspect.error} />}
          {permissionRequired && authMethod === 'oauth' && oauthAvailable && <Button variant="outline" disabled={busy} onClick={() => reconnect.mutate()}>{t('Reconnect for automatic exceptions', 'Für automatische Ausnahmen neu verbinden')}</Button>}
          {permissionRequired && authMethod === 'api_token' && <Button asChild variant="outline"><a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noreferrer">{t('Edit Cloudflare API token', 'Cloudflare-API-Token bearbeiten')}<ExternalLink data-icon="inline-end" /></a></Button>}
          {reconnect.isError && <Failure error={reconnect.error} />}
        </>}
      </>}
    </CardContent>
    {showForm && <CardFooter className="flex flex-wrap gap-3">
      <Button type="submit" form="external-domain-settings-form" disabled={busy || !zoneId || !cnameTarget || zones.isError}>
        {busy ? <LoaderCircle className="animate-spin" data-icon="inline-start" /> : <Check data-icon="inline-start" />}
        {busy ? t('Checking setup…', 'Grundeinrichtung wird geprüft …') : projectReturn ? t('Save and return to project', 'Speichern und zurück zum Projekt') : t('Verify and save setup', 'Grundeinrichtung prüfen und speichern')}
      </Button>
      {!projectReturn && <Button variant="ghost" disabled={busy} onClick={() => { setEditing(false); setZoneId(settings.data?.zoneId ?? settings.data?.suggestedZoneId ?? ''); setTarget(settings.data?.cnameTarget ?? settings.data?.suggestedCnameTarget ?? ''); }}>{t('Cancel', 'Abbrechen')}</Button>}
    </CardFooter>}
    <Dialog open={Boolean(preview)} onOpenChange={open => { if (!open && !save.isPending) setPreview(null); }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('Review certificate exception', 'Ausnahme für Zertifikatsprüfung prüfen')}</DialogTitle>
          <DialogDescription>{t('Shelter will exclude the public certificate path from the following Single Redirects for this zone. Redirect destinations and other conditions are preserved. Bulk Redirects, Workers and other rules are not checked.', 'Shelter nimmt den öffentlichen Zertifikatspfad aus den folgenden Single Redirects dieser Zone aus. Weiterleitungsziele und andere Bedingungen bleiben erhalten. Bulk Redirects, Workers und andere Regeln werden nicht geprüft.')}</DialogDescription>
        </DialogHeader>
        <div className="flex max-h-[50vh] flex-col gap-4 overflow-y-auto">
          {preview?.plan.changes.map(change => <div key={change.id} className="flex flex-col gap-2 rounded-md border p-3">
            <p className="text-sm font-medium">{change.description}</p>
            <dl className="flex flex-col gap-2 text-xs">
              <div><dt className="text-muted-foreground">{t('Before', 'Vorher')}</dt><dd><code className="whitespace-pre-wrap break-all">{change.before}</code></dd></div>
              <div><dt className="text-muted-foreground">{t('After', 'Nachher')}</dt><dd><code className="whitespace-pre-wrap break-all">{change.after}</code></dd></div>
            </dl>
          </div>)}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={save.isPending} onClick={() => setPreview(null)}>{t('Cancel', 'Abbrechen')}</Button>
          <Button disabled={save.isPending || !preview} onClick={() => {
            if (preview) save.mutate({ zoneId: preview.zoneId, cnameTarget: preview.cnameTarget, redirectPlanToken: preview.plan.token });
          }}>{save.isPending && <LoaderCircle className="animate-spin" data-icon="inline-start" />}{t('Apply exception and save', 'Ausnahme anwenden und speichern')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </Card>;
}

function connectionLabel(domain: Domain, t: ReturnType<typeof useI18n>['t']): string {
  if (!domain.external) return domain.status === 'active' ? t('Connected', 'Verbunden') : domain.status === 'error' ? t('Setup failed', 'Einrichtung fehlgeschlagen') : t('Setting up DNS', 'DNS wird eingerichtet');
  const labels: Record<ExternalDomainDetails['phase'], string> = {
    ownership: t('Confirm ownership', 'Besitz bestätigen'),
    dns: domain.external.dnsMode === 'apex' ? t('Set apex DNS', 'DNS für Hauptdomain einrichten') : t('Set CNAME', 'CNAME einrichten'),
    certificate: t('HTTPS is being prepared', 'HTTPS wird vorbereitet'),
    deployment: t('Waiting for deployment', 'Warte auf Deployment'),
    active: t('Connected', 'Verbunden'),
    removing: t('Removal pending', 'Entfernung ausstehend'),
    error: t('Check connection', 'Verbindung prüfen'),
  };
  return labels[domain.external.phase];
}

function DnsInstructions({ domain }: { domain: Domain }) {
  const { t } = useI18n();
  const detail = domain.external!;
  const instructions = detail.records.map(record => `${record.type}\t${record.name}\t${record.value}`).join('\n');
  return <div className="flex flex-col gap-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h4 className="text-sm font-medium">{t('DNS records for the customer', 'DNS-Einträge für den Kunden')}</h4>
      <CopyButton value={instructions} label={t('Copy all DNS instructions', 'Gesamte DNS-Anleitung kopieren')} />
    </div>
    <p className="text-sm text-muted-foreground">{detail.dnsMode === 'apex'
      ? t('Set an ALIAS, ANAME or flattened CNAME at the zone root (@). Use the hostname below as the destination and select DNS only if the provider offers a proxy.', 'Lege an der Hauptdomain (@) einen ALIAS, ANAME oder CNAME mit Flattening an. Verwende den Hostnamen unten als Ziel und wähle „Nur DNS“, falls der Anbieter einen Proxy anbietet.')
      : t('Add these records at the customer’s DNS provider. Keep the customer CNAME set to DNS only, without a proxy.', 'Lege diese Einträge beim DNS-Anbieter des Kunden an. Verwende für den Kunden-CNAME „Nur DNS“, ohne Proxy.')}</p>
    {detail.records.map((record, index) => <div key={`${record.name}-${index}`} className="rounded-lg border bg-background p-3 sm:p-4">
      <div className="mb-3 flex items-center gap-2"><Badge variant="outline">{record.type}</Badge><span className="text-xs text-muted-foreground">{record.type === 'TXT' ? t('Confirms domain ownership or HTTPS', 'Bestätigt Domainbesitz oder HTTPS') : t('Routes visitors to the app', 'Leitet Besucher zur App')}</span></div>
      <dl className="flex flex-col gap-3">
        {[[t('Name / host', 'Name / Host'), record.name], [t('Value / destination', 'Wert / Ziel'), record.value]].map(([label, value]) => <div key={label}>
          <dt className="mb-1 text-xs text-muted-foreground">{label}</dt>
          <dd className="flex items-start justify-between gap-2 rounded-md bg-muted/50 px-3 py-2"><code className="min-w-0 break-all pt-1 text-xs leading-relaxed">{value}</code><CopyButton value={value!} label={t('Copy {label}', '{label} kopieren', { label: label! })} /></dd>
        </div>)}
      </dl>
    </div>)}
    <p className="text-xs leading-relaxed text-muted-foreground">{t('Some DNS providers append the domain automatically. In that case, enter only the part before the customer’s domain. Keep the TXT record until ownership is confirmed.', 'Manche DNS-Anbieter ergänzen die Domain automatisch. Trage dann nur den Teil vor der Kundendomain ein. Behalte den TXT-Eintrag, bis der Besitz bestätigt ist.')}</p>
  </div>;
}

function ExternalDomainDetail({ projectId, domain, disabled }: { projectId: string; domain: Domain; disabled: boolean }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const detail = domain.external!;
  const apex = detail.dnsMode === 'apex';
  const verify = useMutation({ mutationFn: () => api.verifyExternalDomain(projectId, domain.id), onSuccess: updated => {
    queryClient.setQueryData<Domain[]>(['project-domains', projectId], current => current?.map(item => item.id === updated.id ? updated : item));
    if (updated.status === 'active') {
      toast.success(t('Customer domain connected', 'Kundendomain verbunden'));
    } else if (updated.status === 'error') {
      toast.error(t('The domain check needs attention', 'Die Domainprüfung benötigt Aufmerksamkeit'), { description: updated.external?.error ?? updated.error ?? undefined });
    } else {
      const waiting = updated.external?.phase === 'ownership'
        ? t('The TXT proof is not visible through public DNS yet. Check the record and allow time for DNS caches to update.', 'Der TXT-Nachweis ist über öffentliche DNS-Server noch nicht sichtbar. Prüfe den Eintrag und warte, bis sich die DNS-Caches aktualisiert haben.')
        : updated.external?.phase === 'dns'
          ? apex
            ? t('The apex DNS answers do not match the Shelter destination yet.', 'Die öffentlichen DNS-Antworten der Hauptdomain stimmen noch nicht mit dem Shelter-Ziel überein.')
            : t('The expected CNAME is not visible through public DNS yet.', 'Der erwartete CNAME ist über öffentliche DNS-Server noch nicht sichtbar.')
          : updated.external?.phase === 'certificate'
            ? t('DNS is verified. Cloudflare is still preparing the HTTPS certificate.', 'DNS ist bestätigt. Cloudflare bereitet noch das HTTPS-Zertifikat vor.')
            : t('Domain and HTTPS are ready. The project needs an active deployment.', 'Domain und HTTPS sind bereit. Das Projekt benötigt ein aktives Deployment.');
      toast.info(t('Check completed', 'Prüfung abgeschlossen'), { description: waiting });
    }
  }, onError: error => {
    if (domainCheckIsRunning(error)) toast.info(t('A domain check is already running', 'Eine Domainprüfung läuft bereits'), {
      description: t('Shelter will refresh the status automatically. Wait for the current check to finish.', 'Shelter aktualisiert den Status automatisch. Warte, bis die laufende Prüfung abgeschlossen ist.'),
    });
  }, onSettled: () => {
    void queryClient.invalidateQueries({ queryKey: ['project-domains', projectId] });
    void queryClient.invalidateQueries({ queryKey: ['project', projectId] });
  } });
  const steps = [
    { title: t('Ownership', 'Besitznachweis'), done: detail.ownershipVerified },
    { title: apex ? 'ALIAS / Flattening' : 'CNAME', done: detail.dnsReady },
    { title: 'HTTPS', done: detail.hostnameStatus === 'active' && detail.tlsStatus === 'active' },
    { title: t('App available', 'App erreichbar'), done: domain.status === 'active' },
  ];
  const guidance: Record<ExternalDomainDetails['phase'], string> = {
    ownership: t('Add the TXT record below to confirm control of this domain.', 'Füge den TXT-Eintrag unten hinzu, um den Besitz dieser Domain zu bestätigen.'),
    dns: apex
      ? t('Public DNS does not match the Shelter destination yet. Check the ALIAS or flattened CNAME and allow time for DNS updates.', 'Öffentliches DNS stimmt noch nicht mit dem Shelter-Ziel überein. Prüfe den ALIAS oder CNAME mit Flattening und warte auf die DNS-Aktualisierung.')
      : t('Point the customer CNAME to the destination below. DNS updates can take a while to appear.', 'Richte den Kunden-CNAME auf das Ziel unten. DNS-Änderungen können etwas Zeit benötigen.'),
    certificate: apex && detail.hostnameStatus !== 'active' && detail.records.length > 2
      ? t('Add the additional TXT records shown below so Cloudflare can finish validation.', 'Ergänze die unten angezeigten TXT-Einträge, damit Cloudflare die Prüfung abschließen kann.')
      : t('Cloudflare is issuing the HTTPS certificate. Shelter checks automatically; no deployment is needed for this step.', 'Cloudflare stellt das HTTPS-Zertifikat aus. Shelter prüft automatisch; für diesen Schritt ist kein Deployment nötig.'),
    deployment: t('Domain and HTTPS are ready. Deploy the project to make the app available.', 'Domain und HTTPS sind bereit. Deploye das Projekt, damit die App erreichbar wird.'),
    active: t('Visitors reach this project securely through the customer domain. Your app receives the original hostname.', 'Besucher erreichen dieses Projekt sicher über die Kundendomain. Deine App erhält den ursprünglichen Hostnamen.'),
    removing: t('The route is disabled. Shelter will retry the Cloudflare cleanup automatically.', 'Die Route ist deaktiviert. Shelter versucht die Cloudflare-Bereinigung automatisch erneut.'),
    error: t('The last check could not complete. Review the DNS records, then check again.', 'Die letzte Prüfung konnte nicht abgeschlossen werden. Prüfe die DNS-Einträge und starte die Prüfung erneut.'),
  };
  return <div className="flex flex-col gap-5">
    <ol className="grid gap-3 sm:grid-cols-4" aria-label={t('Connection progress', 'Verbindungsfortschritt')}>
      {steps.map((step, index) => <li className="flex items-center gap-2 rounded-lg border px-3 py-2.5" key={step.title}>
        {step.done ? <CheckCircle2 className="size-4 shrink-0 text-success" /> : <Circle className="size-4 shrink-0 text-muted-foreground" />}
        <span className="text-xs"><span className="block font-medium">{index + 1}. {step.title}</span><span className="text-muted-foreground">{step.done ? t('Ready', 'Bereit') : t('Pending', 'Ausstehend')}</span></span>
      </li>)}
    </ol>
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="max-w-2xl"><p className="text-sm font-medium" role="status">{connectionLabel(domain, t)}</p><p className="mt-1 text-sm leading-relaxed text-muted-foreground">{guidance[detail.phase]}</p>
        {detail.lastCheckedAt && <p className="mt-2 text-xs text-muted-foreground">{t('Last checked', 'Zuletzt geprüft')}: {new Date(detail.lastCheckedAt).toLocaleString(currentLocale())}</p>}
      </div>
      <Button variant="outline" onClick={() => verify.mutate()} disabled={disabled || verify.isPending || detail.phase === 'removing'}>
        {verify.isPending ? <LoaderCircle className="animate-spin" data-icon="inline-start" /> : <RefreshCw data-icon="inline-start" />}
        {verify.isPending ? t('Checking…', 'Wird geprüft …') : t('Check now', 'Jetzt prüfen')}
      </Button>
    </div>
    {detail.error && <Alert variant={domain.status === 'active' ? 'default' : 'destructive'}><Info /><AlertTitle>{domain.status === 'active' ? t('Connection active; last check delayed', 'Verbindung aktiv; letzte Prüfung verzögert') : t('The connection needs attention', 'Die Verbindung muss geprüft werden')}</AlertTitle><AlertDescription>{detail.error}</AlertDescription></Alert>}
    {verify.isError && !domainCheckIsRunning(verify.error) && <Failure error={verify.error} />}
    {domain.status === 'active' ? <details className="rounded-lg border p-3"><summary className="cursor-pointer text-sm font-medium">{t('Show DNS instructions', 'DNS-Anleitung anzeigen')}</summary><div className="mt-4"><DnsInstructions domain={domain} /></div></details> : <DnsInstructions domain={domain} />}
  </div>;
}

interface DomainManagerProps {
  projectId: string;
  projectName: string;
  projectDomains: Domain[];
  onRemove: (domain: Domain) => void;
  onAddManaged: () => void;
  onEditManaged: (domain: Domain) => void;
  disabled?: boolean;
}

export function ExternalCustomerDomains({ projectId, projectName, projectDomains, onRemove, onAddManaged, onEditManaged, disabled = false }: DomainManagerProps) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [hostname, setHostname] = useState('');
  const [addOpen, setAddOpen] = useState(() => !disabled && searchParams.get('connectDomain') === 'external');
  useEffect(() => {
    if (disabled || searchParams.get('connectDomain') !== 'external') return;
    setAddOpen(true);
    const next = new URLSearchParams(searchParams);
    next.delete('connectDomain');
    setSearchParams(next, { replace: true });
  }, [disabled, searchParams, setSearchParams]);
  const [expanded, setExpanded] = useState<string[]>([]);
  const settings = useQuery({ queryKey: ['external-domain-settings'], queryFn: api.externalDomainSettings, enabled: addOpen });
  const query = useQuery({ queryKey: ['project-domains', projectId], queryFn: () => api.projectDomains(projectId), refetchInterval: 10000 });
  const domains = (query.data ?? projectDomains).map(domain => ({ ...projectDomains.find(item => item.id === domain.id), ...domain }));
  const connected = domains.filter(domain => domain.status === 'active').length;
  const hostnameValid = hostname.trim().length <= 220 && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(hostname.trim());
  const add = useMutation({ mutationFn: () => api.addExternalDomain(projectId, hostname.trim().toLowerCase()), onSuccess: async domain => {
    await queryClient.invalidateQueries({ queryKey: ['project-domains', projectId] });
    void queryClient.invalidateQueries({ queryKey: ['project', projectId] });
    setExpanded([domain.id]); setHostname(''); setAddOpen(false);
    window.setTimeout(() => document.getElementById(`domain-${domain.id}`)?.scrollIntoView({ block: 'nearest' }), 0);
    toast.success(t('Domain added. Follow its DNS instructions.', 'Domain hinzugefügt. Folge jetzt der DNS-Anleitung.'));
  } });
  function openExternalForm() { setHostname(''); add.reset(); setAddOpen(true); }
  const addMenu = <DropdownMenu><DropdownMenuTrigger asChild><Button disabled={disabled}><Plus data-icon="inline-start" />{t('Add domain', 'Domain hinzufügen')}<ChevronDown data-icon="inline-end" /></Button></DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="min-w-64"><DropdownMenuGroup>
      <DropdownMenuItem onSelect={onAddManaged}><Cloud /><span>{t('From Cloudflare', 'Aus Cloudflare')}<small className="block text-muted-foreground">{t('Use a domain in the connected account', 'Domain aus dem verbundenen Konto')}</small></span></DropdownMenuItem>
      <DropdownMenuItem onSelect={openExternalForm}><Globe2 /><span>{t('External customer domain', 'Externe Kundendomain')}<small className="block text-muted-foreground">{t('Use a domain or subdomain', 'Hauptdomain oder Subdomain verbinden')}</small></span></DropdownMenuItem>
    </DropdownMenuGroup></DropdownMenuContent>
  </DropdownMenu>;
  return <section className="flex flex-col gap-5" aria-label={t('Project domains', 'Projekt-Domains')}>
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div><h2 className="text-xl font-semibold tracking-tight">{t('Domains', 'Domains')}</h2><p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">{t('These domains lead to “{project}”. Connect a Cloudflare domain or an external customer domain for this project.', 'Diese Domains führen zu „{project}“. Verbinde eine Cloudflare-Domain oder eine externe Kundendomain mit diesem Projekt.', { project: projectName })}</p></div>
      <div className="shrink-0">{addMenu}</div>
    </div>
    {query.isPending ? <Skeleton className="h-36" /> : query.isError ? <Failure error={query.error} retry={() => { void query.refetch(); }} /> : domains.length === 0 ?
      <Empty className="min-h-64 rounded-xl border bg-card"><EmptyHeader><EmptyMedia variant="icon"><Globe2 /></EmptyMedia><EmptyTitle>{t('Give this app an address', 'Gib dieser App eine Adresse')}</EmptyTitle><EmptyDescription>{t('Connect a Cloudflare domain or a customer domain. Shelter handles routing and HTTPS.', 'Verbinde eine Cloudflare-Domain oder eine Kundendomain. Shelter übernimmt Routing und HTTPS.')}</EmptyDescription></EmptyHeader></Empty> :
      <Card>
        <CardHeader className="border-b"><CardTitle>{t('Connected addresses', 'Verknüpfte Adressen')}</CardTitle><CardDescription>{t('{connected} connected · {pending} awaiting setup', '{connected} verbunden · {pending} Einrichtung offen', { connected, pending: domains.length - connected })}</CardDescription></CardHeader>
        <CardContent>
          <Accordion type="multiple" value={expanded} onValueChange={setExpanded}>
            {domains.map(domain => <AccordionItem id={`domain-${domain.id}`} value={domain.id} key={domain.id}>
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1"><AccordionTrigger aria-label={t('Details for {hostname}', 'Details für {hostname}', { hostname: domain.hostname })}>
                  <span className="flex min-w-0 items-start gap-3 pr-2"><Globe2 className="mt-1 size-4 shrink-0 text-muted-foreground" /><span className="min-w-0"><span className="block break-all font-medium">{domain.hostname}</span><span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"><span>{domain.connection === 'external' ? domain.external?.dnsMode === 'apex' ? t('Customer domain · ALIAS', 'Kundendomain · ALIAS') : t('Customer domain · CNAME', 'Kundendomain · CNAME') : t('Managed in Cloudflare', 'In Cloudflare verwaltet')}</span><span className="inline-flex items-center gap-1">{domain.status === 'active' ? <CheckCircle2 className="size-3 text-success" /> : <Clock3 className="size-3" />}{connectionLabel(domain, t)}</span></span></span></span>
                </AccordionTrigger></div>
                <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label={t('Actions for {hostname}', 'Aktionen für {hostname}', { hostname: domain.hostname })} disabled={disabled}><MoreHorizontal /></Button></DropdownMenuTrigger><DropdownMenuContent align="end" className="min-w-44"><DropdownMenuGroup>
                  {domain.status === 'active' && <DropdownMenuItem asChild><a href={`https://${domain.hostname}`} target="_blank" rel="noreferrer"><ExternalLink />{t('Open website', 'Website öffnen')}</a></DropdownMenuItem>}
                  {domain.connection !== 'external' && <DropdownMenuItem onSelect={() => onEditManaged(domain)}><Pencil />{t('Replace domain', 'Domain ersetzen')}</DropdownMenuItem>}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onSelect={() => onRemove(domain)}><Trash2 />{t('Remove domain', 'Domain entfernen')}</DropdownMenuItem>
                </DropdownMenuGroup></DropdownMenuContent></DropdownMenu>
              </div>
              <AccordionContent className="h-auto"><div className="flex flex-col gap-5 border-t py-5">
                {domain.external ? <ExternalDomainDetail projectId={projectId} domain={domain} disabled={disabled} /> : domain.error ? <Failure error={new Error(domain.error)} /> : <p className="text-sm text-muted-foreground">{t('Shelter manages this domain’s DNS record in the connected Cloudflare account.', 'Shelter verwaltet den DNS-Eintrag dieser Domain im verbundenen Cloudflare-Konto.')}</p>}
                {domain.status === 'active' && <details className="rounded-lg border p-3"><summary className="cursor-pointer text-sm font-medium">{t('Access and search visibility', 'Zugriff und Suchmaschinen')}</summary><div className="mt-4"><DomainAccessSettings compact projectId={projectId} domains={[domain]} /></div></details>}
              </div></AccordionContent>
            </AccordionItem>)}
          </Accordion>
        </CardContent>
      </Card>}
    <p className="text-xs leading-relaxed text-muted-foreground">{t('Use several customer domains with one shared app, or attach each domain to a dedicated customer project. The app remains responsible for customer data and branding.', 'Nutze mehrere Kundendomains mit einer gemeinsamen App oder verbinde jede Domain mit einem eigenen Kundenprojekt. Kundendaten und Branding bleiben Aufgabe der App.')}</p>
    <Dialog open={addOpen} onOpenChange={open => { if (!add.isPending) setAddOpen(open); }}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg">
        <DialogHeader><DialogTitle>{t('Connect a customer domain', 'Kundendomain verbinden')}</DialogTitle><DialogDescription>{t('Connect this domain to “{project}”. The customer receives DNS instructions for their existing provider.', 'Verbinde diese Domain mit „{project}“. Der Kunde erhält DNS-Anweisungen für seinen bestehenden Anbieter.', { project: projectName })}</DialogDescription></DialogHeader>
        {settings.isPending ? <Skeleton className="h-24" /> : settings.isError ? <Failure error={settings.error} retry={() => { void settings.refetch(); }} /> : !settings.data.configured ? <Alert><Info /><AlertTitle>{t('One-time setup required', 'Einmalige Grundeinrichtung erforderlich')}</AlertTitle><AlertDescription>{t('External customer domains need a one-time Cloudflare for SaaS setup. After that, continue here in this project.', 'Für externe Kundendomains muss Cloudflare for SaaS einmalig eingerichtet werden. Danach geht es hier im Projekt weiter.')}</AlertDescription></Alert> :
          <form id="add-external-domain" onSubmit={event => { event.preventDefault(); if (hostnameValid) add.mutate(); }}><FieldGroup><Field data-invalid={hostname.length > 0 && !hostnameValid}>
            <FieldLabel htmlFor="external-hostname">{t('Customer domain', 'Kundendomain')}</FieldLabel><Input id="external-hostname" value={hostname} onChange={event => { setHostname(event.target.value); if (add.isError) add.reset(); }} placeholder="portal.customer.com" required autoFocus autoCapitalize="none" autoCorrect="off" spellCheck={false} disabled={add.isPending} aria-invalid={hostname.length > 0 && !hostnameValid} />
            <FieldDescription>{t('Enter a domain such as customer.com or portal.customer.com. A root domain requires ALIAS, ANAME or CNAME flattening at its DNS provider.', 'Gib eine Domain wie kunde.de oder portal.kunde.de ein. Für die Hauptdomain muss der DNS-Anbieter ALIAS, ANAME oder CNAME-Flattening unterstützen.')}</FieldDescription>
            {hostname.length > 0 && !hostnameValid && <FieldError>{t('Enter a complete domain without https:// or a path.', 'Gib eine vollständige Domain ohne https:// oder Pfad ein.')}</FieldError>}
          </Field><div className="rounded-lg bg-muted/50 px-3 py-2 text-xs leading-relaxed text-muted-foreground">{t('DNS destination', 'DNS-Ziel für den Kunden')}: <code className="break-all text-foreground">{settings.data.cnameTarget}</code></div></FieldGroup></form>}
        {add.isError && <Failure error={add.error} />}
        <DialogFooter><Button variant="ghost" disabled={add.isPending} onClick={() => setAddOpen(false)}>{t('Cancel', 'Abbrechen')}</Button>{settings.isSuccess && !settings.data.configured ? <Button asChild><Link to={`/settings/cloudflare?project=${encodeURIComponent(projectId)}#external-domains`}>{t('Set up Cloudflare for SaaS', 'Cloudflare for SaaS einrichten')}<ArrowRight data-icon="inline-end" /></Link></Button> : <Button type="submit" form="add-external-domain" disabled={add.isPending || !hostnameValid || !settings.data?.configured}>{add.isPending ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : <ArrowRight data-icon="inline-end" />}{add.isPending ? t('Adding domain…', 'Domain wird hinzugefügt …') : t('Continue to DNS setup', 'Weiter zur DNS-Einrichtung')}</Button>}</DialogFooter>
      </DialogContent>
    </Dialog>
  </section>;
}
