import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { useI18n } from "@/i18n";
import { formatDate } from "@/utils/format";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
export function SecurityEvents() {
  const { t, locale } = useI18n();
  const query = useQuery({
    queryKey: ["security-events"],
    queryFn: api.securityEvents,
    refetchInterval: 30_000,
  });
  function label(event: string) {
    if (event === "auth.login.failed")
      return t("Sign-in attempt failed", "Anmeldeversuch fehlgeschlagen");
    if (event === "auth.login") return t("Signed in", "Angemeldet");
    if (event.includes("/mfa/enable"))
      return t(
        "Two-factor authentication enabled",
        "Zwei-Faktor-Anmeldung aktiviert",
      );
    if (event.includes("/mfa/disable"))
      return t(
        "Two-factor authentication disabled",
        "Zwei-Faktor-Anmeldung deaktiviert",
      );
    if (event.includes("/mfa/setup"))
      return t(
        "Authenticator setup started",
        "Authenticator-Einrichtung gestartet",
      );
    if (event.includes("/auth/password"))
      return t("Password change", "Passwortänderung");
    if (event.includes("/auth/logout")) return t("Signed out", "Abgemeldet");
    if (event.includes("/supabase"))
      return t("Supabase operation", "Supabase-Vorgang");
    if (event.includes("/api-tokens"))
      return t("Personal API token changed", "Persönlicher API-Token geändert");
    return t(
      "Settings or project changed",
      "Einstellung oder Projekt geändert",
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {t("Security activity", "Sicherheitsaktivitäten")}
        </CardTitle>
        <CardDescription>
          {t(
            "Recent sign-ins and administrator actions. Credentials and request contents are never included.",
            "Letzte Anmeldungen und Admin-Aktionen. Zugangsdaten und Anfrageinhalte werden nicht aufgenommen.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {query.isPending ? (
          <Skeleton className="h-28" />
        ) : query.isError ? (
          <Button variant="outline" onClick={() => query.refetch()}>
            {t("Retry", "Erneut versuchen")}
          </Button>
        ) : !query.data.events.length ? (
          <p className="text-sm text-muted-foreground">
            {t(
              "New security events will appear here.",
              "Neue Sicherheitsereignisse erscheinen hier.",
            )}
          </p>
        ) : (
          <ol className="max-h-96 divide-y overflow-auto">
            {query.data.events.map((event, index) => (
              <li
                key={`${event.createdAt}-${index}`}
                className="flex items-start justify-between gap-4 py-3 first:pt-0"
              >
                <div className="flex flex-col gap-1">
                  <span className="text-sm font-medium">
                    {label(event.event)}
                  </span>
                  <time
                    className="text-xs text-muted-foreground"
                    dateTime={event.createdAt}
                  >
                    {formatDate(event.createdAt, locale)}
                  </time>
                </div>
                <Badge
                  variant={event.status >= 400 ? "destructive" : "outline"}
                >
                  {event.status >= 400
                    ? t("Unsuccessful", "Fehlgeschlagen")
                    : t("Accepted", "Angenommen")}
                </Badge>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
