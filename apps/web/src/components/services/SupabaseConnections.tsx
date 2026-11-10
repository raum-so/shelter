import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  ChevronDown,
  Link2,
  Plus,
  Unplug,
  CheckCircle2,
  Circle,
  ShieldCheck,
} from "lucide-react";
import { api, ApiError } from "@/api/client";
import type {
  SupabaseConnection,
  SupabaseConnectionInput,
  SupabaseInstance,
} from "@/api/supabase-types";
import { useI18n } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "@/components/ui/spinner";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";

type Context =
  | { instance: SupabaseInstance; project?: never }
  | { project: { id: string; name: string }; instance?: never };
function message(error: unknown, t: ReturnType<typeof useI18n>["t"]) {
  const details = error instanceof ApiError ? error.details : null;
  const code =
    details && typeof details === "object" && "code" in details
      ? details.code
      : null;
  const messages: Record<string, [string, string]> = {
    ENV_EXISTS: [
      "Existing Supabase variables need explicit replacement.",
      "Bestätige ausdrücklich das Ersetzen vorhandener Supabase-Variablen.",
    ],
    ENV_CHANGED: [
      "The app variables changed. Review them before replacing.",
      "Die App-Variablen wurden geändert. Prüfe sie vor dem Ersetzen.",
    ],
    CONNECTION_EXISTS: [
      "This app is linked to another instance. Confirm replacement.",
      "Diese App ist mit einer anderen Instanz verbunden. Bestätige das Ersetzen.",
    ],
    CONNECTION_VARIABLES_CHANGED: [
      "Disconnect first to change the variable names.",
      "Trenne zuerst die Verbindung, um Variablennamen zu ändern.",
    ],
    PROJECT_UNAVAILABLE: [
      "Wait until the app’s current operation has finished.",
      "Warte, bis der laufende Vorgang der App abgeschlossen ist.",
    ],
    INSTANCE_ARCHIVED: [
      "Reactivate Supabase before connecting it.",
      "Reaktiviere Supabase, bevor du es verbindest.",
    ],
    REDIRECT_LIMIT: [
      "Review the sign-in destinations before adding another app.",
      "Prüfe die Anmelde-Ziele, bevor du eine weitere App hinzufügst.",
    ],
  };
  return typeof code === "string" && messages[code]
    ? t(...messages[code])
    : t(
        "The connection could not be saved. Check your settings and retry.",
        "Die Verbindung konnte nicht gespeichert werden. Prüfe die Einstellungen und versuche es erneut.",
      );
}
export function SupabaseConnections(context: Context) {
  const { t, locale } = useI18n();
  const client = useQueryClient();
  const catalog = useQuery({
    queryKey: ["supabase-connections"],
    queryFn: api.supabaseConnections,
    refetchInterval: 5000,
  });
  const instances = useQuery({
    queryKey: ["supabase"],
    queryFn: api.supabaseInstances,
    enabled: !!context.project,
    refetchInterval: 5000,
  });
  const [editing, setEditing] = useState(false),
    [selected, setSelected] = useState("");
  const [urlVariable, setUrlVariable] = useState(""),
    [keyVariable, setKeyVariable] = useState("");
  const [replace, setReplace] = useState(false),
    [notice, setNotice] = useState("");
  const id = context.instance?.id ?? context.project!.id;
  const links =
    catalog.data?.connections.filter((link) =>
      context.instance ? link.instanceId === id : link.projectId === id,
    ) ?? [];
  const projectId = context.project?.id ?? selected;
  const instanceId = context.instance?.id ?? selected;
  const existing = catalog.data?.connections.find(
    (link) => link.projectId === projectId,
  );
  const options = context.instance
    ? catalog.data?.projects.map((project) => ({
        id: project.id,
        name: project.name,
      }))
    : instances.data?.instances
        .filter((instance) => instance.status !== "archived")
        .map((instance) => ({ id: instance.id, name: instance.name }));
  function refresh() {
    void client.invalidateQueries({ queryKey: ["supabase-connections"] });
    void client.invalidateQueries({ queryKey: ["supabase"] });
    void client.invalidateQueries({ queryKey: ["project"] });
    void client.invalidateQueries({ queryKey: ["projects"] });
  }
  const connect = useMutation({
    mutationFn: (input: {
      instanceId: string;
      connection: SupabaseConnectionInput;
    }) => api.connectSupabase(input.instanceId, input.connection),
    onSuccess: () => {
      setEditing(false);
      setReplace(false);
      setNotice(
        t(
          "Connection saved. The status below shows the next step.",
          "Verbindung gespeichert. Der Status unten zeigt den nächsten Schritt.",
        ),
      );
      refresh();
    },
  });
  const disconnect = useMutation({
    mutationFn: (link: SupabaseConnection) =>
      api.disconnectSupabase(link.instanceId, link.projectId),
    onSuccess: (result) => {
      setNotice(
        result.environmentRetained
          ? t(
              "Link removed. Modified app variables were kept.",
              "Zuordnung entfernt. Geänderte App-Variablen wurden beibehalten.",
            )
          : t(
              "Link and managed variables removed. Redeploy the app to apply this.",
              "Zuordnung und verwaltete Variablen entfernt. Stelle die App erneut bereit, um das zu übernehmen.",
            ),
      );
      refresh();
    },
  });
  const deploy = useMutation({
    mutationFn: (projectId: string) => api.deployProject(projectId),
    onSuccess: () => {
      setNotice(t("App deployment queued.", "App-Deployment eingereiht."));
      refresh();
    },
  });
  const check = useMutation({
    mutationFn: (link: SupabaseConnection) =>
      api.supabaseCheckConnection(link.instanceId, link.projectId),
    onSuccess: () => {
      setNotice(
        t(
          "Connection test queued. The result will appear here.",
          "Verbindungstest gestartet. Das Ergebnis erscheint hier.",
        ),
      );
      refresh();
    },
  });
  const busy =
    connect.isPending ||
    disconnect.isPending ||
    deploy.isPending ||
    check.isPending;
  function select(value: string) {
    setSelected(value);
    setReplace(false);
    connect.reset();
    const appId = context.project?.id ?? value;
    const previous = catalog.data?.connections.find(
      (link) => link.projectId === appId,
    );
    const defaults = catalog.data?.projects.find(
      (project) => project.id === appId,
    );
    setUrlVariable(previous?.urlVariable ?? defaults?.urlVariable ?? "");
    setKeyVariable(previous?.keyVariable ?? defaults?.keyVariable ?? "");
  }
  function edit(link?: SupabaseConnection) {
    setEditing(true);
    select(link ? (context.instance ? link.projectId : link.instanceId) : "");
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    connect.mutate({
      instanceId,
      connection: {
        projectId,
        ...(urlVariable ? { urlVariable } : {}),
        ...(keyVariable ? { keyVariable } : {}),
        replace,
      },
    });
  }
  const labels: Record<SupabaseConnection["status"], string> = {
    pending: t("Preparing connection", "Verbindung wird vorbereitet"),
    error: t("Needs review", "Prüfung erforderlich"),
    needs_update: t("Update needed", "Aktualisierung nötig"),
    redeploy_required: t("Redeploy app", "App neu bereitstellen"),
    ready: t("Variables up to date", "Variablen aktuell"),
    unavailable: t("Supabase paused", "Supabase pausiert"),
  };
  return (
    <section
      className="flex flex-col gap-4"
      aria-label={t("App connections", "App-Verbindungen")}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold">
            {context.instance
              ? t("Connected apps", "Verbundene Apps")
              : "Supabase"}
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {t(
              "Connect, deploy and check — with a clear next step.",
              "Verbinden, bereitstellen und prüfen — mit einem klaren nächsten Schritt.",
            )}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || catalog.isPending}
          onClick={() => edit()}
        >
          <Plus data-icon="inline-start" />
          {context.instance
            ? t("Connect app", "App verbinden")
            : links.length
              ? t("Change connection", "Verbindung ändern")
              : t("Connect Supabase", "Supabase verbinden")}
        </Button>
      </div>
      {catalog.isError ? (
        <Alert variant="destructive">
          <AlertDescription>
            {t(
              "Connections could not be loaded.",
              "Verbindungen konnten nicht geladen werden.",
            )}{" "}
            <Button variant="link" onClick={() => catalog.refetch()}>
              {t("Retry", "Erneut versuchen")}
            </Button>
          </AlertDescription>
        </Alert>
      ) : catalog.isPending ? (
        <p role="status">
          <Spinner />
        </p>
      ) : !links.length ? (
        <p className="text-sm text-muted-foreground">
          {t("No app connection yet.", "Noch keine App-Verbindung.")}
        </p>
      ) : (
        links.map((link) => (
          <div
            key={link.projectId}
            className="flex flex-col gap-3 rounded-lg border p-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Link
                className="font-medium underline-offset-4 hover:underline"
                to={
                  context.instance
                    ? `/projects/${link.projectId}`
                    : `/services/${link.instanceId}?tab=apps`
                }
              >
                {context.instance ? link.projectName : link.instanceName}
              </Link>
              <Badge variant={link.status === "ready" && link.verification?.ok ? "secondary" : "outline"}>
                {link.status === "ready" && link.verification?.ok
                  ? t("Connection tested", "Verbindung getestet")
                  : labels[link.status]}
              </Badge>
            </div>
            <ol
              className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted-foreground"
              aria-label={t("Connection progress", "Verbindungsfortschritt")}
            >
              {[
                [
                  t("Settings saved", "Einstellungen gespeichert"),
                  !["pending", "error", "needs_update"].includes(link.status),
                ],
                [
                  t("App deployed", "App bereitgestellt"),
                  link.status === "ready",
                ],
                [
                  t("Connection tested", "Verbindung getestet"),
                  link.status === "ready" && Boolean(link.verification?.ok),
                ],
              ].map(([label, done]) => (
                <li key={String(label)} className="flex items-center gap-1.5">
                  {done ? (
                    <CheckCircle2 className="size-3.5 text-success" />
                  ) : (
                    <Circle className="size-3.5" />
                  )}
                  {label}
                </li>
              ))}
            </ol>
            <Collapsible>
              <CollapsibleTrigger asChild><Button variant="ghost" size="sm"><ChevronDown data-icon="inline-start" />{t("Connection details", "Verbindungsdetails")}</Button></CollapsibleTrigger>
              <CollapsibleContent><dl className="grid gap-2 p-3 text-xs"><div><dt className="text-muted-foreground">{t("App address", "App-Adresse")}</dt><dd className="break-all">{link.apiUrl}</dd></div><div><dt className="text-muted-foreground">{t("Configuration variables", "Konfigurationsvariablen")}</dt><dd>{link.urlVariable} · {link.keyVariable}</dd></div></dl></CollapsibleContent>
            </Collapsible>
            {link.status === "pending" && (
              <p className="text-sm text-muted-foreground">
                {t(
                  "Settings are applied when Supabase and the app are ready. Running deployments are allowed to finish.",
                  "Die Einstellungen werden übernommen, sobald Supabase und App bereit sind. Laufende Deployments werden abgewartet.",
                )}
              </p>
            )}
            {link.status === "redeploy_required" && (
              <p className="text-sm text-muted-foreground">
                {t(
                  "Your connection is prepared. Update the app once to start using this database.",
                  "Die Verbindung ist vorbereitet. Aktualisiere die App einmal, damit sie diese Datenbank nutzen kann.",
                )}
              </p>
            )}
            {link.status === "ready" && (
              <p className="text-sm text-muted-foreground">
                {t(
                  "Test whether Supabase is reachable from the app’s network. Your application code must use the saved variables.",
                  "Prüfe, ob Supabase aus dem Netzwerk der App erreichbar ist. Dein Anwendungscode muss die gespeicherten Variablen verwenden.",
                )}
              </p>
            )}
            {(link.status === "error" || link.status === "needs_update") && (
              <p className="text-sm text-muted-foreground">
                {link.errorCode === "KEYS_CHANGED"
                  ? t(
                      "Supabase keys changed. Update the app’s connection variables.",
                      "Die Supabase-Schlüssel wurden geändert. Aktualisiere die Verbindungsvariablen der App.",
                    )
                  : t(
                      "Review the connection. Existing app values are preserved until you confirm replacement.",
                      "Prüfe die Verbindung. Bestehende App-Werte bleiben bis zur bestätigten Ersetzung erhalten.",
                    )}
              </p>
            )}
            {link.verification && (
              <p className="text-sm" role="status">
                {link.verification.ok
                  ? t(
                      "Supabase was reached from the app’s network.",
                      "Supabase wurde aus dem Netzwerk der App erreicht.",
                    )
                  : t(
                      "Supabase could not be reached from the app’s network. Check routing and retry.",
                      "Supabase konnte aus dem Netzwerk der App nicht erreicht werden. Prüfe das Routing und versuche es erneut.",
                    )}{" "}
                <span className="text-xs text-muted-foreground">
                  {new Date(link.verification.checkedAt).toLocaleString(locale)}
                </span>
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              {link.status === "ready" && (
                <Button
                  variant={link.verification?.ok ? "outline" : "default"}
                  size="sm"
                  disabled={
                    busy ||
                    context.instance?.jobs.some((job) =>
                      ["queued", "running"].includes(job.status),
                    )
                  }
                  onClick={() => check.mutate(link)}
                >
                  <ShieldCheck data-icon="inline-start" />
                  {t("Test connection", "Verbindung testen")}
                </Button>
              )}
              {link.status === "redeploy_required" && (
                <AlertDialog>
                  <AlertDialogTrigger asChild><Button size="sm" disabled={busy || catalog.data?.projects.find(project => project.id === link.projectId)?.busy}>{t("Update app", "App aktualisieren")}</Button></AlertDialogTrigger>
                  <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{t("Use Supabase in this app?", "Supabase in dieser App verwenden?")}</AlertDialogTitle><AlertDialogDescription>{t("The app will be built with the saved Supabase address and public key. Its current version stays online until the new deployment passes its health check.", "Die App wird mit der gespeicherten Supabase-Adresse und dem öffentlichen Schlüssel gebaut. Ihre aktuelle Version bleibt bis zum erfolgreichen Gesundheitstest der neuen Version online.")}</AlertDialogDescription></AlertDialogHeader><p className="text-sm font-medium">{link.projectName} → {link.instanceName}</p><AlertDialogFooter><AlertDialogCancel>{t("Cancel", "Abbrechen")}</AlertDialogCancel><AlertDialogAction onClick={() => deploy.mutate(link.projectId)}>{t("Update app", "App aktualisieren")}</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
                </AlertDialog>
              )}
              {(link.status === "error" || link.status === "needs_update") && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => edit(link)}
                >
                  {t("Review settings", "Einstellungen prüfen")}
                </Button>
              )}
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="ghost" size="sm" disabled={busy}>
                    <Unplug data-icon="inline-start" />
                    {t("Disconnect", "Trennen")}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      {t("Disconnect this app?", "Diese App trennen?")}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {t(
                        "Unchanged managed variables are removed. Values you edited are kept. The app needs another deployment to use the change. Supabase data is retained.",
                        "Unveränderte verwaltete Variablen werden entfernt. Selbst geänderte Werte bleiben erhalten. Die App benötigt ein neues Deployment, um die Änderung zu nutzen. Supabase-Daten bleiben erhalten.",
                      )}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>
                      {t("Cancel", "Abbrechen")}
                    </AlertDialogCancel>
                    <AlertDialogAction onClick={() => disconnect.mutate(link)}>
                      {t("Disconnect", "Trennen")}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>
        ))
      )}
      {editing && (
        <form
          onSubmit={submit}
          className="flex flex-col gap-4 rounded-lg border p-4"
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={`${id}-connect-choice`}>
                {context.instance
                  ? t("App", "App")
                  : t("Supabase instance", "Supabase-Instanz")}
              </FieldLabel>
              <NativeSelect
                id={`${id}-connect-choice`}
                value={selected}
                onChange={(event) => select(event.target.value)}
                required
                disabled={busy}
              >
                <NativeSelectOption value="">
                  {t("Choose…", "Auswählen…")}
                </NativeSelectOption>
                {options?.map((option) => (
                  <NativeSelectOption value={option.id} key={option.id}>
                    {option.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <FieldDescription>
                {t(
                  "The public API address and public key are prepared for your app. No administrator key is copied.",
                  "Die öffentliche API-Adresse und der öffentliche Schlüssel werden für deine App vorbereitet. Kein Administratorschlüssel wird kopiert.",
                )}
              </FieldDescription>
            </Field>
            <Collapsible>
              <CollapsibleTrigger asChild>
                <Button type="button" variant="ghost" size="sm">
                  <ChevronDown data-icon="inline-start" />
                  {t("Variable names", "Variablennamen")}
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="pt-3">
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor={`${id}-connect-url`}>
                      {t("URL variable", "URL-Variable")}
                    </FieldLabel>
                    <Input
                      id={`${id}-connect-url`}
                      value={urlVariable}
                      onChange={(event) => setUrlVariable(event.target.value)}
                      disabled={busy || !!existing}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor={`${id}-connect-key`}>
                      {t(
                        "Public key variable",
                        "Variable für öffentlichen Schlüssel",
                      )}
                    </FieldLabel>
                    <Input
                      id={`${id}-connect-key`}
                      value={keyVariable}
                      onChange={(event) => setKeyVariable(event.target.value)}
                      disabled={busy || !!existing}
                    />
                  </Field>
                </FieldGroup>
              </CollapsibleContent>
            </Collapsible>
            {existing && <Field orientation="horizontal">
              <Checkbox
                id={`${id}-connect-replace`}
                checked={replace}
                onCheckedChange={(value) => setReplace(value === true)}
                disabled={busy}
              />
              <FieldLabel htmlFor={`${id}-connect-replace`}>
                {t(
                  "Replace existing Supabase settings",
                  "Vorhandene Supabase-Einstellungen ersetzen",
                )}
              </FieldLabel>
            </Field>}
          </FieldGroup>
          <div className="flex gap-2">
            <Button disabled={busy || !selected}>
              {connect.isPending ? (
                <Spinner />
              ) : (
                <Link2 data-icon="inline-start" />
              )}
              {t("Save connection", "Verbindung speichern")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => setEditing(false)}
            >
              {t("Cancel", "Abbrechen")}
            </Button>
          </div>
        </form>
      )}
      {(connect.error || disconnect.error || deploy.error || check.error) && (
        <Alert variant="destructive">
          <AlertDescription>
            {message(
              connect.error || disconnect.error || deploy.error || check.error,
              t,
            )}
          </AlertDescription>
        </Alert>
      )}
      {notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      )}
    </section>
  );
}
