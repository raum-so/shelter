import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, KeyRound, ShieldCheck } from "lucide-react";
import { api } from "@/api/client";
import { useI18n } from "@/i18n";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardAction,
} from "@/components/ui/card";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";

export function MfaSettings() {
  const { t } = useI18n(),
    client = useQueryClient();
  const status = useQuery({ queryKey: ["mfa"], queryFn: api.mfaStatus });
  const [password, setPassword] = useState(""),
    [code, setCode] = useState("");
  const [enrollment, setEnrollment] = useState<{
    secret: string;
    qrCode: string;
  } | null>(null);
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [disable, setDisable] = useState(false),
    [error, setError] = useState(false);
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["mfa"] });
    void client.invalidateQueries({ queryKey: ["security-events"] });
  };
  const setup = useMutation({
    mutationFn: () => api.setupMfa(password),
    gcTime: 0,
    onSuccess: (result) => {
      setEnrollment({ secret: result.secret, qrCode: result.qrCode });
      setPassword("");
      setup.reset();
    },
    onError: () => setError(true),
  });
  const enable = useMutation({
    mutationFn: () => api.enableMfa(code),
    gcTime: 0,
    onSuccess: (result) => {
      setRecovery(result.recoveryCodes);
      setEnrollment(null);
      setCode("");
      enable.reset();
      refresh();
    },
    onError: () => setError(true),
  });
  const remove = useMutation({
    mutationFn: () => api.disableMfa(password, code.trim().toLowerCase()),
    gcTime: 0,
    onSuccess: () => {
      setDisable(false);
      setPassword("");
      setCode("");
      refresh();
    },
    onError: () => setError(true),
  });
  const busy = setup.isPending || enable.isPending || remove.isPending;
  function submit(event: FormEvent) {
    event.preventDefault();
    setError(false);
    if (disable) remove.mutate();
    else if (enrollment) enable.mutate();
    else setup.mutate();
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>
            {t("Two-factor authentication", "Zwei-Faktor-Anmeldung")}
        </CardTitle>
        <CardAction>
          {status.data?.enabled && (
            <Badge variant="secondary">
              <ShieldCheck data-icon="inline-start" />
              {t("Enabled", "Aktiviert")}
            </Badge>
          )}
        </CardAction>
        <CardDescription>
          {t(
            "Protect your administrator account with a code from an authenticator app.",
            "Schütze dein Admin-Konto mit einem zusätzlichen Code aus einer Authenticator-App.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {status.isPending ? (
          <Skeleton className="h-20" />
        ) : status.isError ? (
          <Alert variant="destructive">
            <AlertDescription>
              {t(
                "Security settings could not be loaded.",
                "Sicherheitseinstellungen konnten nicht geladen werden.",
              )}{" "}
              <Button variant="link" onClick={() => status.refetch()}>
                {t("Retry", "Erneut versuchen")}
              </Button>
            </AlertDescription>
          </Alert>
        ) : recovery ? (
          <>
            <Alert>
              <KeyRound />
              <AlertTitle>
                {t(
                  "Save your recovery codes",
                  "Wiederherstellungscodes sichern",
                )}
              </AlertTitle>
              <AlertDescription>
                {t(
                  "Each code works once if you lose your authenticator. Store them in your password manager. They will not be shown again.",
                  "Jeder Code funktioniert einmal, falls du deine Authenticator-App verlierst. Speichere sie im Passwortmanager. Sie werden nicht erneut angezeigt.",
                )}
              </AlertDescription>
            </Alert>
            <div className="grid gap-2 rounded-lg border p-4 font-mono text-sm sm:grid-cols-2">
              {recovery.map((value) => (
                <code key={value}>{value}</code>
              ))}
            </div>
            <Button className="self-start" onClick={() => setRecovery(null)}>
              <CheckCircle2 data-icon="inline-start" />
              {t("I saved these codes", "Codes sind gesichert")}
            </Button>
          </>
        ) : status.data?.enabled && !disable ? (
          <>
            <p className="text-sm text-muted-foreground">
              {t(
                "A second factor is required at sign-in. {count} recovery codes remain.",
                "Bei der Anmeldung wird ein zweiter Faktor benötigt. {count} Wiederherstellungscodes sind übrig.",
                { count: status.data.recoveryCodesRemaining },
              )}
            </p>
            <div>
              <Button
                variant="outline"
                onClick={() => {
                  setDisable(true);
                  setError(false);
                }}
              >
                {t(
                  "Disable two-factor authentication",
                  "Zwei-Faktor-Anmeldung deaktivieren",
                )}
              </Button>
            </div>
          </>
        ) : (
          <form onSubmit={submit} className="max-w-xl">
            <FieldGroup>
              {enrollment ? (
                <>
                  <p className="text-sm">
                    {t(
                      "Scan this code with your authenticator app, then enter the six-digit code.",
                      "Scanne diesen Code mit deiner Authenticator-App und gib anschließend den sechsstelligen Code ein.",
                    )}
                  </p>
                  <img
                    src={enrollment.qrCode}
                    width={224}
                    height={224}
                    className="self-start rounded-lg"
                    alt={t(
                      "Authenticator setup QR code",
                      "QR-Code zur Authenticator-Einrichtung",
                    )}
                  />
                  <Collapsible>
                    <CollapsibleTrigger asChild>
                      <Button type="button" variant="link">
                        {t(
                          "Enter setup key manually",
                          "Einrichtungsschlüssel manuell eingeben",
                        )}
                      </Button>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <code className="block break-all rounded-lg border p-3 text-sm">
                        {enrollment.secret}
                      </code>
                    </CollapsibleContent>
                  </Collapsible>
                </>
              ) : (
                <Field>
                  <FieldLabel htmlFor="mfa-password">
                    {t("Current password", "Aktuelles Passwort")}
                  </FieldLabel>
                  <Input
                    id="mfa-password"
                    type="password"
                    autoComplete="current-password"
                    required
                    maxLength={1024}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    disabled={busy}
                  />
                </Field>
              )}
              {(enrollment || disable) && (
                <Field>
                  <FieldLabel htmlFor="mfa-code">
                    {t("Verification code", "Bestätigungscode")}
                  </FieldLabel>
                  <Input
                    id="mfa-code"
                    autoComplete="one-time-code"
                    required
                    maxLength={disable ? 20 : 6}
                    pattern={disable ? undefined : "[0-9]{6}"}
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                    disabled={busy}
                  />
                  <FieldDescription>
                    {disable
                      ? t(
                          "Use an authenticator code or a recovery code.",
                          "Verwende einen Authenticator-Code oder Wiederherstellungscode.",
                        )
                      : t(
                          "Use the current six-digit code from the app.",
                          "Verwende den aktuellen sechsstelligen Code aus der App.",
                        )}
                  </FieldDescription>
                </Field>
              )}
              <p className="text-sm text-muted-foreground">
                {t(
                  "Changing this protection signs out other sessions and revokes existing personal API tokens.",
                  "Eine Änderung dieses Schutzes meldet andere Sitzungen ab und widerruft bestehende persönliche API-Token.",
                )}
              </p>
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>
                    {t(
                      "Could not verify. Check your password or code and try again. If setup expired, start again.",
                      "Bestätigung fehlgeschlagen. Prüfe Passwort oder Code und versuche es erneut. Starte eine abgelaufene Einrichtung neu.",
                    )}
                  </AlertDescription>
                </Alert>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  type="submit"
                  variant={disable ? "destructive" : "default"}
                  disabled={busy}
                >
                  {busy && <Spinner />}
                  {disable
                    ? t("Disable protection", "Schutz deaktivieren")
                    : enrollment
                      ? t("Enable protection", "Schutz aktivieren")
                      : t("Set up authenticator", "Authenticator einrichten")}
                </Button>
                {(disable || enrollment) && (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      setDisable(false);
                      setEnrollment(null);
                      setPassword("");
                      setCode("");
                      setError(false);
                    }}
                  >
                    {t("Cancel", "Abbrechen")}
                  </Button>
                )}
              </div>
            </FieldGroup>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
