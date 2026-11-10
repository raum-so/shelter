import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  ChevronDown,
  CheckCircle2,
  Database,
  Mail,
  Settings2,
} from "lucide-react";
import { api } from "@/api/client";
import type { SupabaseCreateInput } from "@/api/supabase-types";
import { useI18n } from "@/i18n";
import { suggestSupabaseAddresses } from "@/utils/supabase-setup";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
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
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";

export function SupabaseSetup({
  pending,
  onSubmit,
}: {
  pending: boolean;
  onSubmit: (input: SupabaseCreateInput) => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(""),
    [projectId, setProjectId] = useState("");
  const [domain, setDomain] = useState(""),
    [siteUrl, setSiteUrl] = useState("");
  const [redirects, setRedirects] = useState(""),
    [replace, setReplace] = useState(false);
  const [overrides, setOverrides] = useState<{ api?: string; studio?: string }>(
    {},
  );
  const [mail, setMail] = useState<"global" | "custom" | "disabled">("global");
  const catalog = useQuery({
    queryKey: ["supabase-connections"],
    queryFn: api.supabaseConnections,
  });
  const zones = useQuery({
    queryKey: ["cloudflare-zones"],
    queryFn: ({ signal }) => api.cloudflareZones(signal),
    staleTime: 60_000,
    retry: 1,
  });
  const smtp = useQuery({ queryKey: ["smtp"], queryFn: api.smtp });
  const capacity = useQuery({
    queryKey: ["supabase-readiness"],
    queryFn: api.supabaseReadiness,
    refetchInterval: 15_000,
  });
  const project = catalog.data?.projects.find(
    (option) => option.id === projectId,
  );
  const matchingDomain = zones.data?.find((zone) => {
    try {
      const host = new URL(project?.website ?? "").hostname;
      return host === zone.name || host.endsWith("." + zone.name);
    } catch {
      return false;
    }
  });
  const selectedDomain =
    domain ||
    matchingDomain?.name ||
    (zones.data?.length === 1 ? zones.data[0]!.name : "");
  const suggested = suggestSupabaseAddresses(name, selectedDomain);
  const addresses = {
    api: overrides.api ?? suggested.api,
    studio: overrides.studio ?? suggested.studio,
  };
  const mailBlocked =
    mail === "global" &&
    (smtp.isPending ||
      smtp.isError ||
      (smtp.data?.configuration?.enabled && !smtp.data.verified));
  const missing = [
    name.trim().length < 2 && t("Give your database a name", "Gib deiner Datenbank einen Namen"),
    !selectedDomain && t("Choose a domain", "Wähle eine Domain"),
    !siteUrl.trim() && t("Choose an app or enter its website", "Wähle eine App oder gib ihre Website ein"),
    mailBlocked && t("Check email settings or choose ‘Set up later’", "Prüfe die E-Mail-Einstellungen oder wähle „Später einrichten“"),
  ].filter((item): item is string => Boolean(item));
  const ready =
    name.trim().length >= 2 &&
    addresses.api &&
    addresses.studio &&
    siteUrl.trim() &&
    !mailBlocked &&
    capacity.data?.status !== "blocked";
  const capacityLabels = {
    worker: t(
      "The deployment worker is offline",
      "Der Deployment-Worker ist offline",
    ),
    memory: t("More memory is needed", "Mehr Arbeitsspeicher benötigt"),
    storage: t("More free storage is needed", "Mehr freier Speicher benötigt"),
    cpu: t("More CPU capacity is needed", "Mehr CPU-Kapazität benötigt"),
    docker: t("Docker is not available", "Docker ist nicht verfügbar"),
    network: t("No free network range", "Kein freier Netzwerkbereich"),
    cloudflare: t("Connect Cloudflare first", "Zuerst Cloudflare verbinden"),
  };
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready || pending) return;
    const data = new FormData(event.currentTarget);
    onSubmit({
      name: name.trim(),
      apiHostname: addresses.api.trim(),
      studioHostname: addresses.studio.trim(),
      siteUrl: siteUrl.trim(),
      redirectUrls: redirects
        .split("\n")
        .map((value) => value.trim())
        .filter(Boolean),
      smtpSource: mail,
      ...(projectId ? { connection: { projectId, replace } } : {}),
      ...(mail === "custom"
        ? {
            smtp: {
              host: String(data.get("smtpHost")).trim(),
              port: 465,
              user: String(data.get("smtpUser")).trim(),
              password: String(data.get("smtpPassword")),
              sender: String(data.get("smtpSender")).trim(),
              adminEmail: String(data.get("smtpEmail")).trim(),
            },
          }
        : {}),
    });
  }
  return (
    <form
      onSubmit={submit}
      aria-busy={pending}
      className="grid items-start gap-6 pb-28 xl:grid-cols-[minmax(0,1fr)_20rem] xl:pb-0"
    >
      <fieldset disabled={pending} className="flex min-w-0 flex-col gap-6">
        <Card>
          <CardHeader>
            <CardTitle>
              {t("A database for your app", "Eine Datenbank für deine App")}
            </CardTitle>
            <CardDescription>
              {t(
                "Choose your app. Shelter sets up the database and prepares the connection for you.",
                "Wähle deine App. Shelter richtet die Datenbank ein und bereitet die Verbindung für dich vor.",
              )}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="sb-app">{t("App", "App")}</FieldLabel>
                <NativeSelect
                  id="sb-app"
                  value={projectId}
                  disabled={catalog.isPending}
                  onChange={(event) => {
                    const id = event.target.value,
                      selected = catalog.data?.projects.find(
                        (option) => option.id === id,
                      );
                    setProjectId(id);
                    setReplace(false);
                    if (selected) {
                      if (!name.trim()) setName(selected.name);
                      setSiteUrl(selected.website ?? "");
                    }
                  }}
                >
                  <NativeSelectOption value="">
                    {t("Connect an app later", "App später verbinden")}
                  </NativeSelectOption>
                  {catalog.data?.projects.map((option) => (
                    <NativeSelectOption
                      key={option.id}
                      value={option.id}
                      disabled={catalog.data?.connections.some(
                        (link) => link.projectId === option.id,
                      )}
                    >
                      {option.name}
                      {catalog.data?.connections.some(
                        (link) => link.projectId === option.id,
                      )
                        ? ` · ${t("already connected", "bereits verbunden")}`
                        : ""}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
                {catalog.isError && (
                  <FieldDescription>
                    {t(
                      "Apps could not be loaded. You can connect one later.",
                      "Apps konnten nicht geladen werden. Du kannst später eine verbinden.",
                    )}
                  </FieldDescription>
                )}
              </Field>
              <div className="grid gap-5 sm:grid-cols-2">
                <Field className={zones.data?.length === 1 ? "sm:col-span-2" : undefined}>
                  <FieldLabel htmlFor="sb-name">{t("Database name", "Name der Datenbank")}</FieldLabel>
                  <Input
                    id="sb-name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder={t("My app", "Meine App")}
                    minLength={2}
                    maxLength={80}
                    required
                  />
                </Field>
                {(zones.data?.length !== 1 || zones.isError) && <Field>
                  <FieldLabel htmlFor="sb-domain">
                    {t("Domain", "Domain")}
                  </FieldLabel>
                  <NativeSelect
                    id="sb-domain"
                    value={selectedDomain}
                    disabled={zones.isPending}
                    onChange={(event) => {
                      setDomain(event.target.value);
                      setOverrides({});
                    }}
                  >
                    <NativeSelectOption value="">
                      {zones.isPending
                        ? t("Loading…", "Wird geladen…")
                        : t("Choose a domain", "Domain wählen")}
                    </NativeSelectOption>
                    {zones.data?.map((zone) => (
                      <NativeSelectOption key={zone.id} value={zone.name}>
                        {zone.name}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                  <FieldDescription>{t("Shelter creates the required addresses here automatically.", "Shelter legt hier automatisch die benötigten Adressen an.")}</FieldDescription>
                  {(zones.isError || zones.data?.length === 0) && (
                    <FieldDescription>
                      <Link to="/settings/cloudflare">
                        {t("Connect a domain", "Domain verbinden")}
                      </Link>
                      {" · "}
                      <Button
                        type="button"
                        variant="link"
                        size="sm"
                        onClick={() => zones.refetch()}
                      >
                        {t("Retry", "Erneut versuchen")}
                      </Button>
                    </FieldDescription>
                  )}
                </Field>}
              </div>
              {(!project?.website || !siteUrl) && (
                <Field>
                  <FieldLabel htmlFor="sb-site">
                    {t("Your app’s website", "Website deiner App")}
                  </FieldLabel>
                  <Input
                    id="sb-site"
                    type="url"
                    value={siteUrl}
                    onChange={(event) => setSiteUrl(event.target.value)}
                    placeholder="https://app.example.com"
                    maxLength={2048}
                    required
                  />
                  <FieldDescription>
                    {t(
                      "Where people return after signing in or resetting their password.",
                      "Dorthin kehren Nutzer nach Anmeldung oder Passwort-Reset zurück.",
                    )}
                  </FieldDescription>
                </Field>
              )}
              {project?.website && siteUrl && (
                <p className="flex items-center gap-2 break-all text-sm text-muted-foreground">
                  <CheckCircle2
                    className="size-4 shrink-0 text-success"
                    aria-hidden="true"
                  />
                  {t("Sign-in returns to", "Anmeldung führt zurück zu")}{" "}
                  {siteUrl}
                </p>
              )}

            </FieldGroup>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>
              {t("Sign-in emails", "E-Mails zur Anmeldung")}
            </CardTitle>
            <CardDescription>
              {t(
                "For registration, sign-in links and password resets.",
                "Für Registrierung, Anmeldelinks und Passwort-Resets.",
              )}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="sb-mail" className="sr-only">
                  {t("Mail server", "Mailserver")}
                </FieldLabel>
                <NativeSelect
                  id="sb-mail"
                  value={mail}
                  onChange={(event) =>
                    setMail(event.target.value as typeof mail)
                  }
                >
                  <NativeSelectOption value="global">
                    {t(
                      "Use the default mail server",
                      "Standard-Mailserver verwenden",
                    )}
                  </NativeSelectOption>
                  <NativeSelectOption value="custom">
                    {t(
                      "Use a separate mail server",
                      "Eigenen Mailserver verwenden",
                    )}
                  </NativeSelectOption>
                  <NativeSelectOption value="disabled">
                    {t("Set up later", "Später einrichten")}
                  </NativeSelectOption>
                </NativeSelect>
                <FieldDescription>
                  {mail === "global"
                    ? smtp.isPending ? t("Checking your mail settings…", "Mail-Einstellungen werden geprüft…") : smtp.isError ? t("Mail settings could not be loaded. Open mail settings to retry, or set up email later.", "Mail-Einstellungen konnten nicht geladen werden. Öffne sie zum erneuten Laden oder richte E-Mail später ein.") : smtp.data?.verified
                      ? t(
                          "Your verified mail server is ready.",
                          "Dein geprüfter Mailserver ist bereit.",
                        )
                      : smtp.data?.configuration?.enabled
                        ? t(
                            "Verify the mail server in settings first.",
                            "Prüfe zuerst den Mailserver in den Einstellungen.",
                          )
                        : t(
                            "No default sender yet. Email sign-up stays off until you set one up.",
                            "Noch kein Standard-Absender. E-Mail-Registrierung bleibt bis zur Einrichtung ausgeschaltet.",
                          )
                    : mail === "disabled"
                      ? t(
                          "Email sign-up stays off. You can enable it later.",
                          "E-Mail-Registrierung bleibt ausgeschaltet. Du kannst sie später aktivieren.",
                        )
                      : t(
                          "Use the credentials supplied by your email provider.",
                          "Verwende die Zugangsdaten deines E-Mail-Anbieters.",
                        )}{" "}
                  {mail === "global" && (
                    <Link
                      to="/settings/smtp"
                      className="underline underline-offset-4"
                    >
                      {t("Mail settings", "Mail-Einstellungen")}
                    </Link>
                  )}
                </FieldDescription>
              </Field>
              {mail === "custom" && (
                <FieldGroup className="grid sm:grid-cols-2">
                  {(
                    [
                      ["smtpHost", t("Mail server", "Mailserver"), "text"],
                      ["smtpUser", t("Username", "Benutzername"), "text"],
                      [
                        "smtpPassword",
                        t("Password or API key", "Passwort oder API-Schlüssel"),
                        "password",
                      ],
                      ["smtpSender", t("Sender name", "Absendername"), "text"],
                      [
                        "smtpEmail",
                        t("Sender email", "Absender-E-Mail"),
                        "email",
                      ],
                    ] as const
                  ).map(([field, label, type]) => (
                    <Field key={field}>
                      <FieldLabel htmlFor={field}>{label}</FieldLabel>
                      <Input
                        id={field}
                        name={field}
                        type={type}
                        required
                        maxLength={field === "smtpPassword" ? 4096 : 320}
                        autoComplete={
                          type === "password" ? "new-password" : undefined
                        }
                      />
                    </Field>
                  ))}
                </FieldGroup>
              )}
            </FieldGroup>
          </CardContent>
        </Card>
        <Collapsible>
          <Card>
            <CardHeader>
              <CollapsibleTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  className="group justify-between"
                >
                  <span className="flex items-center gap-2">
                    <Settings2 />
                    {t("Advanced settings", "Erweiterte Einstellungen")}
                  </span>
                  <ChevronDown className="group-data-[state=open]:rotate-180" />
                </Button>
              </CollapsibleTrigger>
              <CardDescription>
                {t(
                  "Custom addresses and additional sign-in destinations.",
                  "Eigene Adressen und zusätzliche Anmelde-Ziele.",
                )}
              </CardDescription>
            </CardHeader>
            <CollapsibleContent>
              <CardContent>
                <FieldGroup>
              {project && (
                <Field orientation="horizontal">
                  <Checkbox
                    id="sb-replace"
                    checked={replace}
                    onCheckedChange={(value) => setReplace(value === true)}
                  />
                  <div>
                    <FieldLabel htmlFor="sb-replace">
                      {t(
                        "Replace this app’s existing connection settings",
                        "Vorhandene Verbindungseinstellungen dieser App ersetzen",
                      )}
                    </FieldLabel>
                    <FieldDescription>
                      {t(
                        "Your current app stays online until you deploy the new settings.",
                        "Deine App bleibt bis zur Bereitstellung der neuen Einstellungen unverändert online.",
                      )}
                    </FieldDescription>
                  </div>
                </Field>
              )}
                  {(["api", "studio"] as const).map((kind) => (
                    <Field key={kind}>
                      <FieldLabel htmlFor={`sb-${kind}`}>
                        {kind === "api"
                          ? t(
                              "App connection address",
                              "Verbindungsadresse für Apps",
                            )
                          : t("Studio address", "Studio-Adresse")}
                      </FieldLabel>
                      <Input
                        id={`sb-${kind}`}
                        value={addresses[kind]}
                        onChange={(event) =>
                          setOverrides((previous) => ({
                            ...previous,
                            [kind]: event.target.value,
                          }))
                        }
                        maxLength={253}
                        placeholder={`${kind}.example.com`}
                      />
                      <FieldDescription>
                        {t(
                          "An unused hostname, without https://.",
                          "Ein unbenutzter Hostname ohne https://.",
                        )}
                      </FieldDescription>
                    </Field>
                  ))}
                  {project?.website && siteUrl && (
                    <Field>
                      <FieldLabel htmlFor="sb-site-override">
                        {t("Your app’s website", "Website deiner App")}
                      </FieldLabel>
                      <Input
                        id="sb-site-override"
                        type="url"
                        value={siteUrl}
                        onChange={(event) => setSiteUrl(event.target.value)}
                        maxLength={2048}
                      />
                    </Field>
                  )}
                  <Field>
                    <FieldLabel htmlFor="sb-redirects">
                      {t(
                        "Additional sign-in destinations",
                        "Zusätzliche Anmelde-Ziele",
                      )}
                    </FieldLabel>
                    <Textarea
                      id="sb-redirects"
                      value={redirects}
                      onChange={(event) => setRedirects(event.target.value)}
                      placeholder="https://preview.example.com"
                    />
                    <FieldDescription>
                      {t(
                        "One exact HTTPS address per line. No wildcards.",
                        "Eine genaue HTTPS-Adresse pro Zeile. Keine Platzhalter.",
                      )}
                    </FieldDescription>
                  </Field>
                </FieldGroup>
              </CardContent>
            </CollapsibleContent>
          </Card>
        </Collapsible>
      </fieldset>
      <aside className="min-w-0 xl:sticky xl:top-6">
        <Card>
          <CardHeader>
            <Database className="mb-2 size-6 text-primary" aria-hidden="true" />
            <CardTitle>
              {name.trim() || t("Your database", "Deine Datenbank")}
            </CardTitle>
            <CardDescription>
              {t(
                "Database, authentication and storage on your server.",
                "Datenbank, Anmeldung und Dateien auf deinem Server.",
              )}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <dl className="flex flex-col gap-4 text-sm">
              <div>
                <dt className="text-muted-foreground">
                  {t("Connected app", "Verbundene App")}
                </dt>
                <dd className="mt-1 font-medium">
                  {project?.name ?? t("Connect later", "Später verbinden")}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t("Domain", "Domain")}</dt>
                <dd className="mt-1 break-all font-medium">{selectedDomain || "—"}</dd>
              </div>
            </dl>
            {missing.length > 0 && <div className="rounded-lg bg-muted/40 p-3 text-sm">
              <p className="font-medium">{t("Still needed", "Noch erforderlich")}</p>
              <ul className="mt-2 flex list-disc flex-col gap-1 pl-4 text-muted-foreground">{missing.map(item => <li key={item}>{item}</li>)}</ul>
            </div>}

            {capacity.data?.status === "blocked" ? (
              <Alert variant="destructive">
                <AlertTitle>
                  {t(
                    "Your server needs attention",
                    "Dein Server benötigt Aufmerksamkeit",
                  )}
                </AlertTitle>
                <AlertDescription>
                  <ul>
                    {Object.entries(capacity.data.checks)
                      .filter(([, ok]) => ok === false)
                      .map(([key]) => (
                        <li key={key}>
                          {capacityLabels[key as keyof typeof capacityLabels]}
                        </li>
                      ))}
                  </ul>
                  <Link
                    to={
                      capacity.data.checks.cloudflare === false
                        ? "/settings/cloudflare"
                        : "/server"
                    }
                  >
                    {t("Review setup", "Einrichtung prüfen")}
                  </Link>
                </AlertDescription>
              </Alert>
            ) : (
              <p className="flex items-start gap-2 text-sm text-muted-foreground">
                <CheckCircle2
                  className="mt-0.5 size-4 shrink-0"
                  aria-hidden="true"
                />
                {capacity.data?.status === "ready"
                  ? t(
                      "Your server has enough capacity.",
                      "Dein Server hat genügend Kapazität.",
                    )
                  : t(
                      "Capacity is checked again during installation.",
                      "Die Kapazität wird bei der Installation erneut geprüft.",
                    )}
              </p>
            )}
            {project && (
              <p className="text-sm text-muted-foreground">
                {t(
                  "Next step after setup: update your app.",
                  "Danach: App aktualisieren und Verbindung aktivieren.",
                )}
              </p>
            )}
          </CardContent>
          <CardFooter className="fixed inset-x-0 bottom-0 z-30 flex-col items-stretch rounded-none border-t bg-background/95 p-4 backdrop-blur-sm sm:flex-row sm:items-center sm:justify-between lg:left-60 xl:static xl:rounded-b-lg xl:bg-muted/20 xl:backdrop-blur-none">
            <p role="status" className="text-xs text-muted-foreground xl:hidden">{missing[0] ?? t("Your app stays online during setup.", "Deine App bleibt während der Einrichtung online.")}</p>
            <Button
              type="submit"
              disabled={!ready || pending}
              className="w-full sm:w-auto xl:w-full"
            >
              {pending ? <Spinner /> : <ArrowRight data-icon="inline-end" />}
              {pending
                ? t("Creating…", "Wird erstellt…")
                : t("Create database", "Datenbank erstellen")}
            </Button>
          </CardFooter>
        </Card>
      </aside>
    </form>
  );
}
