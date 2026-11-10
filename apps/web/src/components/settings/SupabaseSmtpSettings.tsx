import { useId, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "@/api/client";
import type { SupabaseInstance } from "@/api/supabase-types";
import type { SupabaseSmtpInput } from "@/api/smtp-types";
import { useI18n } from "@/i18n";
import { smtpError } from "@/lib/smtp-errors";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
} from "@/components/ui/field";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";

export function SupabaseSmtpSettings({
  instance,
  busy,
}: {
  instance: SupabaseInstance;
  busy: boolean;
}) {
  const { t } = useI18n();
  const client = useQueryClient();
  const id = useId();
  const current =
    instance.settings.smtpSource ??
    (instance.settings.smtp ? "custom" : "disabled");
  const [source, setSource] = useState(current);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");
  const [password, setPassword] = useState("");
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const input: SupabaseSmtpInput =
      source === "custom"
        ? {
            source,
            smtp: {
              host: String(data.get("host")),
              port: 465,
              user: String(data.get("user")),
              fromEmail: String(data.get("fromEmail")),
              fromName: String(data.get("fromName")),
              ...(password ? { password } : {}),
            },
          }
        : { source };
    setSaving(true);
    setError(null);
    setNotice("");
    try {
      await api.selectSupabaseSmtp(instance.id, input);
      setEditing(false);
      setNotice(t("SMTP update queued.", "SMTP-Aktualisierung eingereiht."));
      await Promise.all([
        client.invalidateQueries({ queryKey: ["supabase"] }),
        client.invalidateQueries({ queryKey: ["smtp"] }),
      ]);
    } catch (failure) {
      setError(failure);
    } finally {
      setPassword("");
      setSaving(false);
    }
  }
  const smtp = current === "custom" ? instance.settings.smtp : undefined;
  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm font-medium">
        {t("Mail server", "Mailserver")}:{" "}
        {current === "global"
          ? t("Global SMTP", "Globales SMTP")
          : current === "custom"
            ? t("Own SMTP settings", "Eigene SMTP-Einstellungen")
            : t("Disabled", "Deaktiviert")}
        {instance.settings.smtpPending
          ? ` · ${t("Update pending", "Aktualisierung ausstehend")}`
          : ""}
      </p>
      {instance.status !== "archived" && !editing && (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              setSource(current);
              setEditing(true);
              setError(null);
              setNotice("");
            }}
          >
            {t("Edit email settings", "E-Mail-Einstellungen bearbeiten")}
          </Button>
          <Button asChild variant="ghost">
            <Link to="/settings/smtp">
              {t("Global SMTP settings", "Globale SMTP-Einstellungen")}
            </Link>
          </Button>
        </div>
      )}
      {editing && (
        <form onSubmit={save} className="flex max-w-2xl flex-col gap-5">
          <fieldset disabled={busy || saving} className="flex flex-col gap-4">
            <FieldGroup className="grid sm:grid-cols-2">
              <Field className="sm:col-span-2">
                <FieldLabel htmlFor={`${id}-source`}>
                  {t("Mail server", "Mailserver")}
                </FieldLabel>
                <NativeSelect
                  id={`${id}-source`}
                  value={source}
                  onChange={(event) => {
                    setSource(event.target.value as typeof source);
                    setPassword("");
                  }}
                >
                  <NativeSelectOption value="global">
                    {t("Use global SMTP", "Globales SMTP verwenden")}
                  </NativeSelectOption>
                  <NativeSelectOption value="custom">
                    {t("Own SMTP settings", "Eigene SMTP-Einstellungen")}
                  </NativeSelectOption>
                  <NativeSelectOption value="disabled">
                    {t("Disable email", "E-Mail deaktivieren")}
                  </NativeSelectOption>
                </NativeSelect>
                <FieldDescription>
                  {t(
                    "Own settings apply only to this instance. Saving verifies the connection and briefly restarts its Auth service. Stopped instances stay stopped.",
                    "Eigene Einstellungen gelten nur für diese Instanz. Beim Speichern wird die Verbindung geprüft und ihr Auth-Dienst kurz neu gestartet. Gestoppte Instanzen bleiben gestoppt.",
                  )}
                </FieldDescription>
              </Field>
              {source === "custom" && (
                <>
                  {(
                    [
                      ["host", t("SMTP host", "SMTP-Host"), "text", smtp?.host],
                      [
                        "user",
                        t("SMTP username", "SMTP-Benutzername"),
                        "text",
                        smtp?.user,
                      ],
                      [
                        "fromEmail",
                        t("Sender email", "Absender-E-Mail"),
                        "email",
                        smtp?.adminEmail,
                      ],
                      [
                        "fromName",
                        t("Sender name", "Absendername"),
                        "text",
                        smtp?.sender,
                      ],
                    ] as const
                  ).map(([name, label, type, value]) => (
                    <Field key={name}>
                      <FieldLabel htmlFor={`${id}-${name}`}>{label}</FieldLabel>
                      <Input
                        id={`${id}-${name}`}
                        name={name}
                        type={type}
                        defaultValue={value ?? ""}
                        required
                        maxLength={
                          name === "host"
                            ? 253
                            : name === "fromEmail"
                              ? 320
                              : name === "fromName"
                                ? 160
                                : 4096
                        }
                      />
                    </Field>
                  ))}
                  <Field className="sm:col-span-2">
                    <FieldLabel htmlFor={`${id}-password`}>
                      {t(
                        "SMTP password / API key",
                        "SMTP-Passwort / API-Schlüssel",
                      )}
                    </FieldLabel>
                    <Input
                      id={`${id}-password`}
                      type="password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      autoComplete="new-password"
                      maxLength={4096}
                      required={!smtp}
                    />
                    <FieldDescription>
                      {t(
                        "Leave empty to keep the password for the same server and username. TLS on port 465 is required.",
                        "Leer lassen, um das Passwort für denselben Server und Benutzer zu behalten. TLS auf Port 465 ist erforderlich.",
                      )}
                    </FieldDescription>
                  </Field>
                </>
              )}
            </FieldGroup>
            <div className="flex flex-wrap gap-2">
              <Button type="submit">
                {saving && <Spinner />}
                {t("Save email settings", "E-Mail-Einstellungen speichern")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setEditing(false);
                  setPassword("");
                  setError(null);
                }}
              >
                {t("Cancel", "Abbrechen")}
              </Button>
            </div>
          </fieldset>
        </form>
      )}
      {error != null && (
        <Alert variant="destructive">
          <AlertDescription>{smtpError(error, t)}</AlertDescription>
        </Alert>
      )}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
    </div>
  );
}
