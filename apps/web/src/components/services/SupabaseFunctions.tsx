import {
  Component,
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Braces,
  Check,
  Code2,
  Copy,
  Download,
  Expand,
  FileCode2,
  GitCompareArrows,
  History,
  Minimize,
  Plus,
  RefreshCw,
  Rocket,
  RotateCcw,
  Trash2,
  Upload,
} from "lucide-react";
import { api } from "@/api/client";
import type {
  SupabaseFunctionDetail,
  SupabaseInstance,
} from "@/api/supabase-types";
import type { CodeEditorHandle } from "@/components/editor/FunctionCodeEditor";
import { NavigationGuard } from "@/components/NavigationGuard";
import { SupabaseFunctionConsole } from "./SupabaseFunctionConsole";
import { operationPhase } from "./SupabaseActivity";
import { useI18n } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel, FieldDescription } from "@/components/ui/field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
  EmptyMedia,
  EmptyContent,
} from "@/components/ui/empty";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import {
  supabaseErrorMessage,
  supabaseOperationError,
} from "@/lib/supabase-errors";
import { cn } from "@/lib/utils";
import {
  MAX_FUNCTION_SOURCE_BYTES,
  changedFunctionDraft,
  functionDownloadName,
  functionSourceBytes,
  importedFunctionName,
  validFunctionName,
  type FunctionDraft,
} from "@/utils/function-editor";

const CodeEditor = lazy(() => import("@/components/editor/FunctionCodeEditor"));
const DiffEditor = lazy(() =>
  import("@/components/editor/FunctionCodeEditor").then((m) => ({
    default: m.FunctionDiff,
  })),
);
class EditorLoadBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
const initial: FunctionDraft = {
  name: "hello",
  source:
    'Deno.serve(async (request: Request) => {\n  const name = new URL(request.url).searchParams.get("name") ?? "world";\n\n  return Response.json({ message: `Hello, ${name}!` });\n});\n',
};
export function SupabaseFunctions({
  instance,
  busy,
  active = true,
}: {
  instance: SupabaseInstance;
  busy: boolean;
  active?: boolean;
}) {
  const { t, locale } = useI18n(),
    client = useQueryClient();
  const [draft, setDraft] = useState<FunctionDraft>(initial),
    [saved, setSaved] = useState<FunctionDraft>(initial);
  const [detail, setDetail] = useState<SupabaseFunctionDetail | null>(null),
    [opened, setOpened] = useState(false),
    [loading, setLoading] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null),
    [jobKind, setJobKind] = useState<"deploy" | "delete" | null>(null);
  const [checking, setChecking] = useState(false),
    [formatting, setFormatting] = useState(false),
    [editorReady, setEditorReady] = useState(false),
    [full, setFull] = useState(false),
    [copied, setCopied] = useState(false),
    [diff, setDiff] = useState(false);
  const [error, setError] = useState<string | null>(null),
    [dialog, setDialog] = useState<"discard" | "delete" | null>(null);
  const [problems, setProblems] = useState({ errors: 0, warnings: 0 }),
    [cursor, setCursor] = useState({ line: 1, column: 1 });
  const pendingAction = useRef<(() => void) | null>(null),
    editor = useRef<CodeEditorHandle | null>(null),
    action = useRef(() => {}),
    workspace = useRef<HTMLDivElement>(null),
    fileInput = useRef<HTMLInputElement>(null),
    refreshed = useRef(false),
    handledJob = useRef<string | null>(null);
  const dirty = changedFunctionDraft(draft, saved),
    bytes = useMemo(() => functionSourceBytes(draft.source), [draft.source]),
    nameValid = validFunctionName(draft.name),
    job = instance.jobs.find((j) => j.id === jobId);
  const catalog = useQuery({
    queryKey: ["supabase-functions", instance.id],
    queryFn: () => api.supabaseFunctionCatalog(instance.id),
    enabled: active,
    refetchOnWindowFocus: false,
  });
  const refresh = useMutation({
    mutationFn: () => api.supabaseRefreshFunctions(instance.id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["supabase"] });
    },
    onError: (e) => setError(supabaseErrorMessage(e, t)),
  });
  const save = useMutation({
    mutationFn: (input: {
      name: string;
      source: string;
      expectedHash: string | null;
    }) => api.supabaseFunctions(instance.id, input),
    onSuccess: ({ jobId }) => {
      setJobId(jobId);
      setJobKind("deploy");
      void client.invalidateQueries({ queryKey: ["supabase"] });
    },
    onError: (e) => setError(supabaseErrorMessage(e, t)),
  });
  const remove = useMutation({
    mutationFn: () =>
      api.supabaseDeleteFunction(instance.id, draft.name, detail!.hash!),
    onSuccess: ({ jobId }) => {
      setJobId(jobId);
      setJobKind("delete");
      void client.invalidateQueries({ queryKey: ["supabase"] });
    },
    onError: (e) => setError(supabaseErrorMessage(e, t)),
  });
  const locked =
    busy ||
    save.isPending ||
    remove.isPending ||
    checking ||
    loading ||
    instance.status !== "running";
  useEffect(() => {
    if (
      active &&
      instance.status === "running" &&
      !busy &&
      !refreshed.current
    ) {
      refreshed.current = true;
      refresh.mutate();
    }
  }, [active, busy, instance.status]);
  const lastSync = instance.jobs.find(
    (j) => j.operation?.kind === "functions-sync",
  );
  useEffect(() => {
    if (lastSync?.status === "ready")
      void client.invalidateQueries({
        queryKey: ["supabase-functions", instance.id],
      });
  }, [lastSync?.id, lastSync?.status, client, instance.id]);
  useEffect(() => {
    if (
      !jobId ||
      handledJob.current === jobId ||
      !["ready", "failed"].includes(job?.status ?? "")
    )
      return;
    handledJob.current = jobId;
    void client.invalidateQueries({
      queryKey: ["supabase-functions", instance.id],
    });
    if (job?.status === "ready") {
      if (jobKind === "delete") {
        setOpened(false);
        setDetail(null);
        setDraft(initial);
        setSaved(initial);
      } else void load(draft.name);
    } else setError(supabaseOperationError(job?.error ?? null, t));
  }, [jobId, job?.status]);
  useEffect(() => {
    if (!dirty) return;
    const guard = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);
  useEffect(() => {
    const change = () =>
      setFull(document.fullscreenElement === workspace.current);
    document.addEventListener("fullscreenchange", change);
    return () => document.removeEventListener("fullscreenchange", change);
  }, []);
  async function load(name: string, versionId?: string) {
    setLoading(true);
    setError(null);
    setDiff(false);
    try {
      const next = await api.supabaseFunction(instance.id, name);
      const selected = versionId
        ? await api.supabaseFunction(instance.id, name, versionId)
        : next;
      if (next.source === null && !versionId) throw new Error("missing");
      setDetail(next);
      setDraft({ name, source: selected.source ?? "" });
      setSaved({ name, source: next.source ?? "" });
      setOpened(true);
    } catch (e) {
      setError(supabaseErrorMessage(e, t));
    } finally {
      setLoading(false);
    }
  }
  async function guard(next: () => void) {
    if (document.fullscreenElement === workspace.current)
      await document.exitFullscreen();
    if (dirty) {
      pendingAction.current = next;
      setDialog("discard");
    } else next();
  }
  function create() {
    let name = initial.name;
    let suffix = 2;
    const used = new Set(catalog.data?.functions.map((fn) => fn.name));
    while (used.has(name)) name = `${initial.name}-${suffix++}`;
    const next = { ...initial, name };
    setDetail(null);
    setDraft(next);
    setSaved(next);
    setOpened(true);
    setDiff(false);
    setError(null);
  }
  async function deploy() {
    if (
      locked ||
      !editor.current ||
      !nameValid ||
      !draft.source.trim() ||
      bytes > MAX_FUNCTION_SOURCE_BYTES
    )
      return;
    setChecking(true);
    setError(null);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const errors = await Promise.race([
        editor.current.validateSyntax(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(Error()), 15000);
        }),
      ]);
      if (errors) {
        setError(
          t(
            "Fix the TypeScript syntax errors before deploying.",
            "Behebe die TypeScript-Syntaxfehler vor der Bereitstellung.",
          ),
        );
        editor.current.focusProblem();
        return;
      }
      setJobId(null);
      save.mutate({ ...draft, expectedHash: detail?.hash ?? null });
    } catch {
      setError(
        t(
          "The editor check could not finish. Try again.",
          "Die Editor-Prüfung konnte nicht abgeschlossen werden. Versuche es erneut.",
        ),
      );
    } finally {
      if (timer) clearTimeout(timer);
      setChecking(false);
    }
  }
  action.current = () => {
    void deploy();
  };
  async function importFile(file: File) {
    if (!/\.ts$/i.test(file.name) || file.size > MAX_FUNCTION_SOURCE_BYTES) {
      setError(
        t(
          "Choose a TypeScript file up to 256 KiB.",
          "Wähle eine TypeScript-Datei bis 256 KiB.",
        ),
      );
      return;
    }
    try {
      const source = await file.text();
      if (functionSourceBytes(source) > MAX_FUNCTION_SOURCE_BYTES)
        throw Error();
      void guard(() => {
        setDraft({
          name: detail
            ? draft.name
            : importedFunctionName(file.name, draft.name),
          source,
        });
        setOpened(true);
      });
    } catch {
      setError(
        t("Could not read this file.", "Datei konnte nicht gelesen werden."),
      );
    }
  }
  function download() {
    const url = URL.createObjectURL(
      new Blob([draft.source], { type: "text/typescript;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = functionDownloadName(draft.name);
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function fullscreen() {
    try {
      if (document.fullscreenElement === workspace.current)
        await document.exitFullscreen();
      else await workspace.current?.requestFullscreen();
    } catch {
      setError(
        t("Fullscreen is unavailable.", "Vollbild ist nicht verfügbar."),
      );
    }
  }
  async function format() {
    setFormatting(true);
    try {
      await editor.current?.format();
    } catch {
      setError(t("Formatting failed.", "Formatieren fehlgeschlagen."));
    } finally {
      setFormatting(false);
    }
  }
  const url = `${instance.apiUrl}/functions/v1/${draft.name}`;
  return (
    <>
      {dirty && (
        <NavigationGuard
          when
          title={t(
            "Discard your function draft?",
            "Funktionsentwurf verwerfen?",
          )}
          description={t(
            "Your changes have not been deployed. Keep editing or download your draft.",
            "Deine Änderungen sind noch nicht bereitgestellt. Bearbeite weiter oder lade deinen Entwurf herunter.",
          )}
        />
      )}
      <div
        ref={workspace}
        className="flex flex-col gap-5 bg-card [&:fullscreen]:overflow-auto [&:fullscreen]:p-6"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold">Edge Functions</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {t(
                "Build, test and ship endpoints for your app.",
                "Endpunkte für deine App entwickeln, testen und bereitstellen.",
              )}
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={
                busy || refresh.isPending || instance.status !== "running"
              }
              onClick={() => refresh.mutate()}
            >
              <RefreshCw data-icon="inline-start" />
              {t("Refresh", "Aktualisieren")}
            </Button>
            <Button
              size="sm"
              disabled={locked}
              onClick={() => void guard(create)}
            >
              <Plus data-icon="inline-start" />
              {t("New function", "Neue Funktion")}
            </Button>
          </div>
        </div>
        {(error || lastSync?.status === "failed") && (
          <Alert variant="destructive">
            <AlertDescription>
              {error ?? supabaseOperationError(lastSync?.error ?? null, t)}
            </AlertDescription>
          </Alert>
        )}
        <div className="grid min-w-0 gap-5 lg:grid-cols-[210px_minmax(0,1fr)]">
          <aside
            className="flex min-w-0 flex-col gap-2 lg:border-r lg:pr-5"
            aria-label={t("Functions", "Funktionen")}
          >
            {catalog.isPending ? (
              <Skeleton className="h-20" />
            ) : catalog.isError ? (
              <Button variant="outline" onClick={() => catalog.refetch()}>
                {t("Retry loading functions", "Funktionen erneut laden")}
              </Button>
            ) : catalog.data?.functions.length ? (
              catalog.data.functions.map((fn) => (
                <Button
                  key={fn.name}
                  variant={detail?.name === fn.name ? "secondary" : "ghost"}
                  className="justify-start"
                  disabled={locked}
                  onClick={() =>
                    void guard(() => {
                      void load(fn.name);
                    })
                  }
                >
                  <FileCode2 data-icon="inline-start" />
                  <span className="truncate">{fn.name}</span>
                </Button>
              ))
            ) : (
              <p className="py-3 text-sm text-muted-foreground">
                {lastSync?.status === "running"
                  ? t("Reading server files…", "Serverdateien werden gelesen…")
                  : t("No functions yet.", "Noch keine Funktionen.")}
              </p>
            )}
            {!!catalog.data?.removed?.length && (
              <>
                <Separator />
                <p className="text-xs text-muted-foreground">
                  {t("Removed · recoverable", "Entfernt · wiederherstellbar")}
                </p>
                {catalog.data.removed.map((fn) => (
                  <Button
                    key={fn.name}
                    variant="ghost"
                    size="sm"
                    disabled={locked}
                    className="justify-start"
                    onClick={() =>
                      void guard(() => {
                        void load(fn.name, fn.versionId);
                      })
                    }
                  >
                    <History data-icon="inline-start" />
                    {fn.name}
                  </Button>
                ))}
              </>
            )}
            {catalog.data?.syncedAt && (
              <p className="mt-2 text-xs text-muted-foreground">
                {t("Server checked", "Server geprüft")}{" "}
                {new Date(catalog.data.syncedAt).toLocaleTimeString(locale)}
              </p>
            )}
          </aside>
          <div className="flex min-w-0 flex-col gap-4">
            {!opened ? (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Code2 />
                  </EmptyMedia>
                  <EmptyTitle>
                    {t(
                      "Your app’s server-side logic",
                      "Die Serverlogik deiner App",
                    )}
                  </EmptyTitle>
                  <EmptyDescription>
                    {t(
                      "Open a function from the list or create your first endpoint. Every deployment keeps a recoverable version.",
                      "Öffne eine Funktion aus der Liste oder erstelle deinen ersten Endpunkt. Jede Bereitstellung erhält eine wiederherstellbare Version.",
                    )}
                  </EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <Button disabled={locked} onClick={create}>
                    <Plus data-icon="inline-start" />
                    {t("Create function", "Funktion erstellen")}
                  </Button>
                </EmptyContent>
              </Empty>
            ) : (
              <>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <FileCode2 className="size-4 text-muted-foreground" />
                    <h3 className="truncate font-mono text-sm">
                      {draft.name}/index.ts
                    </h3>
                    <Badge variant={dirty ? "secondary" : "outline"}>
                      {dirty
                        ? t(
                            "Unpublished changes",
                            "Nicht bereitgestellte Änderungen",
                          )
                        : detail
                          ? t("Active version", "Aktive Version")
                          : t("Draft", "Entwurf")}
                    </Badge>
                  </div>
                  <div className="flex gap-1">
                    <input
                      type="file"
                      accept=".ts"
                      className="hidden"
                      ref={fileInput}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) void importFile(file);
                        e.target.value = "";
                      }}
                    />
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      disabled={locked}
                      onClick={() => fileInput.current?.click()}
                      aria-label={t(
                        "Import TypeScript",
                        "TypeScript importieren",
                      )}
                    >
                      <Upload />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={download}
                      aria-label={t("Download code", "Code herunterladen")}
                    >
                      <Download />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => void fullscreen()}
                      aria-label={
                        full
                          ? t("Exit fullscreen", "Vollbild beenden")
                          : t("Fullscreen", "Vollbild")
                      }
                    >
                      {full ? <Minimize /> : <Expand />}
                    </Button>
                  </div>
                </div>
                {!detail && (
                  <Field data-invalid={!nameValid}>
                    <FieldLabel htmlFor="function-name">
                      {t("Function name", "Funktionsname")}
                    </FieldLabel>
                    <Input
                      id="function-name"
                      value={draft.name}
                      maxLength={63}
                      aria-invalid={!nameValid}
                      disabled={locked}
                      onChange={(e) =>
                        setDraft({ ...draft, name: e.target.value })
                      }
                    />
                    {!nameValid && (
                      <FieldDescription>
                        {t(
                          "Use lowercase letters, numbers, hyphens or underscores.",
                          "Verwende Kleinbuchstaben, Zahlen, Bindestriche oder Unterstriche.",
                        )}
                      </FieldDescription>
                    )}
                  </Field>
                )}
                <div className="flex min-w-0 items-center gap-2">
                  <code className="min-w-0 break-all text-xs text-muted-foreground">
                    {url}
                  </code>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled={!nameValid}
                    aria-label={t("Copy endpoint", "Endpunkt kopieren")}
                    onClick={() => {
                      void navigator.clipboard
                        .writeText(url)
                        .then(() => {
                          setCopied(true);
                          setTimeout(() => setCopied(false), 2000);
                        })
                        .catch(() =>
                          setError(
                            t("Copy failed.", "Kopieren fehlgeschlagen."),
                          ),
                        );
                    }}
                  >
                    {copied ? <Check /> : <Copy />}
                  </Button>
                </div>
                <div className="overflow-hidden rounded-xl border">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/30 px-3 py-2">
                    <span className="font-mono text-xs">TypeScript</span>
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={!detail || !dirty || (!editorReady && !diff)}
                        onClick={() => setDiff((v) => !v)}
                      >
                        <GitCompareArrows data-icon="inline-start" />
                        {diff
                          ? t("Editor", "Editor")
                          : t("Compare", "Vergleichen")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={!editorReady || locked || formatting || diff}
                        onClick={() => void format()}
                      >
                        {formatting ? (
                          <Spinner />
                        ) : (
                          <Braces data-icon="inline-start" />
                        )}
                        {t("Format", "Formatieren")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={!dirty || locked}
                        onClick={() =>
                          void guard(() => {
                            setDraft(saved);
                            setDiff(false);
                          })
                        }
                        aria-label={t(
                          "Discard changes",
                          "Änderungen verwerfen",
                        )}
                      >
                        <RotateCcw />
                      </Button>
                    </div>
                  </div>
                  <div
                    className={cn(
                      "relative min-h-[320px]",
                      full ? "h-[65vh]" : "h-[480px] xl:h-[580px]",
                    )}
                  >
                    {loading ? (
                      <Skeleton className="h-full" />
                    ) : (
                      active && (
                        <EditorLoadBoundary
                          fallback={
                            <Alert variant="destructive">
                              <AlertDescription>
                                {t(
                                  "The editor could not load. Download your draft before reloading.",
                                  "Der Editor konnte nicht geladen werden. Lade deinen Entwurf vor dem Neuladen herunter.",
                                )}
                              </AlertDescription>
                            </Alert>
                          }
                        >
                          <Suspense
                            fallback={
                              <div
                                role="status"
                                className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground"
                              >
                                <Spinner />
                                {t("Loading editor…", "Editor wird geladen…")}
                              </div>
                            }
                          >
                            {diff ? (
                              <DiffEditor
                                original={saved.source}
                                modified={draft.source}
                              />
                            ) : (
                              <CodeEditor
                                value={draft.source}
                                readOnly={locked}
                                label={t(
                                  "Function source",
                                  "Funktionsquellcode",
                                )}
                                onChange={(source) =>
                                  setDraft((current) => ({
                                    ...current,
                                    source,
                                  }))
                                }
                                onProblems={(errors, warnings) =>
                                  setProblems({ errors, warnings })
                                }
                                onCursor={(line, column) =>
                                  setCursor({ line, column })
                                }
                                onDeploy={() => action.current()}
                                onReady={(handle) => {
                                  editor.current = handle;
                                  setEditorReady(Boolean(handle));
                                }}
                              />
                            )}
                          </Suspense>
                        </EditorLoadBoundary>
                      )
                    )}
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2 text-xs text-muted-foreground">
                    <button
                      onClick={() => editor.current?.focusProblem()}
                      className="rounded focus-visible:outline focus-visible:outline-ring"
                    >
                      {problems.errors} {t("errors", "Fehler")} ·{" "}
                      {problems.warnings} {t("warnings", "Warnungen")}
                    </button>
                    <span>
                      {cursor.line}:{cursor.column} ·{" "}
                      {(bytes / 1024).toFixed(1)} / 256 KiB
                    </span>
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p role="status" className="text-sm text-muted-foreground">
                    {job && ["queued", "running"].includes(job.status)
                      ? operationPhase(job, t)
                      : t(
                          "Checked before activation. Previous versions stay available.",
                          "Vor der Aktivierung geprüft. Frühere Versionen bleiben verfügbar.",
                        )}
                  </p>
                  <Button
                    disabled={
                      locked ||
                      !editorReady ||
                      diff ||
                      !nameValid ||
                      !draft.source.trim() ||
                      bytes > MAX_FUNCTION_SOURCE_BYTES ||
                      (!dirty && !!detail)
                    }
                    onClick={() => void deploy()}
                  >
                    {checking || save.isPending ? (
                      <Spinner />
                    ) : (
                      <Rocket data-icon="inline-start" />
                    )}
                    {checking
                      ? t("Checking…", "Wird geprüft…")
                      : t("Deploy function", "Funktion bereitstellen")}
                  </Button>
                </div>
                {detail && (
                  <>
                    <Separator />
                    <Tabs defaultValue="test">
                      <TabsList variant="line">
                        <TabsTrigger value="test">
                          {t("Test request", "Testanfrage")}
                        </TabsTrigger>
                        <TabsTrigger value="history">
                          <History data-icon="inline-start" />
                          {t("Versions", "Versionen")}
                        </TabsTrigger>
                      </TabsList>
                      <TabsContent value="test" className="pt-3">
                        <SupabaseFunctionConsole
                          key={detail.name}
                          instance={instance}
                          name={detail.name}
                          busy={busy}
                        />
                      </TabsContent>
                      <TabsContent
                        value="history"
                        className="flex flex-col gap-3 pt-3"
                      >
                        {detail.versions.map((version) => (
                          <div
                            key={version.id}
                            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3"
                          >
                            <div className="flex flex-col gap-1">
                              <span className="text-sm">
                                {new Date(version.createdAt).toLocaleString(locale)}
                                {version.active && (
                                  <Badge variant="secondary" className="ml-2">
                                    {t("Active", "Aktiv")}
                                  </Badge>
                                )}
                              </span>
                              <code className="text-xs text-muted-foreground">
                                {version.hash.slice(0, 12)}
                              </code>
                            </div>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={locked || version.active}
                              onClick={() =>
                                void guard(() => {
                                  void load(detail.name, version.id);
                                })
                              }
                            >
                              <RotateCcw data-icon="inline-start" />
                              {t("Load as draft", "Als Entwurf laden")}
                            </Button>
                          </div>
                        ))}
                        <div className="pt-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={locked || !detail.hash}
                            onClick={() => {
                              void guard(() => setDialog("delete"));
                            }}
                          >
                            <Trash2 data-icon="inline-start" />
                            {t("Remove function", "Funktion entfernen")}
                          </Button>
                        </div>
                      </TabsContent>
                    </Tabs>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      </div>
      <AlertDialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {dialog === "delete"
                ? t("Remove this endpoint?", "Diesen Endpunkt entfernen?")
                : t(
                    "Discard unpublished changes?",
                    "Nicht bereitgestellte Änderungen verwerfen?",
                  )}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {dialog === "delete"
                ? t(
                    "Requests will return 404. Previous versions remain available in Shelter.",
                    "Anfragen erhalten anschließend 404. Frühere Versionen bleiben in Shelter verfügbar.",
                  )
                : t(
                    "Download your draft first if you want to keep these edits.",
                    "Lade deinen Entwurf vorher herunter, wenn du diese Änderungen behalten möchtest.",
                  )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancel", "Abbrechen")}</AlertDialogCancel>
            <Button
              onClick={() => {
                const next = pendingAction.current;
                pendingAction.current = null;
                setDialog(null);
                if (dialog === "delete") remove.mutate();
                else next?.();
              }}
            >
              {dialog === "delete"
                ? t("Remove function", "Funktion entfernen")
                : t("Discard changes", "Änderungen verwerfen")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
