import { ClipboardPaste, FileKey2, ShieldCheck, TriangleAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useI18n } from '../i18n';
import {
  environmentImportCounts,
  MAX_ENVIRONMENT_IMPORT_VARIABLES,
  parseEnvironmentText,
  type EnvironmentImportError,
  type ImportedEnvironmentVariable,
} from '../utils/environment-import';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from './ui/dialog';
import { Label } from './ui/label';
import { Textarea } from './ui/textarea';

interface EnvironmentImportDialogProps {
  existingKeys: ReadonlyArray<string>;
  disabled?: boolean;
  allowEmptyValues?: boolean;
  onImport: (variables: ImportedEnvironmentVariable[]) => void;
}

function localizedError(
  error: EnvironmentImportError,
  t: (english: string, german: string, values?: Record<string, string | number>) => string,
): string {
  const prefix = t('Line {line}:', 'Zeile {line}:', { line: error.line });
  if (error.code === 'invalid_assignment') return `${prefix} ${t('Expected KEY=value.', 'KEY=Wert erwartet.')}`;
  if (error.code === 'unterminated_quote') return `${prefix} ${t('The quoted value is not closed.', 'Der Wert in Anführungszeichen ist nicht geschlossen.')}`;
  if (error.code === 'unexpected_characters') return `${prefix} ${t('Only a comment may follow a quoted value.', 'Nach einem Wert in Anführungszeichen darf nur ein Kommentar folgen.')}`;
  if (error.code === 'duplicate_key') return `${prefix} ${t('{key} occurs more than once.', '{key} kommt mehrfach vor.', { key: error.key ?? '' })}`;
  if (error.code === 'managed_key') return `${prefix} ${t('{key} is managed by Shelter.', '{key} wird von Shelter verwaltet.', { key: error.key ?? '' })}`;
  if (error.code === 'empty_value') return `${prefix} ${t('Enter a value for {key}; a blank value cannot update a stored secret.', 'Gib für {key} einen Wert ein; ein leerer Wert kann ein gespeichertes Secret nicht aktualisieren.', { key: error.key ?? '' })}`;
  if (error.code === 'value_too_long') return `${prefix} ${t('The value for {key} is too long.', 'Der Wert für {key} ist zu lang.', { key: error.key ?? '' })}`;
  if (error.code === 'too_many_variables') return t('A maximum of 200 variables can be imported at once.', 'Es können höchstens 200 Variablen auf einmal importiert werden.');
  return t('The pasted environment is larger than 256 KiB.', 'Die eingefügte Umgebung ist größer als 256 KiB.');
}

export function EnvironmentImportDialog({
  existingKeys,
  disabled = false,
  allowEmptyValues = true,
  onImport,
}: EnvironmentImportDialogProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState('');
  const parsed = useMemo(() => parseEnvironmentText(source, { allowEmptyValues }), [allowEmptyValues, source]);
  const counts = useMemo(() => environmentImportCounts(existingKeys, parsed.variables), [existingKeys, parsed.variables]);
  const exceedsTotalLimit = counts.total > MAX_ENVIRONMENT_IMPORT_VARIABLES;
  const hasSource = Boolean(source.trim());
  const canImport = hasSource && parsed.variables.length > 0 && parsed.errors.length === 0 && !exceedsTotalLimit;

  function setDialogOpen(next: boolean) {
    setOpen(next);
    if (!next) setSource('');
  }

  function importVariables() {
    if (!canImport) return;
    onImport(parsed.variables);
    setDialogOpen(false);
    toast.success(t(
      '{count} environment variables imported',
      '{count} Umgebungsvariablen importiert',
      { count: parsed.variables.length },
    ), {
      description: t('Review the values, then save your changes.', 'Prüfe die Werte und speichere anschließend deine Änderungen.'),
    });
  }

  return (
    <Dialog open={open} onOpenChange={setDialogOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm" disabled={disabled}>
          <ClipboardPaste aria-hidden="true" /> {t('Paste .env', '.env einfügen')}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[min(46rem,calc(100vh-2rem))] overflow-y-auto sm:max-w-2xl">
        <DialogHeader className="pr-8">
          <div className="mb-1 grid size-10 place-items-center rounded-lg border bg-muted/40 text-foreground">
            <FileKey2 className="size-4" aria-hidden="true" />
          </div>
          <DialogTitle>{t('Import environment variables', 'Umgebungsvariablen importieren')}</DialogTitle>
          <DialogDescription className="leading-relaxed">
            {t(
              'Paste the contents of a .env file. Shelter parses it only in this browser and does not save anything until you explicitly save the changes.',
              'Füge den Inhalt einer .env-Datei ein. Shelter verarbeitet ihn nur in diesem Browser und speichert nichts, bevor du die Änderungen ausdrücklich speicherst.',
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-2">
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="environment-import-source">.env</Label>
            <span className="text-xs text-muted-foreground">{t('Values stay visible only here', 'Werte sind nur hier sichtbar')}</span>
          </div>
          <Textarea
            id="environment-import-source"
            value={source}
            onChange={(event) => setSource(event.target.value)}
            placeholder={'DATABASE_URL="postgres://…"\nAPI_TOKEN=…\nNEXT_PUBLIC_APP_URL=https://example.com'}
            className="min-h-44 resize-y font-mono text-xs leading-relaxed"
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            aria-invalid={parsed.errors.length > 0 || exceedsTotalLimit || undefined}
            data-1p-ignore
            data-lpignore="true"
          />
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t('Comments, export KEY=value, quoted values, and multiline quoted values are supported. Values are not expanded or executed.', 'Kommentare, export KEY=Wert, Anführungszeichen und mehrzeilige Werte werden unterstützt. Werte werden weder aufgelöst noch ausgeführt.')}
          </p>
        </div>

        {hasSource && parsed.errors.length === 0 && parsed.variables.length > 0 && !exceedsTotalLimit && (
          <div className="rounded-xl border bg-muted/20 p-4" role="status" aria-live="polite">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">{t('Ready to import', 'Bereit zum Import')}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t('{added} new · {replaced} replaced', '{added} neu · {replaced} ersetzt', counts)}
                </p>
              </div>
              <Badge variant="secondary">{t('{count} variables', '{count} Variablen', { count: parsed.variables.length })}</Badge>
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5" aria-label={t('Detected keys', 'Erkannte Keys')}>
              {parsed.variables.slice(0, 8).map((variable) => <Badge key={variable.key} variant="outline" className="font-mono font-normal">{variable.key}</Badge>)}
              {parsed.variables.length > 8 && <Badge variant="outline">+{parsed.variables.length - 8}</Badge>}
            </div>
          </div>
        )}

        {hasSource && (parsed.errors.length > 0 || parsed.variables.length === 0 || exceedsTotalLimit) && (
          <Alert variant="destructive" role="alert">
            <TriangleAlert aria-hidden="true" />
            <AlertTitle>{t('Check the pasted .env', 'Prüfe die eingefügte .env')}</AlertTitle>
            <AlertDescription>
              {parsed.variables.length === 0 && parsed.errors.length === 0
                ? t('No variables were found.', 'Es wurden keine Variablen gefunden.')
                : exceedsTotalLimit
                  ? t('The import would create {count} variables; Shelter allows at most 200.', 'Der Import würde {count} Variablen ergeben; Shelter erlaubt höchstens 200.', { count: counts.total })
                  : (
                    <ul className="mt-1 list-disc space-y-1 pl-4">
                      {parsed.errors.slice(0, 5).map((error, index) => <li key={`${error.line}-${error.code}-${index}`}>{localizedError(error, t)}</li>)}
                      {parsed.errors.length > 5 && <li>{t('{count} more errors', '{count} weitere Fehler', { count: parsed.errors.length - 5 })}</li>}
                    </ul>
                  )}
            </AlertDescription>
          </Alert>
        )}

        <Alert role="note" className="border-border bg-muted/20">
          <ShieldCheck aria-hidden="true" />
          <AlertTitle>{t('Nothing is saved automatically', 'Nichts wird automatisch gespeichert')}</AlertTitle>
          <AlertDescription>{t('Matching keys are replaced in the form. All other existing variables remain unchanged.', 'Passende Keys werden im Formular ersetzt. Alle anderen vorhandenen Variablen bleiben unverändert.')}</AlertDescription>
        </Alert>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>{t('Cancel', 'Abbrechen')}</Button>
          <Button type="button" onClick={importVariables} disabled={!canImport}><ClipboardPaste aria-hidden="true" /> {t('Import variables', 'Variablen importieren')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
