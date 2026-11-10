import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Play } from "lucide-react";
import { api } from "@/api/client";
import type {
  SupabaseInstance,
  SupabaseInvocation,
} from "@/api/supabase-types";
import { useI18n } from "@/i18n";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import {
  supabaseErrorMessage,
  supabaseOperationError,
} from "@/lib/supabase-errors";
export function SupabaseFunctionConsole({
  instance,
  name,
  busy,
}: {
  instance: SupabaseInstance;
  name: string;
  busy: boolean;
}) {
  const { t } = useI18n(),
    client = useQueryClient();
  const [method, setMethod] = useState("POST"),
    [body, setBody] = useState("{}"),
    [query, setQuery] = useState(""),
    [auth, setAuth] = useState<"anon" | "none">("anon"),
    [jobId, setJobId] = useState<string | null>(null),
    [validation, setValidation] = useState<string | null>(null);
  const job = instance.jobs.find((j) => j.id === jobId);
  const result = useQuery({
    queryKey: ["supabase-invocation", instance.id, jobId],
    queryFn: () =>
      api.supabaseOperationResult<SupabaseInvocation>(instance.id, jobId!),
    enabled: job?.status === "ready",
    gcTime: 0,
  });
  const invoke = useMutation({
    mutationFn: () =>
      api.supabaseInvokeFunction(instance.id, name, {
        method,
        query,
        auth,
        ...(method === "GET" ? {} : { body }),
      }),
    onSuccess: (result) => {
      setJobId(result.jobId);
      void client.invalidateQueries({ queryKey: ["supabase"] });
    },
  });
  const response = result.data?.result;
  return (
    <div className="flex flex-col gap-4">
      <FieldGroup className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="invoke-method">
            {t("Method", "Methode")}
          </FieldLabel>
          <NativeSelect
            id="invoke-method"
            value={method}
            onChange={(e) => setMethod(e.target.value)}
          >
            {["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => (
              <NativeSelectOption key={m}>{m}</NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        <Field>
          <FieldLabel htmlFor="invoke-auth">
            {t("Authentication", "Authentifizierung")}
          </FieldLabel>
          <NativeSelect
            id="invoke-auth"
            value={auth}
            onChange={(e) => setAuth(e.target.value as "anon" | "none")}
          >
            <NativeSelectOption value="anon">
              {t("Public app key", "Öffentlicher App-Schlüssel")}
            </NativeSelectOption>
            <NativeSelectOption value="none">
              {t(
                "Without a token · rejection test",
                "Ohne Token · Ablehnung testen",
              )}
            </NativeSelectOption>
          </NativeSelect>
        </Field>
        <Field className="sm:col-span-2">
          <FieldLabel htmlFor="invoke-query">
            {t("Query parameters", "URL-Parameter")}
          </FieldLabel>
          <Input
            id="invoke-query"
            value={query}
            maxLength={2048}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="name=world"
          />
        </Field>
        {method !== "GET" && (
          <Field className="sm:col-span-2">
            <FieldLabel htmlFor="invoke-body">JSON</FieldLabel>
            <Textarea
              id="invoke-body"
              className="min-h-28 font-mono"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              maxLength={65536}
            />
          </Field>
        )}
      </FieldGroup>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {t(
            "Calls the active version. Requests may change your app’s data.",
            "Ruft die aktive Version auf. Anfragen können Daten deiner App verändern.",
          )}
        </p>
        <Button
          disabled={busy || invoke.isPending || instance.status !== "running"}
          onClick={() => {
            setValidation(null);
            if (method !== "GET" && body) {
              try {
                JSON.parse(body);
              } catch {
                setValidation(t("Enter valid JSON.", "Gib gültiges JSON ein."));
                return;
              }
            }
            invoke.mutate();
          }}
        >
          {invoke.isPending ||
          ["queued", "running"].includes(job?.status ?? "") ? (
            <Spinner />
          ) : (
            <Play data-icon="inline-start" />
          )}
          {t("Send request", "Anfrage senden")}
        </Button>
      </div>
      {(validation || invoke.error || job?.status === "failed") && (
        <Alert variant="destructive">
          <AlertDescription>
            {validation ??
              (invoke.error
                ? supabaseErrorMessage(invoke.error, t)
                : supabaseOperationError(job?.error ?? null, t))}
          </AlertDescription>
        </Alert>
      )}
      {response && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <Badge
              variant={response.status >= 400 ? "destructive" : "secondary"}
            >
              HTTP {response.status}
            </Badge>
            <span className="text-xs text-muted-foreground">
              {response.durationMs} ms
            </span>
          </div>
          <pre className="max-h-80 overflow-auto rounded-lg border bg-muted/30 p-4 text-xs whitespace-pre-wrap break-words">
            {(() => {
              try {
                return JSON.stringify(JSON.parse(response.body), null, 2);
              } catch {
                return response.body || t("Empty response", "Leere Antwort");
              }
            })()}
          </pre>
          {response.logs && (
            <details>
              <summary className="cursor-pointer text-sm font-medium">
                {t(
                  "Runtime log during this request",
                  "Laufzeitprotokoll während dieser Anfrage",
                )}
              </summary>
              <p className="mt-2 text-xs text-muted-foreground">
                {t(
                  "Includes concurrent requests to this instance.",
                  "Enthält auch gleichzeitige Anfragen an diese Instanz.",
                )}
              </p>
              <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-muted/30 p-4 text-xs">
                {response.logs}
              </pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
