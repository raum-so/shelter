import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "@/api/client";
import { useI18n } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { formatBytes, formatMetricPercent } from "@/utils/server-metrics";

export function ServerCapacity() {
  const { t, locale } = useI18n();
  const metrics = useQuery({
    queryKey: ["server-metrics", "1h"],
    queryFn: () => api.serverMetrics("1h"),
    staleTime: 5_000,
    refetchInterval: (query) =>
      Math.max(10_000, (query.state.data?.intervalSeconds ?? 15) * 1_000),
    refetchIntervalInBackground: false,
    retry: 1,
  });
  const data = metrics.data;
  const age = data?.sampledAt ? Date.now() - Date.parse(data.sampledAt) : NaN;
  const current =
    !metrics.isError &&
    age >= -30_000 &&
    age <= Math.max(60_000, (data?.intervalSeconds ?? 15) * 6_000)
      ? data?.current
      : null;
  return (
    <section
      aria-label={t("Server capacity", "Serverkapazität")}
      className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3"
    >
      {metrics.isPending ? (
        <div role="status" className="flex flex-wrap gap-4">
          <span className="sr-only">
            {t("Loading server capacity…", "Serverkapazität wird geladen…")}
          </span>
          <Skeleton className="h-5 w-36" />
          <Skeleton className="h-5 w-36" />
          <Skeleton className="h-5 w-28" />
        </div>
      ) : current ? (
        <dl className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
          {[
            [
              t("RAM available", "RAM verfügbar"),
              formatBytes(current.memory.availableBytes, locale),
            ],
            [
              t("Storage free", "Speicher frei"),
              formatBytes(current.storage.availableBytes, locale),
            ],
            [
              t("CPU usage", "CPU-Auslastung"),
              formatMetricPercent(current.cpu.usagePercent, locale),
            ],
          ].map(([label, value]) => (
            <div key={label} className="flex items-baseline gap-2">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="font-medium tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <p role="status" className="text-muted-foreground">
            {t(
              "Current server capacity is unavailable.",
              "Aktuelle Serverkapazität ist nicht verfügbar.",
            )}
          </p>
          <Button
            variant="ghost"
            size="sm"
            disabled={metrics.isFetching}
            onClick={() => metrics.refetch()}
          >
            {t("Refresh", "Aktualisieren")}
          </Button>
        </div>
      )}
      <Button asChild variant="ghost" size="sm">
        <Link to="/server">{t("Server details", "Serverdetails")}</Link>
      </Button>
    </section>
  );
}
