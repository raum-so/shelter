import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ExternalLink,
  Activity,
} from "lucide-react";
import { api } from "@/api/client";
import type { SupabaseInstance } from "@/api/supabase-types";
import { useI18n } from "@/i18n";
import { PageIntro, StatusBadge } from "@/components/ui";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel } from "@/components/ui/field";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { SupabaseOverview } from "@/components/services/SupabaseOverview";
import { SupabaseConnections } from "@/components/services/SupabaseConnections";
import { SupabaseFunctions } from "@/components/services/SupabaseFunctions";
import { SupabaseBackups } from "@/components/services/SupabaseBackups";
import {
  SupabaseActivity,
  operationLabel,
  operationPhase,
} from "@/components/services/SupabaseActivity";
import { SupabaseCredentials } from "@/components/services/SupabaseCredentials";
import { SupabaseSmtpSettings } from "@/components/settings/SupabaseSmtpSettings";
import {
  supabaseErrorMessage,
  supabaseOperationError,
} from "@/lib/supabase-errors";

export function SupabaseStatus({ instance }: { instance: SupabaseInstance }) {
  const { t, locale } = useI18n();
  const labels = {
    queued: t("Waiting", "Wartet"),
    provisioning: t("Working", "Vorgang läuft"),
    running: t("Running", "Läuft"),
    stopped: t("Paused", "Pausiert"),
    error: t("Needs attention", "Prüfung erforderlich"),
    archived: t("Archived", "Archiviert"),
  };
  return (
    <StatusBadge status={instance.status} label={labels[instance.status]} />
  );
}
export function SupabaseInstancePage() {
  const { id } = useParams(),
    { t, locale } = useI18n(),
    client = useQueryClient();
  const [search, setSearch] = useSearchParams();
  const tabs = [
    "overview",
    "apps",
    "functions",
    "backups",
    "settings",
    "activity",
  ];
  const selected = search.get("tab") ?? "overview",
    tab = tabs.includes(selected) ? selected : "overview";
  const query = useQuery({
    queryKey: ["supabase", id],
    queryFn: () => api.supabaseInstance(id!),
    enabled: !!id,
    refetchInterval: 4000,
  });
  const connections = useQuery({
    queryKey: ["supabase-connections"],
    queryFn: api.supabaseConnections,
    refetchInterval: 6000,
  });
  const [confirmation, setConfirmation] = useState(""),
    [pending, setPending] = useState<{
      action: string;
      backupId?: string;
    } | null>(null);

  const action = useMutation({
    mutationFn: (input: {
      action: string;
      backupId?: string;
      confirmation?: string;
    }) => api.supabaseAction(id!, input),
    onSuccess: () => {
      setPending(null);
      setConfirmation("");
      void client.invalidateQueries({ queryKey: ["supabase"] });
    },
  });
  if (query.isPending) return <Skeleton className="h-80" />;
  if (query.isError || !query.data)
    return (
      <Alert variant="destructive">
        <AlertTitle>
          {t(
            "Instance could not be loaded",
            "Instanz konnte nicht geladen werden",
          )}
        </AlertTitle>
        <AlertDescription>
          <Button variant="outline" onClick={() => query.refetch()}>
            {t("Try again", "Erneut versuchen")}
          </Button>
          <Link to="/services">
            {t("Back to services", "Zurück zu den Diensten")}
          </Link>
        </AlertDescription>
      </Alert>
    );
  const instance = query.data.instance,
    busy = instance.jobs.some((job) =>
      ["queued", "running"].includes(job.status),
    ),
    current = instance.jobs.find((job) =>
      ["queued", "running"].includes(job.status),
    );
  const links =
    connections.data?.connections.filter(
      (link) => link.instanceId === instance.id,
    ) ?? [];
  const ask = (action: string, backupId?: string) => {
    setConfirmation("");
    setPending({ action, ...(backupId ? { backupId } : {}) });
  };
  const needsName =
    pending && ["restore", "archive", "rotate-keys"].includes(pending.action);
  const chosenBackup = instance.backups.find(
    (backup) => backup.id === pending?.backupId,
  );
  const dialogTitle =
    pending?.action === "restore"
      ? t("Restore this recovery point?", "Diesen Stand wiederherstellen?")
      : pending?.action === "archive"
        ? t("Archive this instance?", "Diese Instanz archivieren?")
        : pending?.action === "rotate-keys"
          ? t("Renew API keys?", "API-Schlüssel erneuern?")
          : pending?.action === "stop"
            ? t("Pause this instance?", "Diese Instanz pausieren?")
            : pending?.action === "backup"
              ? t(
                  "Create a recovery point?",
                  "Wiederherstellungspunkt erstellen?",
                )
              : t("Renew the Studio password?", "Studio-Passwort erneuern?");
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageIntro
        eyebrow={<Link to="/services" className="inline-flex items-center gap-1.5 hover:text-foreground"><ArrowLeft className="size-3.5" aria-hidden="true" />{t("Services", "Dienste")}</Link>}
        title={instance.name}
        description={new URL(instance.apiUrl).hostname}
        actions={
          <div className="flex items-center gap-3">
            <SupabaseStatus instance={instance} />
            {instance.status === "running" ? (
              <Button asChild>
                <Link
                  to={`/studio/${instance.id}/launch`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t("Open Studio", "Studio öffnen")}
                  <ExternalLink data-icon="inline-end" />
                </Link>
              </Button>
            ) : (
              <Button
                disabled={busy || action.isPending}
                onClick={() => action.mutate({ action: "start" })}
              >
                {busy && <Spinner />}
                {t("Start / retry", "Starten / erneut versuchen")}
              </Button>
            )}
          </div>
        }
      />
      {action.error && !pending && (
        <Alert variant="destructive">
          <AlertDescription>
            {supabaseErrorMessage(action.error, t)}
          </AlertDescription>
        </Alert>
      )}
      {current && (
        <Alert>
          <Spinner />
          <AlertTitle>{operationLabel(current, t)}</AlertTitle>
          <AlertDescription>
            <span role="status">{operationPhase(current, t)}</span>
          </AlertDescription>
        </Alert>
      )}
      {instance.error && (
        <Alert variant="destructive">
          <AlertTitle>
            {t(
              "This instance needs attention",
              "Diese Instanz benötigt Aufmerksamkeit",
            )}
          </AlertTitle>
          <AlertDescription>
            {supabaseOperationError(instance.error, t)}
          </AlertDescription>
        </Alert>
      )}
      <Tabs
        value={tab}
        onValueChange={(value) => setSearch({ tab: value })}
        className="gap-6"
      >
        <TabsList variant="line" className="max-w-full overflow-x-auto">
          <TabsTrigger value="overview">
            {t("Overview", "Übersicht")}
          </TabsTrigger>
          <TabsTrigger value="apps">{t("Apps", "Apps")}</TabsTrigger>
          <TabsTrigger value="functions">Edge Functions</TabsTrigger>
          <TabsTrigger value="backups">{t("Backups", "Backups")}</TabsTrigger>
          <TabsTrigger value="settings">
            {t("Settings", "Einstellungen")}
          </TabsTrigger>
          <TabsTrigger value="activity">
            {t("Activity", "Aktivitäten")}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <SupabaseOverview instance={instance} connections={links} connectionsReady={connections.isSuccess} navigate={(tab) => setSearch({ tab })} />
        </TabsContent>
        <TabsContent value="apps">
          <Card>
            <CardHeader>
              <CardTitle>
                {t("Apps using this instance", "Apps mit dieser Instanz")}
              </CardTitle>
              <CardDescription>
                {t(
                  "Connect an app, apply its settings and verify the connection.",
                  "Verbinde eine App, übernimm ihre Einstellungen und prüfe die Verbindung.",
                )}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <SupabaseConnections instance={instance} />
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent
          value="functions"
          forceMount
          className="data-[state=inactive]:hidden"
        >
          <Card>
            <CardContent>
              <SupabaseFunctions
                key={instance.id}
                instance={instance}
                busy={busy}
                active={tab === "functions"}
              />
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="backups">
          <SupabaseBackups instance={instance} busy={busy} onAction={ask} />
        </TabsContent>
        <TabsContent value="settings" className="flex max-w-5xl flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>{t("Email delivery", "E-Mail-Versand")}</CardTitle>
              <CardDescription>
                {t(
                  "Email for sign-up, password resets and invitations.",
                  "E-Mails für Registrierung, Passwort-Resets und Einladungen.",
                )}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <SupabaseSmtpSettings
                key={JSON.stringify(instance.settings)}
                instance={instance}
                busy={busy}
              />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>
                {t("Connection and access", "Verbindung und Zugang")}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <SupabaseCredentials
                key={instance.id}
                id={instance.id}
                busy={busy}
              />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>
                {t("Instance controls", "Instanz verwalten")}
              </CardTitle>
              <CardDescription>
                {t(
                  "Changes here can interrupt connected applications.",
                  "Änderungen hier können verbundene Anwendungen unterbrechen.",
                )}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="divide-y">
                <div className="flex flex-col gap-3 pb-5 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 flex-col gap-1">
                    <h3 className="text-sm font-medium">{t("Instance availability", "Verfügbarkeit der Instanz")}</h3>
                    <p className="text-sm text-muted-foreground">{t("Pausing keeps your data. Connected apps are unavailable until you restart.", "Beim Pausieren bleiben deine Daten erhalten. Verbundene Apps sind bis zum Neustart nicht erreichbar.")}</p>
                  </div>
                  {instance.status === "running" ? (
                    <Button variant="outline" disabled={busy} onClick={() => ask("stop")}>{t("Pause instance", "Instanz pausieren")}</Button>
                  ) : (
                    <Button variant="outline" disabled={busy} onClick={() => action.mutate({ action: "start" })}>{t("Start instance", "Instanz starten")}</Button>
                  )}
                </div>
                <div className="flex flex-col gap-3 py-5 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 flex-col gap-1">
                    <h3 className="text-sm font-medium">{t("Studio access", "Studio-Zugang")}</h3>
                    <p className="text-sm text-muted-foreground">{t("Replace the password used for manual Studio sign-in.", "Ersetzt das Passwort für die manuelle Anmeldung im Studio.")}</p>
                  </div>
                  <Button variant="outline" disabled={busy} onClick={() => ask("rotate")}>{t("Renew Studio password", "Studio-Passwort erneuern")}</Button>
                </div>
                <div className="flex flex-col gap-3 py-5 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 flex-col gap-1">
                    <h3 className="text-sm font-medium">{t("API keys", "API-Schlüssel")}</h3>
                    <p className="text-sm text-muted-foreground">{t("Existing keys stop working. Connected apps need to be updated.", "Bisherige Schlüssel werden ungültig. Verbundene Apps müssen aktualisiert werden.")}</p>
                  </div>
                  <Button variant="outline" disabled={busy} onClick={() => ask("rotate-keys")}>{t("Renew API keys", "API-Schlüssel erneuern")}</Button>
                </div>
                <div className="flex flex-col gap-3 pt-5 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 flex-col gap-1">
                    <h3 className="text-sm font-medium">{t("Archive instance", "Instanz archivieren")}</h3>
                    <p className="text-sm text-muted-foreground">{t("Stop this instance and disconnect its apps. Data and backups are retained.", "Stoppt die Instanz und trennt ihre Apps. Daten und Backups bleiben erhalten.")}</p>
                  </div>
                  <Button variant="destructive" disabled={busy || instance.status === "archived"} onClick={() => ask("archive")}>{t("Archive instance", "Instanz archivieren")}</Button>
                </div>
              </div>
              <p className="mt-6 text-xs text-muted-foreground">{instance.version}</p>
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="activity">
          <Card>
            <CardHeader>
              <CardTitle>
                <Activity className="mr-2 inline size-4" />
                {t("Activity", "Aktivitäten")}
              </CardTitle>
              <CardDescription>
                {t(
                  "Operations and their outcomes, without credentials or source code in logs.",
                  "Vorgänge und ihre Ergebnisse, ohne Zugangsdaten oder Quellcode in Protokollen.",
                )}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <SupabaseActivity jobs={instance.jobs} />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
      <Dialog
        open={!!pending}
        onOpenChange={(open) => {
          if (!open && !action.isPending) {
            setPending(null);
            setConfirmation("");
            action.reset();
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{dialogTitle}</DialogTitle>
            <DialogDescription>
              {pending?.action === "restore"
                ? t(
                    "This replaces current database, files and functions with the selected backup. Apps will be interrupted and may need updated keys. Previous data volumes are retained.",
                    "Aktuelle Datenbank, Dateien und Funktionen werden durch das gewählte Backup ersetzt. Apps werden unterbrochen und benötigen eventuell aktualisierte Schlüssel. Bisherige Datenvolumes bleiben erhalten.",
                  )
                : pending?.action === "archive"
                  ? t(
                      "Connected apps lose access. Data and backups are retained so you can reactivate this instance.",
                      "Verbundene Apps verlieren den Zugriff. Daten und Backups bleiben erhalten, damit du die Instanz reaktivieren kannst.",
                    )
                  : pending?.action === "rotate-keys"
                    ? t(
                        "Existing API keys and user sessions stop working. Reconnect and redeploy your apps afterwards.",
                        "Vorhandene API-Schlüssel und Benutzersitzungen werden ungültig. Verbinde deine Apps danach neu und stelle sie erneut bereit.",
                      )
                    : pending?.action === "stop"
                      ? t(
                          "Connected apps cannot access their database until you start this instance again.",
                          "Verbundene Apps können bis zum erneuten Start nicht auf ihre Datenbank zugreifen.",
                        )
                      : pending?.action === "backup"
                        ? t(
                            "The instance pauses briefly while its data is copied. Connected apps may be temporarily unavailable.",
                            "Die Instanz pausiert kurz während der Datenkopie. Verbundene Apps können vorübergehend nicht erreichbar sein.",
                          )
                        : t(
                            "Existing manual Studio credentials will stop working.",
                            "Die bisherigen manuellen Studio-Zugangsdaten werden ungültig.",
                          )}
            </DialogDescription>
          </DialogHeader>
          {chosenBackup && (
            <p className="text-sm">
              {t("Recovery point:", "Wiederherstellungspunkt:")}{" "}
              {new Date(chosenBackup.createdAt).toLocaleString(locale)}
            </p>
          )}
          {needsName && (
            <Field>
              <FieldLabel htmlFor="confirm-instance">
                {t(
                  "Type the instance name to confirm",
                  "Instanznamen zur Bestätigung eingeben",
                )}
                : {instance.name}
              </FieldLabel>
              <Input
                id="confirm-instance"
                value={confirmation}
                onChange={(e) => setConfirmation(e.target.value)}
                autoComplete="off"
              />
            </Field>
          )}
          {action.error && (
            <Alert variant="destructive">
              <AlertDescription>
                {supabaseErrorMessage(action.error, t)}
              </AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={action.isPending}
              onClick={() => setPending(null)}
            >
              {t("Cancel", "Abbrechen")}
            </Button>
            <Button
              variant={needsName ? "destructive" : "default"}
              disabled={
                action.isPending ||
                busy ||
                Boolean(needsName && confirmation !== instance.name)
              }
              onClick={() => {
                if (pending)
                  action.mutate({
                    ...pending,
                    ...(needsName ? { confirmation } : {}),
                  });
              }}
            >
              {action.isPending && <Spinner />}
              {pending?.action === "restore" ? t("Restore backup", "Backup wiederherstellen")
                : pending?.action === "archive" ? t("Archive instance", "Instanz archivieren")
                : pending?.action === "rotate-keys" ? t("Renew API keys", "API-Schlüssel erneuern")
                : pending?.action === "stop" ? t("Pause instance", "Instanz pausieren")
                : pending?.action === "backup" ? t("Create backup", "Backup erstellen")
                : t("Renew Studio password", "Studio-Passwort erneuern")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
