import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  AppWindow,
  CheckCircle2,
  Cloud,
  Database,
  Mail,
  ShieldCheck,
} from "lucide-react";
import { api } from "@/api/client";
import type {
  SupabaseConnection,
  SupabaseInstance,
} from "@/api/supabase-types";
import { useI18n } from "@/i18n";
import { formatRelative } from "@/utils/format";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { SupabaseActivity } from "./SupabaseActivity";

export function SupabaseOverview({
  instance,
  connections,
  connectionsReady,
  navigate,
}: {
  instance: SupabaseInstance;
  connections: SupabaseConnection[];
  connectionsReady: boolean;
  navigate: (tab: string) => void;
}) {
  const { t, locale } = useI18n();
  const policy = useQuery({
    queryKey: ["supabase-backup-policy", instance.id],
    queryFn: () => api.supabaseBackupPolicy(instance.id),
  });
  const backups = instance.backups
    .filter((backup) => backup.status === "ready")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const latest = backups[0];
  const external = backups.find((backup) => backup.verification?.offsiteAt);
  const tested = backups.find((backup) => backup.verification?.restoredAt);
  const appReady =
    connectionsReady &&
    connections.length > 0 &&
    connections.every(
      (link) =>
        link.status === "ready" &&
        link.verification?.ok &&
        Date.parse(link.verification.checkedAt) >= Date.parse(link.updatedAt),
    );
  const needsAppUpdate = connections.some(link => link.status === "redeploy_required");
  const needsConnectionUpdate = connections.some(link => ["needs_update", "error"].includes(link.status));
  const connectionAction = needsConnectionUpdate
    ? t("Update connection", "Verbindung aktualisieren")
    : needsAppUpdate
      ? t("Update app", "App aktualisieren")
      : connections.length && connections.every(link => link.status === "ready")
        ? t("Test connection", "Verbindung testen")
        : t("Set up connection", "Verbindung einrichten");
  const recent = (time: string | undefined, hours: number) => {
    const age = Date.now() - Date.parse(time ?? "");
    return age >= -30_000 && age <= hours * 60 * 60 * 1000;
  };
  const protectionReady =
    recent(latest?.createdAt, 48) &&
    recent(external?.createdAt, 48) &&
    recent(tested?.verification?.restoredAt ?? undefined, 8 * 24);
  const rows = [
    {
      icon: Database,
      title: t("Database & API", "Datenbank & API"),
      detail:
        instance.status === "running"
          ? t(
              "Your instance is running and ready for requests.",
              "Deine Instanz läuft und kann Anfragen verarbeiten.",
            )
          : t(
              "Open the activity log to see the current operation.",
              "In den Aktivitäten siehst du den aktuellen Vorgang.",
            ),
      done: instance.status === "running",
      label:
        instance.status === "running"
          ? t("Running", "Läuft")
          : t("View activity", "Aktivitäten ansehen"),
      tab: "activity",
    },
    {
      icon: AppWindow,
      title: t("App connections", "App-Verbindungen"),
      detail: !connectionsReady
        ? t(
            "Connection status is unavailable.",
            "Der Verbindungsstatus ist nicht verfügbar.",
          )
        : !connections.length
          ? t(
              "Connect your app to start using Supabase.",
              "Verbinde deine App, um Supabase zu nutzen.",
            )
          : needsAppUpdate
            ? t("Your database is ready. Update your app once to activate the connection.", "Deine Datenbank ist bereit. Aktualisiere deine App einmal, um die Verbindung zu aktivieren.")
            : t(
                "{count} connected · settings, deployment and reachability in one place.",
                "{count} verbunden · Einstellungen, Deployment und Erreichbarkeit an einem Ort.",
                { count: connections.length },
              ),
      done: appReady,
      label: appReady
        ? t("Checked", "Geprüft")
        : connectionAction,
      tab: "apps",
    },
    {
      icon: Mail,
      title: t("Sign-in emails", "Anmelde-E-Mails"),
      detail: instance.settings.smtpPending
        ? t(
            "New email settings are being applied.",
            "Neue E-Mail-Einstellungen werden übernommen.",
          )
        : instance.settings.smtp
          ? t(
              "Registration and password resets can send emails.",
              "Registrierung und Passwort-Zurücksetzen können E-Mails versenden.",
            )
          : t(
              "Email sign-up is off. Set up a sender when your app needs it.",
              "E-Mail-Registrierung ist aus. Richte bei Bedarf einen Absender ein.",
            ),
      done: !!instance.settings.smtp && !instance.settings.smtpPending,
      label:
        instance.settings.smtp && !instance.settings.smtpPending
          ? t("Configured", "Eingerichtet")
          : t("Set up email", "E-Mail einrichten"),
      tab: "settings",
    },
    {
      icon: ShieldCheck,
      title: t("Data protection", "Datensicherung"),
      detail: !latest
        ? t(
            "Create your first recovery point and choose a backup schedule.",
            "Erstelle den ersten Wiederherstellungspunkt und wähle einen Zeitplan.",
          )
        : t(
            "Last backup {time}. Keep an external copy for server failures.",
            "Letztes Backup {time}. Eine externe Kopie schützt bei Serverausfall.",
            { time: formatRelative(latest.createdAt, locale) },
          ),
      done: protectionReady,
      label: protectionReady
        ? t("Protected", "Abgesichert")
        : t("Review protection", "Absicherung prüfen"),
      tab: "backups",
    },
  ];
  return (
    <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.8fr)_minmax(16rem,1fr)]">
      <Card>
        <CardHeader>
          <CardTitle>
            {t("Everything your app needs", "Alles für deine App")}
          </CardTitle>
          <CardDescription>
            {t(
              "See what is ready and pick up the next step.",
              "Sieh, was bereit ist, und erledige den nächsten Schritt.",
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="divide-y">
            {rows.map((row) => (
              <li
                key={row.tab}
                className="flex items-start gap-4 py-5 first:pt-0 last:pb-0"
              >
                <row.icon
                  className="mt-1 size-5 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-sm font-medium">{row.title}</h3>
                    {row.done && (
                      <span className="flex items-center gap-1.5 text-xs text-success">
                        <CheckCircle2 className="size-3.5" aria-hidden="true" />
                        {row.label}
                      </span>
                    )}
                  </div>
                  <p className="max-w-lg text-sm leading-relaxed text-muted-foreground">
                    {row.detail}
                  </p>
                  {!row.done && (
                    <div>
                      <Button
                        variant="link"
                        size="sm"
                        onClick={() => navigate(row.tab)}
                      >
                        {row.label}
                        <ArrowRight data-icon="inline-end" />
                      </Button>
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
      <div className="flex min-w-0 flex-col gap-6">
        <Card>
          <CardHeader>
            <CardTitle>
              {t("Recovery at a glance", "Absicherung im Blick")}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <dl className="flex flex-col gap-4 text-sm">
              <div className="flex items-center justify-between gap-3">
                <dt className="text-muted-foreground">
                  {t("Schedule", "Zeitplan")}
                </dt>
                <dd>
                  {policy.isPending ? (
                    <Skeleton className="h-4 w-16" />
                  ) : policy.isError ? (
                    t("Unavailable", "Nicht verfügbar")
                  ) : policy.data?.enabled ? (
                    t("Daily", "Täglich")
                  ) : (
                    t("Not enabled", "Nicht aktiviert")
                  )}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-muted-foreground">
                  {t("External copy", "Externe Kopie")}
                </dt>
                <dd>
                  {external
                    ? formatRelative(external.verification!.offsiteAt!, locale)
                    : t("Missing", "Fehlt")}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-muted-foreground">
                  {t("Restore test", "Wiederherstellungstest")}
                </dt>
                <dd>
                  {tested
                    ? formatRelative(tested.verification!.restoredAt!, locale)
                    : t("Not tested", "Nicht geprüft")}
                </dd>
              </div>
            </dl>
            <Button variant="outline" onClick={() => navigate("backups")}>
              <Cloud data-icon="inline-start" />
              {t("Manage backups", "Backups verwalten")}
            </Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t("Connected apps", "Verbundene Apps")}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {!connectionsReady ? (
              <p className="text-sm text-muted-foreground">
                {t("Status unavailable", "Status nicht verfügbar")}
              </p>
            ) : !connections.length ? (
              <p className="text-sm text-muted-foreground">
                {t(
                  "Your next step: connect an app.",
                  "Dein nächster Schritt: eine App verbinden.",
                )}
              </p>
            ) : (
              connections.map((link) => (
                <Link
                  key={link.projectId}
                  to={`/projects/${link.projectId}`}
                  className="flex items-center justify-between gap-3 text-sm hover:underline"
                >
                  <span className="truncate">{link.projectName}</span>
                  <ArrowRight
                    className="size-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                </Link>
              ))
            )}
            <Button variant="outline" onClick={() => navigate("apps")}>
              <AppWindow data-icon="inline-start" />
              {t("Manage connections", "Verbindungen verwalten")}
            </Button>
          </CardContent>
        </Card>
      </div>
      <Card className="xl:col-span-2">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>{t("Recent activity", "Letzte Aktivitäten")}</CardTitle>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate("activity")}
          >
            {t("View all", "Alle ansehen")}
            <ArrowRight data-icon="inline-end" />
          </Button>
        </CardHeader>
        <CardContent>
          <SupabaseActivity jobs={instance.jobs} compact />
        </CardContent>
      </Card>
    </div>
  );
}
