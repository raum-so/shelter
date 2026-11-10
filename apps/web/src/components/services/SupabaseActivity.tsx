import { CheckCircle2, CircleAlert, Clock3 } from "lucide-react";
import type { SupabaseJob } from "@/api/supabase-types";
import { useI18n } from "@/i18n";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { supabaseOperationError } from "@/lib/supabase-errors";

export function operationLabel(
  job: SupabaseJob,
  t: ReturnType<typeof useI18n>["t"],
) {
  const labels: Record<string, [string, string]> = {
    start: ["Start instance", "Instanz starten"],
    stop: ["Pause instance", "Instanz pausieren"],
    backup: ["Create backup", "Backup erstellen"],
    restore: ["Restore backup", "Backup wiederherstellen"],
    rotate: ["Renew Studio password", "Studio-Passwort erneuern"],
    "rotate-keys": ["Renew API keys", "API-Schlüssel erneuern"],
    archive: ["Archive instance", "Instanz archivieren"],
    "function-deploy": ["Deploy function", "Funktion bereitstellen"],
    "function-delete": ["Remove function", "Funktion entfernen"],
    "functions-sync": ["Refresh functions", "Funktionen aktualisieren"],
    "function-invoke": ["Test function", "Funktion testen"],
    "connection-check": ["Test app connection", "App-Verbindung testen"],
    "backup-verify": ["Test backup recovery", "Wiederherstellung testen"],
    "backup-destination-check": [
      "Test backup storage",
      "Backup-Speicher testen",
    ],
  };
  return t(
    ...(labels[job.operation?.kind ?? job.action] ?? [
      "Update instance",
      "Instanz aktualisieren",
    ]),
  );
}
export function operationPhase(
  job: SupabaseJob,
  t: ReturnType<typeof useI18n>["t"],
) {
  const phases: Record<string, [string, string]> = {
    queued: ["Waiting", "Wartet"],
    checking: ["Checking requirements", "Voraussetzungen prüfen"],
    starting: ["Starting services", "Dienste starten"],
    routing: ["Connecting domains", "Domains verbinden"],
    backup: ["Saving encrypted backup", "Verschlüsseltes Backup erstellen"],
    restoring: ["Restoring data", "Daten wiederherstellen"],
    validating: ["Checking code in the runtime", "Code in der Laufzeit prüfen"],
    activating: ["Activating version", "Version aktivieren"],
    health: ["Checking availability", "Verfügbarkeit prüfen"],
    "rolling-back": [
      "Restoring previous version",
      "Vorherige Version wiederherstellen",
    ],
    request: ["Sending test request", "Testanfrage senden"],
    verifying: ["Verifying backup", "Backup prüfen"],
    "test-restore": [
      "Starting isolated restore test",
      "Getrennten Wiederherstellungstest starten",
    ],
    uploading: ["Copying to backup storage", "In Backup-Speicher kopieren"],
    complete: ["Complete", "Abgeschlossen"],
    failed: ["Failed", "Fehlgeschlagen"],
  };
  return t(
    ...(phases[job.operation?.phase ?? job.status] ?? [
      "Working…",
      "Wird ausgeführt…",
    ]),
  );
}
export function SupabaseActivity({
  jobs,
  compact = false,
}: {
  jobs: SupabaseJob[];
  compact?: boolean;
}) {
  const { t, locale } = useI18n();
  const visible = compact ? jobs.slice(0, 4) : jobs;
  return (
    <div className="flex flex-col gap-4">
      {!visible.length && (
        <p className="text-sm text-muted-foreground">
          {t("No recent activity.", "Noch keine Aktivitäten.")}
        </p>
      )}
      {visible.map((job) => {
        const busy = ["queued", "running"].includes(job.status);
        return (
          <div key={job.id} className="flex flex-col gap-2">
            <div className="flex items-start gap-3">
              {busy ? (
                <Spinner />
              ) : job.status === "ready" ? (
                <CheckCircle2 className="mt-0.5 size-4 text-success" />
              ) : (
                <CircleAlert className="mt-0.5 size-4 text-destructive" />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium">
                    {operationLabel(job, t)}
                  </span>
                  <Badge
                    variant={
                      job.status === "failed" ? "destructive" : "outline"
                    }
                  >
                    {busy
                      ? operationPhase(job, t)
                      : job.status === "ready"
                        ? t("Complete", "Abgeschlossen")
                        : t("Failed", "Fehlgeschlagen")}
                  </Badge>
                </div>
                {job.createdAt && (
                  <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                    <Clock3 className="size-3" />
                    <time dateTime={job.createdAt}>
                      {new Date(job.createdAt).toLocaleString(locale)}
                    </time>
                  </p>
                )}
              </div>
            </div>
            {job.status === "failed" && (
              <Alert variant="destructive">
                <AlertTitle>
                  {t("Action needed", "Nächster Schritt")}
                </AlertTitle>
                <AlertDescription>
                  {supabaseOperationError(job.error, t)}
                </AlertDescription>
              </Alert>
            )}
          </div>
        );
      })}
    </div>
  );
}
