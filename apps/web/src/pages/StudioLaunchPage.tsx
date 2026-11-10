import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api } from "@/api/client";
import { useI18n } from "@/i18n";
import { Spinner } from "@/components/ui/spinner";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";

export function StudioLaunchPage() {
  const { id = "" } = useParams();
  const [params] = useSearchParams();
  const state = params.get("state") ?? undefined;
  const [failed, setFailed] = useState(false);
  const { t } = useI18n();
  useEffect(() => {
    let active = true;
    api.supabaseStudio(id, state).then(({ url }) => {
      if (active) window.location.replace(url);
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [id, state]);
  if (failed) return <Alert variant="destructive">
    <AlertTitle>{t("Studio could not be opened", "Studio konnte nicht geöffnet werden")}</AlertTitle>
    <AlertDescription>{t("Make sure the instance is running and you are signed in. Then try again from Services.", "Prüfe, ob die Instanz läuft und du angemeldet bist. Versuche es dann erneut über Dienste.")}
      <Link to="/services" className="underline">{t("Back to Services", "Zurück zu Dienste")}</Link>
    </AlertDescription>
  </Alert>;
  return <p role="status" className="flex items-center gap-2 text-muted-foreground"><Spinner />{t("Signing you in to Studio…", "Du wirst sicher bei Studio angemeldet…")}</p>;
}
