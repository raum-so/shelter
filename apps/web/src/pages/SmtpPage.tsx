import { smtpError } from "@/lib/smtp-errors";
import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Mail, ShieldCheck } from "lucide-react";
import { api } from "@/api/client";
import type { SmtpInput, SmtpState, SmtpConfiguration } from "@/api/smtp-types";
import { useI18n } from "@/i18n";
import { SettingsHeader } from "@/components/settings/SettingsHeader";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  CardAction,
} from "@/components/ui/card";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";

function SmtpForm({ state }: { state: SmtpState }) {
  const { t } = useI18n();
  const client = useQueryClient();
  const [values, setValues] = useState<SmtpConfiguration>(() => {
    const c = state.configuration;
    return c
      ? {
          enabled: c.enabled,
          provider: c.provider,
          host: c.host,
          port: c.port,
          user: c.user,
          fromEmail: c.fromEmail,
          fromName: c.fromName,
        }
      : {
          enabled: true,
          provider: "custom",
          host: "",
          port: 465,
          user: "",
          fromEmail: "",
          fromName: "Shelter",
        };
  });
  const [password, setPassword] = useState("");
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");
  const session = useQuery({ queryKey: ["session"], queryFn: api.session });
  const save = useMutation({
    gcTime: 0,
    mutationFn: api.saveSmtp,
    onMutate: () => {
      setError(null);
      setNotice("");
    },
    onError: setError,
    onSettled: (): void => {
      save.reset();
    },
    onSuccess: (data) => {
      setPassword("");
      client.setQueryData(["smtp"], data);
    },
  });
  const verify = useMutation({
    mutationFn: () => api.verifySmtp(state.revision!),
    onMutate: () => {
      setError(null);
      setNotice("");
    },
    onError: setError,
    onSuccess: (data) => {
      client.setQueryData(["smtp"], data);
      setNotice(
        t(
          "TLS connection and authentication verified.",
          "TLS-Verbindung und Anmeldung wurden geprüft.",
        ),
      );
    },
  });
  const test = useMutation({
    mutationFn: () => api.sendSmtpTest(state.revision!),
    onMutate: () => {
      setError(null);
      setNotice("");
    },
    onError: setError,
    onSuccess: () =>
      setNotice(
        t(
          "The server accepted the test email. Check your inbox to confirm delivery.",
          "Der Server hat die Testmail angenommen. Prüfe den Posteingang, um die Zustellung zu bestätigen.",
        ),
      ),
  });
  const apply = useMutation({
    mutationFn: () => api.applySmtp(state.revision),
    onMutate: () => {
      setError(null);
      setNotice("");
    },
    onError: setError,
    onSuccess: (data) => {
      setNotice(
        t(
          `Update queued for ${data.queued.length} instance(s).`,
          `Aktualisierung für ${data.queued.length} Instanz(en) vorgemerkt.`,
        ),
      );
      void client.invalidateQueries({ queryKey: ["smtp"] });
      void client.invalidateQueries({ queryKey: ["supabase"] });
    },
  });
  const busy =
    save.isPending || verify.isPending || test.isPending || apply.isPending;
  const affected = state.instances.filter(
    (instance) => instance.source === "global" && instance.outdated,
  );
  function change<K extends keyof SmtpConfiguration>(
    key: K,
    value: SmtpConfiguration[K],
  ) {
    setValues((previous) => ({ ...previous, [key]: value }));
    setDirty(true);
  }
  function provider(value: SmtpConfiguration["provider"]) {
    setValues((previous) => ({
      ...previous,
      provider: value,
      ...(value === "resend"
        ? { host: "smtp.resend.com", user: "resend" }
        : value === "zoho"
          ? { host: "smtp.zeptomail.com", user: "emailapikey" }
          : {}),
    }));
    setPassword("");
    setDirty(true);
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    const input: SmtpInput = { ...values, expectedRevision: state.revision };
    if (password) input.password = password;
    save.mutate(input);
  }
  return (
    <div className="grid min-w-0 items-start gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(18rem,1fr)]">
      {error !== null && (
        <Alert variant="destructive" className="xl:col-span-2">
          <AlertTitle>
            {t("Request failed", "Anfrage fehlgeschlagen")}
          </AlertTitle>
          <AlertDescription>{smtpError(error, t)}</AlertDescription>
        </Alert>
      )}
      {notice && (
        <Alert className="xl:col-span-2">
          <AlertDescription role="status">{notice}</AlertDescription>
        </Alert>
      )}
      <Card>
        <CardHeader>
          <CardTitle>
              {t("Global mail server", "Globaler Mailserver")}
          </CardTitle>
          <CardAction>
            <Badge variant="secondary">
              {!state.configured
                ? t("Not configured", "Nicht konfiguriert")
                : !state.configuration?.enabled
                  ? t("Disabled", "Deaktiviert")
                  : state.verified
                    ? t("Connection verified", "Verbindung geprüft")
                    : t("Not verified", "Nicht geprüft")}
            </Badge>
          </CardAction>
          <CardDescription>
            {t(
              "Supabase uses this server for confirmations, invitations and password resets.",
              "Supabase nutzt diesen Server für Bestätigungen, Einladungen und Passwort-Resets.",
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form id="smtp-settings" onSubmit={submit}>
            <FieldGroup className="grid sm:grid-cols-2">
              <Field orientation="horizontal" className="rounded-lg border bg-muted/20 p-4 sm:col-span-2">
                <Switch
                  id="smtp-enabled"
                  checked={values.enabled}
                  onCheckedChange={(value) => change("enabled", value)}
                />
                <FieldLabel htmlFor="smtp-enabled">
                  {t("Enable outgoing email", "E-Mail-Versand aktivieren")}
                </FieldLabel>
              </Field>
              <Field className="sm:col-span-2">
                <FieldLabel htmlFor="smtp-provider">
                  {t("Provider", "Anbieter")}
                </FieldLabel>
                <NativeSelect
                  id="smtp-provider"
                  value={values.provider}
                  onChange={(event) =>
                    provider(
                      event.target.value as SmtpConfiguration["provider"],
                    )
                  }
                >
                  <NativeSelectOption value="custom">
                    {t("Custom SMTP", "Eigener SMTP-Server")}
                  </NativeSelectOption>
                  <NativeSelectOption value="resend">Resend</NativeSelectOption>
                  <NativeSelectOption value="zoho">
                    Zoho CPaaS / ZeptoMail
                  </NativeSelectOption>
                </NativeSelect>
                <FieldDescription>
                  {t(
                    "Provider presets only fill connection fields. Use the regional server shown in your provider account.",
                    "Anbietervorlagen füllen nur die Verbindungsfelder aus. Nutze den regionalen Server aus deinem Anbieterkonto.",
                  )}
                </FieldDescription>
              </Field>
              {(
                [
                  ["host", t("SMTP hostname", "SMTP-Hostname"), "text"],
                  ["user", t("SMTP username", "SMTP-Benutzername"), "text"],
                  ["fromEmail", t("Sender email", "Absender-E-Mail"), "email"],
                  ["fromName", t("Sender name", "Absendername"), "text"],
                ] as const
              ).map(([key, label, type]) => (
                <Field key={key}>
                  <FieldLabel htmlFor={`smtp-${key}`}>{label}</FieldLabel>
                  <Input
                    id={`smtp-${key}`}
                    type={type}
                    value={values[key]}
                    onChange={(event) => change(key, event.target.value)}
                    required
                    maxLength={
                      key === "fromName" ? 160 : key === "host" ? 253 : 4096
                    }
                  />
                </Field>
              ))}
              <Field className="sm:col-span-2">
                <FieldLabel htmlFor="smtp-password">
                  {t("Password / API key", "Passwort / API-Schlüssel")}
                </FieldLabel>
                <Input
                  id="smtp-password"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  required={!state.configured}
                  onChange={(event) => {
                    setPassword(event.target.value);
                    setDirty(true);
                  }}
                  maxLength={4096}
                />
                <FieldDescription>
                  {t(
                    "Stored encrypted and never returned. Leave blank to keep the current credential for the same server and username.",
                    "Wird verschlüsselt gespeichert und nie zurückgegeben. Leer lassen, um die aktuellen Zugangsdaten für denselben Server und Benutzernamen zu behalten.",
                  )}
                </FieldDescription>
              </Field>
              <Alert className="sm:col-span-2">
                <ShieldCheck />
                <AlertTitle>{t("Encrypted email delivery", "Verschlüsselter E-Mail-Versand")}</AlertTitle>
                <AlertDescription>
                  {t(
                    "Connect securely on port 465. Verify your sender domain with your provider to help emails reach the inbox.",
                    "Sichere Verbindung über Port 465. Verifiziere deine Absenderdomain beim Anbieter, damit E-Mails im Posteingang ankommen.",
                  )}
                </AlertDescription>
              </Alert>
            </FieldGroup>
          </form>
        </CardContent>
        <CardFooter>
          <Button
            form="smtp-settings"
            disabled={busy || (!dirty && state.configured)}
          >
            {save.isPending && <Spinner />}
            {t("Save SMTP settings", "SMTP-Einstellungen speichern")}
          </Button>
        </CardFooter>
      </Card>
      <div className="flex min-w-0 flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{t("Verify and test", "Prüfen und testen")}</CardTitle>
          <CardDescription>
            {t(
              "Connection verification sends no email. The optional test email goes only to your administrator address.",
              "Die Verbindungsprüfung versendet keine E-Mail. Die optionale Testmail geht nur an deine Administratoradresse.",
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col items-start gap-3">
          <Button
            variant="outline"
            disabled={busy || dirty || !state.configured || !values.enabled}
            onClick={() => verify.mutate()}
          >
            {verify.isPending && <Spinner />}
            {t("Verify saved connection", "Gespeicherte Verbindung prüfen")}
          </Button>
          <Button
            variant="outline"
            disabled={busy || dirty || !state.verified || !values.enabled}
            onClick={() => test.mutate()}
          >
            <Mail data-icon="inline-start" />
            {t("Send test email", "Testmail senden")}

          </Button>
          {session.data?.user?.email && <p className="break-all text-xs text-muted-foreground">{t("Recipient:", "Empfänger:")} {session.data.user.email}</p>}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>
            {t("Apply to Supabase", "Für Supabase übernehmen")}
          </CardTitle>
          <CardDescription>
            {t(
              "New instances inherit the global settings. Existing instances with their own SMTP configuration remain unchanged. Applying briefly restarts authentication for affected instances.",
              "Neue Instanzen übernehmen die globalen Einstellungen. Bestehende Instanzen mit eigener SMTP-Konfiguration bleiben unverändert. Beim Übernehmen wird die Authentifizierung betroffener Instanzen kurz neu gestartet.",
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {affected.length ? (
            affected.map((instance) => (
              <p key={instance.id} className="text-sm">
                {instance.name}
                {instance.busy
                  ? ` · ${t("Operation running", "Vorgang läuft")}`
                  : ""}
              </p>
            ))
          ) : (
            <p className="text-sm text-muted-foreground">
              {state.instances.some(instance => instance.source === "global")
                ? t("All connected instances use the current configuration.", "Alle verbundenen Instanzen verwenden die aktuelle Konfiguration.")
                : t("No instance uses this mail server yet. Choose it when setting up Supabase.", "Noch keine Instanz nutzt diesen Mailserver. Wähle ihn beim Einrichten von Supabase aus.")}
            </p>
          )}
        </CardContent>
        <CardFooter>
          <Button
            disabled={
              busy ||
              dirty ||
              !affected.length ||
              affected.some((instance) => instance.busy) ||
              (values.enabled && !state.verified)
            }
            onClick={() => apply.mutate()}
          >
            {t(
              "Apply to connected instances",
              "Für verbundene Instanzen übernehmen",
            )}
          </Button>
        </CardFooter>
      </Card>
      </div>
    </div>
  );
}
export function SmtpPage() {
  const { t } = useI18n();
  const query = useQuery({
    queryKey: ["smtp"],
    queryFn: api.smtp,
    refetchInterval: 5000,
  });
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <SettingsHeader section="smtp" />
      {query.isLoading ? (
        <Skeleton className="h-64" />
      ) : query.isError ? (
        <Alert variant="destructive">
          <AlertTitle>
            {t(
              "SMTP settings could not be loaded",
              "SMTP-Einstellungen konnten nicht geladen werden",
            )}
          </AlertTitle>
          <AlertDescription>
            <Button variant="outline" onClick={() => query.refetch()}>
              {t("Try again", "Erneut versuchen")}
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
        query.data && (
          <div className="max-w-6xl"><SmtpForm key={query.data.revision ?? "empty"} state={query.data} /></div>
        )
      )}
    </div>
  );
}
