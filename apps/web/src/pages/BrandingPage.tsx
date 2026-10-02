import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, RotateCcw, Save, Upload } from 'lucide-react';
import { api, ApiError } from '@/api/client';
import { setBranding, type Branding, type BrandingState } from '@/lib/brand';
import { useI18n } from '@/i18n';
import { SettingsHeader } from '@/components/settings/SettingsHeader';
import { NavigationGuard } from '@/components/NavigationGuard';
import { Button } from '@/components/ui/button';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Spinner } from '@/components/ui/spinner';
import { Skeleton } from '@/components/ui/skeleton';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';

async function readLogo(file: File): Promise<string> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 2 * 1024 * 1024) throw new Error('IMAGE_INVALID');
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('IMAGE_INVALID');
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const result = canvas.toDataURL('image/png');
    if (result.length > 699_050) throw new Error('IMAGE_INVALID');
    return result;
  } finally { bitmap.close(); }
}

export function BrandingPage() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['branding-settings'], queryFn: api.branding });
  const [saved, setSaved] = useState<BrandingState | null>(null);
  const [draft, setDraft] = useState<Branding | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const importInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (query.data && !saved) { setSaved(query.data); setDraft(query.data.profile); setBranding(query.data); }
  }, [query.data, saved]);
  const dirty = Boolean(saved && draft && JSON.stringify(saved.profile) !== JSON.stringify(draft));
  useEffect(() => {
    const prevent = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [dirty]);
  const commit = (state: BrandingState) => {
    queryClient.setQueryData(['branding-settings'], state);
    setSaved(state); setDraft(state.profile); setBranding(state); setError('');
    setNotice(t('Branding is active across the platform.', 'Das Branding ist auf der gesamten Plattform aktiv.'));
  };
  const message = (cause: unknown) => {
    if (cause instanceof ApiError && cause.details && typeof cause.details === 'object' && 'details' in cause.details) {
      const details = cause.details.details;
      if (Array.isArray(details)) return details.map((detail: { path?: string; message?: string }) => `${detail.path ?? ''}: ${detail.message ?? ''}`).join(' · ');
    }
    return cause instanceof Error ? cause.message : t('The operation failed. Please try again.', 'Die Aktion ist fehlgeschlagen. Bitte versuche es erneut.');
  };
  const save = useMutation({ mutationFn: () => api.saveBranding(draft!, saved!.revision), onSuccess: commit, onError: (cause) => setError(message(cause)) });
  const reset = useMutation({ mutationFn: () => api.resetBranding(saved!.revision), onSuccess: (state) => { commit(state); setResetOpen(false); }, onError: (cause) => { setResetOpen(false); setError(message(cause)); } });
  const locked = busy || save.isPending || reset.isPending;
  function update<K extends keyof Branding>(key: K, value: Branding[K]) {
    setDraft((current) => current && ({ ...current, [key]: value })); setError(''); setNotice('');
  }
  async function importProfile(file: File) {
    setBusy(true); setError(''); setNotice('');
    try {
      if (file.size > 2_200_000) throw new Error(t('The branding file must be smaller than 2.2 MB.', 'Die Branding-Datei muss kleiner als 2,2 MB sein.'));
      let parsed: unknown;
      try { parsed = JSON.parse(await file.text()); } catch { throw new Error(t('Select a valid branding JSON export.', 'Wähle einen gültigen Branding-JSON-Export.')); }
      const result = await api.validateBranding(parsed);
      setDraft(result.profile);
      setNotice(t('Import loaded into the preview. Save to apply it.', 'Import in die Vorschau geladen. Zum Übernehmen speichern.'));
    } catch (cause) { setError(message(cause)); } finally { setBusy(false); }
  }
  async function exportProfile() {
    setBusy(true); setError('');
    try {
      const profile = await api.exportBranding();
      const url = URL.createObjectURL(new Blob([JSON.stringify(profile, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = 'branding.json'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) { setError(message(cause)); } finally { setBusy(false); }
  }
  if (query.isError && !saved) return <div className="grid gap-5"><SettingsHeader section="branding" /><Alert variant="destructive"><AlertDescription>{message(query.error)}</AlertDescription></Alert><Button onClick={() => query.refetch()}>{t('Try again', 'Erneut versuchen')}</Button></div>;
  if (!draft || !saved) return <div className="grid gap-5"><SettingsHeader section="branding" /><Skeleton className="h-64 w-full" /></div>;
  const textFields: Array<[keyof Pick<Branding, 'name' | 'claim' | 'description' | 'loginMessage' | 'footer'>, string, number]> = [
    ['name', t('Platform name', 'Plattformname'), 60], ['claim', t('Tagline', 'Slogan'), 120],
    ['description', t('Description for browsers and search', 'Beschreibung für Browser und Suche'), 300],
    ['loginMessage', t('Sign-in message', 'Hinweis auf der Anmeldeseite'), 300], ['footer', t('Footer text', 'Fußzeilentext'), 200],
  ];
  const linkFields: Array<[keyof Pick<Branding, 'supportUrl' | 'documentationUrl' | 'privacyUrl' | 'legalUrl'>, string]> = [
    ['supportUrl', t('Support URL', 'Hilfe-URL')], ['documentationUrl', t('Documentation URL', 'Dokumentations-URL')],
    ['privacyUrl', t('Privacy URL', 'Datenschutz-URL')], ['legalUrl', t('Legal URL', 'Impressum-URL')],
  ];
  return <div className="grid gap-6">
    <SettingsHeader section="branding" />
    <NavigationGuard when={dirty || locked} locked={locked} title={t('Discard branding changes?', 'Branding-Änderungen verwerfen?')} description={t('Your unsaved preview will be lost.', 'Deine ungespeicherte Vorschau geht verloren.')} />
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-muted-foreground">{dirty ? t('Unsaved preview', 'Ungespeicherte Vorschau') : t('Current platform branding', 'Aktuelles Plattform-Branding')}</p>
      <div className="flex flex-wrap gap-2">
        <input ref={importInput} type="file" accept="application/json,.json" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void importProfile(file); }} />
        <Button variant="outline" disabled={locked} onClick={() => importInput.current?.click()}><Upload data-icon="inline-start" />{t('Import', 'Importieren')}</Button>
        <Button variant="outline" disabled={locked} onClick={exportProfile}><Download data-icon="inline-start" />{t('Export saved profile', 'Gespeichertes Profil exportieren')}</Button>
      </div>
    </div>
    {error && <Alert variant="destructive"><AlertDescription>{error}<Button variant="link" disabled={locked} onClick={async () => { const result = await query.refetch(); if (result.data) { setSaved(result.data); setDraft(result.data.profile); setBranding(result.data); setError(''); } }}>{t('Discard draft and reload', 'Entwurf verwerfen und neu laden')}</Button></AlertDescription></Alert>}
    {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
    <section className="grid gap-4 md:grid-cols-2" aria-label={t('Branding preview', 'Branding-Vorschau')}>
      {(['light', 'dark'] as const).map((mode) => {
        const palette = draft[mode];
        const lightLogo = draft.logoLight ?? draft.icon ?? draft.logoDark;
        const logo = mode === 'dark' ? draft.logoDark ?? lightLogo : lightLogo;
        const wordmark = draft.logoLayout === 'wordmark' && Boolean(logo);
        return <div key={mode} className="branding-preview rounded-xl border p-6" style={{ backgroundColor: palette.background, color: palette.foreground } as CSSProperties}>
          <p className="mb-5 text-xs font-medium uppercase tracking-widest">{mode === 'light' ? t('Light appearance', 'Helles Erscheinungsbild') : t('Dark appearance', 'Dunkles Erscheinungsbild')}</p>
          <div className="mb-6 flex items-center gap-3">{logo ? <img src={logo} alt="" className={wordmark ? 'h-10 w-32 object-contain' : 'size-10 object-contain'} /> : <span className="text-3xl font-semibold">{draft.name.slice(0, 1)}</span>}<div>{!wordmark && <strong className="block break-words text-xl">{draft.name}</strong>}<span className="text-xs">{draft.claim}</span></div></div>
          <div className="grid gap-3 rounded-lg p-5" style={{ backgroundColor: palette.surface }}>
            <strong>{t('Welcome back', 'Willkommen zurück')}</strong>
            <p className="break-words text-sm">{draft.loginMessage || t('Sign in to manage your projects.', 'Melde dich an, um deine Projekte zu verwalten.')}</p>
            <span className="rounded-md px-4 py-2 text-center text-sm font-semibold" style={{ backgroundColor: palette.primary, color: readableText(palette.primary) }}>{t('Sign in', 'Anmelden')}</span>
          </div>
          <p className="mt-4 break-words text-xs">{draft.footer}</p>
          <p className="mt-2 text-xs">{linkFields.filter(([key]) => draft[key]).map(([, label]) => label.replace(/ URL|\-URL/g, '')).join(' · ')}</p>
        </div>;
      })}
    </section>
    <form className="grid gap-6" onSubmit={(event) => { event.preventDefault(); setError(''); setNotice(''); save.mutate(); }}>
      <fieldset disabled={locked} className="grid min-w-0 gap-6">
        <Card><CardHeader><CardTitle>{t('Identity', 'Identität')}</CardTitle><CardDescription>{t('Used throughout navigation, page titles, sign-in and public access pages.', 'Gilt für Navigation, Seitentitel, Anmeldung und öffentliche Zugriffsseiten.')}</CardDescription></CardHeader><CardContent><FieldGroup>
          {textFields.map(([key, label, maxLength]) => <Field key={key}><FieldLabel htmlFor={`brand-${key}`}>{label}</FieldLabel><Input id={`brand-${key}`} value={draft[key]} required={key === 'name'} maxLength={maxLength} onChange={(event) => update(key, event.target.value)} /></Field>)}
        </FieldGroup></CardContent></Card>
        <Card><CardHeader><CardTitle>{t('Logos and app icon', 'Logos und App-Symbol')}</CardTitle><CardDescription>{t('PNG, JPEG or WebP, up to 2 MB. Stored as PNG at up to 1024 px and 512 KiB per image. The icon is also used for the favicon and installed app.', 'PNG, JPEG oder WebP, bis 2 MB. Speicherung als PNG mit maximal 1024 px und 512 KiB je Bild. Das Symbol gilt auch für Favicon und installierte App.')}</CardDescription></CardHeader><CardContent><FieldGroup>
          <Field><FieldLabel htmlFor="logo-layout">{t('Logo layout', 'Logo-Darstellung')}</FieldLabel><NativeSelect id="logo-layout" value={draft.logoLayout} onChange={(event) => update('logoLayout', event.target.value as Branding['logoLayout'])}><NativeSelectOption value="symbol">{t('Symbol beside the platform name', 'Symbol neben dem Plattformnamen')}</NativeSelectOption><NativeSelectOption value="wordmark">{t('Wide logo replaces the name', 'Breites Logo ersetzt den Namen')}</NativeSelectOption></NativeSelect></Field>
          {(['logoLight', 'logoDark', 'icon'] as const).map((key) => <Field key={key}><FieldLabel htmlFor={`brand-${key}`}>{key === 'logoLight' ? t('Light logo', 'Logo für Hellmodus') : key === 'logoDark' ? t('Dark logo', 'Logo für Dunkelmodus') : t('App icon / favicon', 'App-Symbol / Favicon')}</FieldLabel><div className="flex flex-wrap items-center gap-3">{draft[key] && <img src={draft[key]} alt="" className="size-12 rounded border object-contain" />}<Input id={`brand-${key}`} type="file" accept="image/png,image/jpeg,image/webp" onChange={async (event) => { const file = event.target.files?.[0]; event.target.value = ''; if (!file) return; setBusy(true); try { update(key, await readLogo(file)); } catch { setError(t('This image could not be used. Choose a smaller PNG, JPEG or WebP image.', 'Dieses Bild konnte nicht verwendet werden. Wähle ein kleineres PNG-, JPEG- oder WebP-Bild.')); } finally { setBusy(false); } }} /><Button type="button" variant="outline" disabled={!draft[key]} onClick={() => update(key, null)}>{t('Remove', 'Entfernen')}</Button></div></Field>)}
        </FieldGroup></CardContent></Card>
        <div className="grid gap-6 lg:grid-cols-2">{(['light', 'dark'] as const).map((mode) => <Card key={mode}><CardHeader><CardTitle>{mode === 'light' ? t('Light colors', 'Helle Farben') : t('Dark colors', 'Dunkle Farben')}</CardTitle></CardHeader><CardContent><FieldGroup>
          {(['primary', 'background', 'foreground', 'surface'] as const).map((key) => <Field key={key} orientation="horizontal"><FieldLabel htmlFor={`brand-${mode}-${key}`}>{({ primary: t('Accent', 'Akzent'), background: t('Background', 'Hintergrund'), foreground: t('Text', 'Text'), surface: t('Cards and navigation', 'Karten und Navigation') })[key]}</FieldLabel><Input className="w-20" id={`brand-${mode}-${key}`} type="color" value={draft[mode][key]} onChange={(event) => update(mode, { ...draft[mode], [key]: event.target.value })} /><span className="font-mono text-xs">{draft[mode][key]}</span></Field>)}
        </FieldGroup></CardContent></Card>)}</div>
        <Card><CardHeader><CardTitle>{t('Support and legal links', 'Hilfe und rechtliche Hinweise')}</CardTitle><CardDescription>{t('Optional HTTPS links shown in the panel, sign-in and public access pages. Leave blank to hide.', 'Optionale HTTPS-Links für Panel, Anmeldung und öffentliche Zugriffsseiten. Leer lassen zum Ausblenden.')}</CardDescription></CardHeader><CardContent><FieldGroup>{linkFields.map(([key, label]) => <Field key={key}><FieldLabel htmlFor={`brand-${key}`}>{label}</FieldLabel><Input id={`brand-${key}`} type="url" value={draft[key]} maxLength={2048} placeholder="https://" onChange={(event) => update(key, event.target.value)} /></Field>)}</FieldGroup></CardContent></Card>
      </fieldset>
      <p className="text-xs text-muted-foreground">{t('Text must remain readable on backgrounds and cards (minimum contrast 4.5:1). Button text adjusts automatically.', 'Text muss auf Hintergründen und Karten lesbar bleiben (Mindestkontrast 4,5:1). Buttontext passt sich automatisch an.')}</p>
      <div className="flex flex-wrap justify-between gap-3">
        <Button type="button" variant="outline" disabled={locked} onClick={() => setResetOpen(true)}><RotateCcw data-icon="inline-start" />{t('Restore defaults', 'Standard wiederherstellen')}</Button>
        <div className="flex gap-2"><Button type="button" variant="outline" disabled={!dirty || locked} onClick={() => { setDraft(saved.profile); setError(''); setNotice(''); }}>{t('Discard', 'Verwerfen')}</Button><Button type="submit" disabled={!dirty || locked}>{save.isPending ? <Spinner /> : <Save data-icon="inline-start" />}{t('Save branding', 'Branding speichern')}</Button></div>
      </div>
    </form>
    <AlertDialog open={resetOpen} onOpenChange={setResetOpen}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{t('Restore the original branding?', 'Ursprüngliches Branding wiederherstellen?')}</AlertDialogTitle><AlertDialogDescription>{t('The platform will use the default name, images and colors. Export your saved profile first if you want to keep it.', 'Die Plattform verwendet wieder Standardnamen, -bilder und -farben. Exportiere zuerst dein gespeichertes Profil, wenn du es behalten möchtest.')}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={locked}>{t('Cancel', 'Abbrechen')}</AlertDialogCancel><AlertDialogAction disabled={locked} onClick={(event) => { event.preventDefault(); reset.mutate(); }}>{t('Restore defaults', 'Standard wiederherstellen')}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </div>;
}
function readableText(hex: string): string {
  const rgb = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255).map((v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return rgb[0]! * .2126 + rgb[1]! * .7152 + rgb[2]! * .0722 > .179 ? '#000000' : '#ffffff';
}
