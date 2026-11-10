import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Database, ExternalLink, ArrowLeft, ChevronRight } from "lucide-react";
import { api } from "@/api/client";
import { useI18n } from "@/i18n";
import { PageIntro } from "@/components/ui";
import { SupabaseSetup } from "@/components/services/SupabaseSetup";
import { ServerCapacity } from "@/components/services/ServerCapacity";
import { SupabaseStatus } from "./SupabaseInstancePage";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
} from "@/components/ui/empty";
import { supabaseErrorMessage as errorMessage } from "@/lib/supabase-errors";
export function SupabasePage() {
  const { t } = useI18n();
  const client = useQueryClient();
  const navigate = useNavigate();
  const connections = useQuery({
    queryKey: ["supabase-connections"],
    queryFn: api.supabaseConnections,
    refetchInterval: 6000,
  });
  const query = useQuery({
    queryKey: ["supabase"],
    queryFn: api.supabaseInstances,
    refetchInterval: 4000,
  });
  const [open, setOpen] = useState(false);
  const [createError, setCreateError] = useState<Error | null>(null);
  const create = useMutation({
    gcTime: 0,
    mutationFn: api.createSupabase,
    onMutate: () => setCreateError(null),
    onError: (error) => setCreateError(error),
    onSettled: (): void => {
      create.reset();
    },
    onSuccess: ({ instance }) => {
      setOpen(false);
      navigate(`/services/${instance.id}`);
      void client.invalidateQueries({ queryKey: ["supabase"] });
      void client.invalidateQueries({ queryKey: ["supabase-connections"] });
    },
  });
  return (
    <div className="flex flex-col gap-6">
      <PageIntro
        eyebrow={open ? t("Services", "Dienste") : undefined}
        title={
          open
            ? t("Set up a database", "Datenbank einrichten")
            : t("Services", "Dienste")
        }
        description={
          open
            ? t(
                "Choose your app. Shelter takes care of installation and secure access.",
                "Wähle deine App. Shelter übernimmt Installation und sichere Zugänge.",
              )
            : t(
                "Database, sign-in and files for your apps.",
                "Datenbank, Anmeldung und Dateien für deine Apps.",
              )
        }
        actions={
          <Button
            variant={open ? "outline" : "default"}
            disabled={create.isPending}
            onClick={() => {
              setOpen((value) => !value);
              setCreateError(null);
            }}
          >
            {open ? (
              <ArrowLeft data-icon="inline-start" />
            ) : (
              <Database data-icon="inline-start" />
            )}
            {open
              ? t("Back to services", "Zurück zu den Diensten")
              : t("Add database", "Datenbank hinzufügen")}
          </Button>
        }
      />
      <ServerCapacity />
      {createError && (
        <Alert variant="destructive">
          <AlertTitle>
            {t(
              "Supabase could not be created",
              "Supabase konnte nicht erstellt werden",
            )}
          </AlertTitle>
          <AlertDescription>{errorMessage(createError, t)}</AlertDescription>
        </Alert>
      )}
      {open && (
        <SupabaseSetup
          pending={create.isPending}
          onSubmit={(input) => create.mutate(input)}
        />
      )}
      {!open &&
        (query.isLoading ? (
          <Skeleton className="h-48" />
        ) : query.isError ? (
          <Alert variant="destructive">
            <AlertTitle>
              {t(
                "Services could not be loaded",
                "Dienste konnten nicht geladen werden",
              )}
            </AlertTitle>
            <AlertDescription>
              <Button variant="outline" onClick={() => query.refetch()}>
                {t("Try again", "Erneut versuchen")}
              </Button>
            </AlertDescription>
          </Alert>
        ) : !query.data?.instances.length ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Database />
              </EmptyMedia>
              <EmptyTitle>
                {t(
                  "A home for your app’s data",
                  "Ein Zuhause für deine App-Daten",
                )}
              </EmptyTitle>
              <EmptyDescription>
                {t(
                  "Add a database, user sign-in and file storage. Shelter handles the setup on your server.",
                  "Ergänze Datenbank, Benutzeranmeldung und Dateiablage. Shelter übernimmt die Einrichtung auf deinem Server.",
                )}
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button onClick={() => setOpen(true)}>
                <Database data-icon="inline-start" />
                {t("Add database", "Datenbank hinzufügen")}
              </Button>
            </EmptyContent>
          </Empty>
        ) : (
          <Card>
            <CardContent className="divide-y">
              {query.data.instances.map((instance) => {
                const busy = instance.jobs.some(job => ["queued", "running"].includes(job.status));
                const count = connections.isSuccess ? connections.data.connections.filter(link => link.instanceId === instance.id).length : null;
                const backedUp = instance.backups.some(backup => backup.status === "ready");
                return <article key={instance.id} className="flex flex-col gap-4 py-5 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 items-start gap-4">
                    <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-muted"><Database className="size-5 text-muted-foreground" aria-hidden="true" /></div>
                    <div className="flex min-w-0 flex-col gap-2">
                      <div className="flex flex-wrap items-center gap-3"><Link to={`/services/${instance.id}`} className="font-semibold hover:underline">{instance.name}</Link><SupabaseStatus instance={instance} /></div>
                      <p className="truncate text-sm text-muted-foreground">{new URL(instance.apiUrl).hostname}</p>
                      <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground"><span>{count === null ? t("Connections loading", "Verbindungen werden geladen") : t("{count} connected apps", "{count} verbundene Apps", { count })}</span><span>{backedUp ? t("Backup available", "Backup vorhanden") : t("No backup yet", "Noch kein Backup")}</span>{busy && <span role="status">{t("Operation in progress", "Vorgang läuft")}</span>}</p>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button asChild variant="ghost"><Link to={`/services/${instance.id}`}>{t("Overview", "Übersicht")}<ChevronRight data-icon="inline-end" /></Link></Button>
                    {instance.status === "running" && <Button asChild variant="outline"><Link to={`/studio/${instance.id}/launch`} target="_blank" rel="noreferrer">{t("Open Studio", "Studio öffnen")}<ExternalLink data-icon="inline-end" /></Link></Button>}
                  </div>
                </article>;
              })}
            </CardContent>
          </Card>
        ))}
    </div>
  );
}
