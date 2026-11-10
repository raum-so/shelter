import { useEffect, useState } from "react";
import { formatRelative } from "@/utils/format";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CalendarClock,
  DatabaseBackup,
  HardDrive,
  ShieldCheck,
} from "lucide-react";
import { api } from "@/api/client";
import type {
  SupabaseBackupPolicy,
  SupabaseInstance,
} from "@/api/supabase-types";
import { useI18n } from "@/i18n";
import { Button } from "@/components/ui/button";
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
import { Switch } from "@/components/ui/switch";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";
import {
  supabaseErrorMessage,
  supabaseOperationError,
} from "@/lib/supabase-errors";

export function SupabaseBackups({
  instance,
  busy,
  onAction,
}: {
  instance: SupabaseInstance;
  busy: boolean;
  onAction: (action: string, backupId?: string) => void;
}) {
  const { t, locale } = useI18n(),
    client = useQueryClient();
  const query = useQuery({
    queryKey: ["supabase-backup-policy", instance.id],
    queryFn: () => api.supabaseBackupPolicy(instance.id),
    refetchOnWindowFocus: false,
  });
  const [form, setForm] = useState<SupabaseBackupPolicy | null>(null),
    [notice, setNotice] = useState(false),
    [jobId, setJobId] = useState<string | null>(null);
  useEffect(() => {
    if (query.data) setForm(query.data);
  }, [query.data]);
  const save = useMutation({
    mutationFn: () => api.supabaseSaveBackupPolicy(instance.id, form!),
    onSuccess: (policy) => {
      setForm(policy);
      setNotice(true);
      void client.invalidateQueries({
        queryKey: ["supabase-backup-policy", instance.id],
      });
    },
  });
  const check = useMutation({
    mutationFn: (backupId: string | null) =>
      backupId
        ? api.supabaseVerifyBackup(instance.id, backupId)
        : api.supabaseCheckBackupDestination(instance.id),
    onSuccess: (result) => {
      setJobId(result.jobId);
      void client.invalidateQueries({ queryKey: ["supabase"] });
    },
  });
  const job = instance.jobs.find((job) => job.id === jobId);
  const upload = useMutation({
    mutationFn: (backupId: string) =>
      api.supabaseUploadBackup(instance.id, backupId),
    onSuccess: (result) => {
      setJobId(result.jobId);
      void client.invalidateQueries({ queryKey: ["supabase"] });
    },
  });
  const modified = JSON.stringify(form) !== JSON.stringify(query.data);
  const updateS3 = (field: string, value: string) => {
    if (!form) return;
    setNotice(false);
    setForm({
      ...form,
      s3: {
        endpoint: "https://",
        region: "us-east-1",
        bucket: "",
        accessKeyId: "",
        ...form.s3,
        [field]: value,
      },
    });
  };
  const completed = instance.backups.filter(backup => backup.status === "ready").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const latest = completed[0];
  const copied = completed.find(backup => backup.verification?.offsiteAt);
  const tested = completed.find(backup => backup.verification?.restoredAt);
  return (
    <div className="grid min-w-0 items-start gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(20rem,1fr)]">
      <Card className="xl:col-span-2"><CardHeader><CardTitle>{t("Your recovery status", "Deine Absicherung")}</CardTitle><CardDescription>{t("A backup, an external copy and a restore test each cover a different risk.", "Backup, externe Kopie und Wiederherstellungstest sichern unterschiedliche Risiken ab.")}</CardDescription></CardHeader><CardContent>
        <dl className="grid gap-5 sm:grid-cols-3">
          {[
            [t("Last backup", "Letztes Backup"), latest ? formatRelative(latest.createdAt, locale) : t("Not created yet", "Noch nicht erstellt")],
            [t("External copy", "Externe Kopie"), copied ? formatRelative(copied.verification!.offsiteAt!, locale) : t("Not available", "Nicht vorhanden")],
            [t("Restore tested", "Wiederherstellung geprüft"), tested ? formatRelative(tested.verification!.restoredAt!, locale) : t("Not tested yet", "Noch nicht getestet")],
          ].map(([label, value]) => <div key={label}><dt className="text-sm text-muted-foreground">{label}</dt><dd className="mt-1 text-sm font-medium">{value}</dd></div>)}
        </dl>
        {!copied && <p className="mt-5 text-sm text-muted-foreground">{t("Backups on this server cannot protect against losing the server. Connect external storage below.", "Backups auf diesem Server schützen nicht vor dessen Verlust. Verbinde unten einen externen Speicher.")}</p>}
      </CardContent></Card>
      <Card>
        <CardHeader>
          <CardTitle>
            {t("Recovery points", "Wiederherstellungspunkte")}
          </CardTitle>
          <CardDescription>
            {t(
              "Encrypted copies of your database, files and functions. Creating a backup briefly pauses this instance.",
              "Verschlüsselte Kopien deiner Datenbank, Dateien und Funktionen. Ein Backup pausiert diese Instanz kurz.",
            )}
          </CardDescription>
          <CardAction>
            <Button
              disabled={busy || instance.status === "archived"}
              onClick={() => onAction("backup")}
            >
              <DatabaseBackup data-icon="inline-start" />
              {t("Create backup", "Backup erstellen")}
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {!instance.backups.length ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <HardDrive />
                </EmptyMedia>
                <EmptyTitle>
                  {t(
                    "Your first recovery point",
                    "Dein erster Wiederherstellungspunkt",
                  )}
                </EmptyTitle>
                <EmptyDescription>
                  {t(
                    "Create a backup before changing important data.",
                    "Erstelle ein Backup, bevor du wichtige Daten änderst.",
                  )}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            instance.backups.map((backup) => (
              <div
                key={backup.id}
                className="flex flex-wrap items-center justify-between gap-4 border-b py-4 last:border-b-0"
              >
                <div className="flex flex-col gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">
                      {new Date(backup.createdAt).toLocaleString(locale)}
                    </span>
                    <Badge
                      variant={
                        backup.status === "failed" ? "destructive" : "outline"
                      }
                    >
                      {backup.status === "ready"
                        ? t("Available", "Verfügbar")
                        : backup.status === "creating"
                          ? t("Creating", "Wird erstellt")
                          : t("Incomplete", "Unvollständig")}
                    </Badge>
                  </div>
                  <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                    <span>
                      {backup.sizeBytes
                        ? `${(backup.sizeBytes / 1024 ** 2).toFixed(1)} MB`
                        : "—"}
                    </span>
                    <span>
                      {backup.verification?.restoredAt
                        ? t("Restore tested", "Wiederherstellung getestet")
                        : t(
                            "Restore not tested yet",
                            "Wiederherstellung noch nicht getestet",
                          )}
                    </span>
                    <span>
                      {backup.verification?.offsiteAt
                        ? t("External copy verified", "Externe Kopie geprüft")
                        : t(
                            "Stored on this server",
                            "Auf diesem Server gespeichert",
                          )}
                    </span>
                  </div>
                  {backup.verification?.error && (
                    <p className="text-sm text-destructive">
                      {supabaseOperationError(backup.verification.error, t)}
                    </p>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={
                      busy || check.isPending || backup.status !== "ready"
                    }
                    onClick={() => check.mutate(backup.id)}
                  >
                    <ShieldCheck data-icon="inline-start" />
                    {t("Test restore", "Wiederherstellung testen")}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || backup.status !== "ready"}
                    onClick={() => onAction("restore", backup.id)}
                  >
                    {t("Restore", "Wiederherstellen")}
                  </Button>
                </div>
              </div>
            ))
          )}
          <p className="text-xs text-muted-foreground">
            {t(
              "A restore test starts a separate temporary instance and checks its availability. Your active data stays unchanged; free server capacity is required.",
              "Der Test startet eine getrennte temporäre Instanz und prüft ihre Verfügbarkeit. Deine aktiven Daten bleiben unverändert; freie Serverkapazität ist erforderlich.",
            )}
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>
            {t("Automatic backups", "Automatische Backups")}
          </CardTitle>
          <CardDescription>
            {t(
              "Choose when and where recovery points are saved.",
              "Lege fest, wann und wo Wiederherstellungspunkte gespeichert werden.",
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {query.isError ? (
            <Alert variant="destructive">
              <AlertDescription>
                <Button variant="outline" onClick={() => query.refetch()}>
                  {t("Retry", "Erneut versuchen")}
                </Button>
              </AlertDescription>
            </Alert>
          ) : !form ? (
            <Spinner />
          ) : (
            <form
              className="flex flex-col gap-5"
              onSubmit={(event) => {
                event.preventDefault();
                setNotice(false);
                save.mutate();
              }}
            >
              <FieldGroup>
                <Field orientation="horizontal">
                  <FieldLabel htmlFor="backup-enabled">
                    {t("Daily backup", "Tägliches Backup")}
                  </FieldLabel>
                  <Switch
                    id="backup-enabled"
                    checked={form.enabled}
                    onCheckedChange={(enabled) => {
                      setNotice(false);
                      setForm({ ...form, enabled });
                    }}
                  />
                </Field>
                <Field orientation="horizontal">
                  <div>
                    <FieldLabel htmlFor="backup-verify-weekly">
                      {t(
                        "Weekly restore test",
                        "Wöchentlicher Wiederherstellungstest",
                      )}
                    </FieldLabel>
                    <FieldDescription>
                      {t(
                        "Starts a separate temporary instance after a backup. Requires additional free memory and disk space.",
                        "Startet nach einem Backup eine getrennte temporäre Instanz. Benötigt zusätzlich freien Arbeitsspeicher und Speicherplatz.",
                      )}
                    </FieldDescription>
                  </div>
                  <Switch
                    id="backup-verify-weekly"
                    checked={form.verifyWeekly}
                    onCheckedChange={(verifyWeekly) => {
                      setNotice(false);
                      setForm({ ...form, verifyWeekly });
                    }}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="backup-hour">
                    {t("Start time (UTC)", "Startzeit (UTC)")}
                  </FieldLabel>
                  <NativeSelect
                    id="backup-hour"
                    value={form.hourUtc}
                    onChange={(event) => {
                      setNotice(false);
                      setForm({ ...form, hourUtc: Number(event.target.value) });
                    }}
                  >
                    {Array.from({ length: 24 }, (_, hour) => (
                      <NativeSelectOption key={hour} value={hour}>
                        {String(hour).padStart(2, "0")}:00 UTC
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                  {form.nextAt && (
                    <FieldDescription>
                      {t("Next backup:", "Nächstes Backup:")}{" "}
                      {new Date(form.nextAt).toLocaleString(locale)}
                    </FieldDescription>
                  )}
                </Field>
                <Field>
                  <FieldLabel htmlFor="backup-destination">
                    {t("Storage", "Speicherziel")}
                  </FieldLabel>
                  <NativeSelect
                    id="backup-destination"
                    value={form.destination}
                    onChange={(event) => {
                      setNotice(false);
                      setForm({
                        ...form,
                        destination: event.target.value as "local" | "s3",
                      });
                    }}
                  >
                    <NativeSelectOption value="local">
                      {t("This server", "Dieser Server")}
                    </NativeSelectOption>
                    <NativeSelectOption value="s3">
                      {t(
                        "This server + S3 storage",
                        "Dieser Server + S3-Speicher",
                      )}
                    </NativeSelectOption>
                  </NativeSelect>
                  <FieldDescription>
                    {t(
                      "Keep an external copy of Shelter’s recovery material as well. Backups are never automatically deleted.",
                      "Bewahre auch Shelters Wiederherstellungsdaten extern auf. Backups werden nicht automatisch gelöscht.",
                    )}
                  </FieldDescription>
                </Field>
                {form.destination === "s3" && (
                  <FieldGroup className="grid gap-4 sm:grid-cols-2">
                    {(
                      [
                        ["endpoint", t("S3 endpoint", "S3-Endpunkt")],
                        ["region", t("Region", "Region")],
                        ["bucket", t("Bucket", "Bucket")],
                        ["accessKeyId", t("Access key ID", "Access-Key-ID")],
                        [
                          "secretAccessKey",
                          t("Secret access key", "Geheimer Zugriffsschlüssel"),
                        ],
                      ] as const
                    ).map(([key, label]) => (
                      <Field key={key}>
                        <FieldLabel htmlFor={`backup-${key}`}>
                          {label}
                        </FieldLabel>
                        <Input
                          id={`backup-${key}`}
                          type={key === "secretAccessKey" ? "password" : "text"}
                          autoComplete="off"
                          value={form.s3?.[key] ?? ""}
                          onChange={(e) => updateS3(key, e.target.value)}
                          required={
                            key !== "secretAccessKey" || !form.s3?.hasSecret
                          }
                        />
                      </Field>
                    ))}
                  </FieldGroup>
                )}
              </FieldGroup>
              <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={save.isPending || busy || !modified}>
                  {save.isPending ? (
                    <Spinner />
                  ) : (
                    <CalendarClock data-icon="inline-start" />
                  )}
                  {t("Save backup settings", "Backup-Einstellungen speichern")}
                </Button>
                {form.destination === "s3" && (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={
                      save.isPending || busy || check.isPending || modified
                    }
                    onClick={() => check.mutate(null)}
                  >
                    {t("Test saved storage", "Gespeicherten Speicher testen")}
                  </Button>
                )}
              </div>
              {notice && (
                <p role="status" className="text-sm xl:col-span-2">
                  {t(
                    "Backup settings saved.",
                    "Backup-Einstellungen gespeichert.",
                  )}
                </p>
              )}
            </form>
          )}
        </CardContent>
      </Card>
      {(save.error ||
        check.error ||
        upload.error ||
        job?.status === "failed") && (
        <Alert variant="destructive" className="xl:col-span-2">
          <AlertDescription>
            {save.error || check.error || upload.error
              ? supabaseErrorMessage(
                  save.error ?? check.error ?? upload.error,
                  t,
                )
              : supabaseOperationError(job?.error ?? null, t)}
          </AlertDescription>
        </Alert>
      )}
      {job?.status === "ready" && (
        <p role="status" className="text-sm xl:col-span-2">
          {t(
            "Verification completed successfully.",
            "Prüfung erfolgreich abgeschlossen.",
          )}
        </p>
      )}
    </div>
  );
}
