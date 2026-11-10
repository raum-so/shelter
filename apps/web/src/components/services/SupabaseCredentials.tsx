import { Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@/api/client";
import type { SupabaseCredentials as Credentials } from "@/api/supabase-types";
import { useI18n } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from "@/components/ui/accordion";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel, FieldDescription } from "@/components/ui/field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import { supabaseErrorMessage } from "@/lib/supabase-errors";
export function SupabaseCredentials({
  id,
  busy,
}: {
  id: string;
  busy: boolean;
}) {
  const { t } = useI18n();
  const [password, setPassword] = useState("");
  const [credentials, setCredentials] = useState<Credentials | null>(null);
  const [pending, setPending] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (busy) setCredentials(null);
  }, [busy]);
  useEffect(() => {
    if (!credentials) return;
    const timer = setTimeout(() => setCredentials(null), 60000);
    return () => clearTimeout(timer);
  }, [credentials]);
  return (
    <Accordion type="single" collapsible onValueChange={value => { if (!value) { setCredentials(null); setPassword(""); setCopied(null); } }}><AccordionItem value="credentials" className="border-0">
      <AccordionTrigger className="py-0">
        {t("Connection credentials", "Zugangsdaten")}
      </AccordionTrigger>
      <AccordionContent className="pt-5 pb-0"><div className="flex flex-col gap-5">
        <form
          className="flex max-w-xl flex-col items-start gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            setPending(true);
            setError(null);
            void api
              .supabaseCredentials(id, password)
              .then(setCredentials)
              .catch(setError)
              .finally(() => {
                setPending(false);
                setPassword("");
              });
          }}
        >
          <Field>
            <FieldLabel htmlFor="supabase-password">
              {t("Current Shelter password", "Aktuelles Shelter-Passwort")}
            </FieldLabel>
            <Input
              id="supabase-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              required
            />
            <FieldDescription>
              {t(
                "Visible for one minute. Keep administrative keys out of browser code.",
                "Eine Minute sichtbar. Administrationsschlüssel gehören nicht in Browser-Code.",
              )}
            </FieldDescription>
          </Field>
          <Button
            type="submit"
            variant="outline"
            disabled={busy || pending || !password}
          >
            {pending && <Spinner />}
            {t("Reveal credentials", "Zugangsdaten anzeigen")}
          </Button>
        </form>
        {Boolean(error) && (
          <Alert variant="destructive">
            <AlertDescription>
              {supabaseErrorMessage(error, t)}
            </AlertDescription>
          </Alert>
        )}
        {credentials && (
          <>
            <div className="grid gap-5 sm:grid-cols-2">
              {([
                ["apiUrl", t("App address", "App-Adresse"), false],
                ["anonKey", t("Public app key", "Öffentlicher App-Schlüssel"), true],
                ["serviceRoleKey", t("Administrator key · server only", "Administratorschlüssel · nur für Server"), true],
                ["studioUsername", t("Studio username", "Studio-Benutzername"), false],
                ["studioPassword", t("Studio password", "Studio-Passwort"), true],
                ["databaseUser", t("Database user", "Datenbank-Benutzer"), false],
                ["databaseName", t("Database name", "Datenbank-Name"), false],
                ["databasePassword", t("Database password", "Datenbank-Passwort"), true],
                ["databasePort", t("Database port · SSH tunnel", "Datenbank-Port · SSH-Tunnel"), false],
              ] as const).map(([key, label, secret]) => <Field key={key}>
                <FieldLabel htmlFor={`credential-${key}`}>{label}</FieldLabel>
                <div className="flex min-w-0 items-center gap-2"><Input id={`credential-${key}`} value={String(credentials[key] ?? "—")} type={secret ? "password" : "text"} readOnly autoComplete="off" data-1p-ignore className="min-w-0" /><Button type="button" variant="outline" size="icon" aria-label={t("Copy {label}", "{label} kopieren", { label })} onClick={() => { void navigator.clipboard.writeText(String(credentials[key] ?? "")).then(() => setCopied(label)).catch(() => setError(new Error("Copy failed"))); }}><Copy /></Button></div>
              </Field>)}
              {copied && <p role="status" className="text-sm text-muted-foreground">{t("{label} copied", "{label} kopiert", { label: copied })}</p>}
            </div>
            <Button variant="outline" onClick={() => setCredentials(null)}>
              {t("Hide credentials", "Zugangsdaten ausblenden")}
            </Button>
          </>
        )}
      </div></AccordionContent>
    </AccordionItem></Accordion>
  );
}
