import { ApiError } from "@/api/client";
import type { useI18n } from "@/i18n";
export function supabaseErrorMessage(
  error: unknown,
  t: ReturnType<typeof useI18n>["t"],
) {
  const messages: Record<string, [string, string]> = {
    SUPABASE_PREFLIGHT_BLOCKED: ["Your server needs attention before another instance can be created. Review server capacity and Cloudflare setup.", "Dein Server benötigt vor einer weiteren Instanz Aufmerksamkeit. Prüfe Serverkapazität und Cloudflare-Einrichtung."],
    ENV_EXISTS: [
      "This app already has connection settings. Confirm their replacement in Advanced settings to switch databases.",
      "Diese App hat bereits Verbindungseinstellungen. Bestätige unter Erweiterte Einstellungen deren Ersetzung, um die Datenbank zu wechseln.",
    ],
    CONNECTION_EXISTS: [
      "This app is already linked to another Supabase instance.",
      "Diese App ist bereits mit einer anderen Supabase-Instanz verbunden.",
    ],
    SITE_URL_REQUIRED: [
      "Enter the app’s website for sign-in redirects.",
      "Gib die Website der App für die Rückkehr nach der Anmeldung an.",
    ],
    DOMAIN_EXISTS: [
      "An address is already in use. Choose another database name or change the addresses in Advanced settings.",
      "Eine Adresse ist bereits vergeben. Wähle einen anderen Datenbanknamen oder ändere die Adressen unter Erweiterte Einstellungen.",
    ],
    SMTP_NOT_VERIFIED: [
      "Verify the global SMTP connection in Settings first.",
      "Prüfe zuerst die globale SMTP-Verbindung in den Einstellungen.",
    ],
    SMTP_PASSWORD_REQUIRED: [
      "Enter SMTP credentials or use the global configuration.",
      "Gib SMTP-Zugangsdaten ein oder verwende die globale Konfiguration.",
    ],
    VALIDATION: [
      "Check the fields and use valid HTTPS URLs.",
      "Prüfe die Felder und verwende gültige HTTPS-URLs.",
    ],
    HOSTNAME_COLLISION: [
      "API and Studio need different hostnames.",
      "API und Studio benötigen unterschiedliche Hostnamen.",
    ],
    TUNNEL_NOT_CONFIGURED: [
      "Connect your Cloudflare tunnel first.",
      "Verbinde zuerst deinen Cloudflare-Tunnel.",
    ],
    CURRENT_PASSWORD_INVALID: [
      "Your current Shelter password is incorrect.",
      "Dein aktuelles Shelter-Passwort ist nicht korrekt.",
    ],
    INSTANCE_BUSY: [
      "Wait for the current operation to finish.",
      "Warte, bis der aktuelle Vorgang abgeschlossen ist.",
    ],
    INSTANCE_UNAVAILABLE: [
      "Start the instance before connecting an application.",
      "Starte die Instanz, bevor du eine Anwendung verbindest.",
    ],
    PROJECT_UNAVAILABLE: [
      "The project is busy or unavailable. Try again after its deployment finishes.",
      "Das Projekt ist beschäftigt oder nicht verfügbar. Versuche es nach dem Deployment erneut.",
    ],
    ENVIRONMENT_TOO_LARGE: [
      "The project's environment exceeds the 256 KiB limit.",
      "Die Projektvariablen überschreiten das Limit von 256 KiB.",
    ],
    CONFIRMATION_REQUIRED: [
      "Type the exact instance name to confirm.",
      "Gib zum Bestätigen den exakten Instanznamen ein.",
    ],
    INVALID_BACKUP: [
      "Choose a completed backup of this instance and version.",
      "Wähle ein abgeschlossenes Backup dieser Instanz und Version.",
    ],
    BAD_REQUEST: [
      "Check your input, including the variable names.",
      "Prüfe deine Eingaben einschließlich der Variablennamen.",
    ],
  };
  const details = error instanceof ApiError ? error.details : undefined;
  const code =
    details &&
    typeof details === "object" &&
    "code" in details &&
    typeof details.code === "string"
      ? details.code
      : "";
  if (code === "FUNCTION_CHANGED") return supabaseOperationError(code, t);
  const message = messages[code];
  return message
    ? t(...message)
    : t(
        "The request failed. Please try again.",
        "Die Anfrage ist fehlgeschlagen. Bitte versuche es erneut.",
      );
}

export function supabaseOperationError(
  code: string | null,
  t: ReturnType<typeof useI18n>["t"],
) {
  const messages: Record<string, [string, string]> = {
    SUPABASE_PREFLIGHT_BLOCKED: ["Your server needs attention before another instance can be created. Review server capacity and Cloudflare setup.", "Dein Server benötigt vor einer weiteren Instanz Aufmerksamkeit. Prüfe Serverkapazität und Cloudflare-Einrichtung."],
    FUNCTION_CHANGED: [
      "This function changed on the server. Reload it before deploying your edits.",
      "Diese Funktion wurde auf dem Server geändert. Lade sie vor dem Bereitstellen deiner Änderungen neu.",
    ],
    FUNCTION_VALIDATION_FAILED: [
      "The new code could not be loaded. Check its syntax and imports. The active version is unchanged.",
      "Der neue Code konnte nicht geladen werden. Prüfe Syntax und Imports. Die aktive Version bleibt unverändert.",
    ],
    FUNCTION_ACTIVATION_FAILED: [
      "Activation failed. The previous version was restored.",
      "Die Aktivierung ist fehlgeschlagen. Die vorherige Version wurde wiederhergestellt.",
    ],
    FUNCTION_ROLLBACK_FAILED: [
      "The function could not be restored. Check the instance and retry its last working version.",
      "Die Funktion konnte nicht wiederhergestellt werden. Prüfe die Instanz und stelle die letzte funktionierende Version erneut bereit.",
    ],
    CONNECTION_NOT_READY: [
      "Apply the connection and redeploy the app before testing it.",
      "Übernimm die Verbindung und stelle die App vor dem Test erneut bereit.",
    ],
    BACKUP_VERIFY_FAILED: [
      "The restore test failed. The running instance was not changed. Create another backup and retry.",
      "Der Wiederherstellungstest ist fehlgeschlagen. Die laufende Instanz wurde nicht verändert. Erstelle ein neues Backup und prüfe es erneut.",
    ],
    BACKUP_UPLOAD_FAILED: [
      "The local backup is available, but its external copy failed. Check the storage credentials and permissions.",
      "Das lokale Backup ist vorhanden, aber die externe Kopie ist fehlgeschlagen. Prüfe Zugangsdaten und Speicherberechtigungen.",
    ],
    SUPABASE_NETWORK_CAPACITY: [
      "No network range is available. Configure a reserved Supabase network pool on the server, then retry.",
      "Es ist kein Netzwerkbereich frei. Konfiguriere einen reservierten Supabase-Netzwerkbereich und versuche es erneut.",
    ],
    CAPACITY_CHECK_FAILED: [
      "The server requirements check failed. Check available memory, disk space and Docker before retrying.",
      "Die Serverprüfung ist fehlgeschlagen. Prüfe freien Arbeitsspeicher, Speicherplatz und Docker vor einem erneuten Versuch.",
    ],
    DOMAIN_SETUP_FAILED: [
      "The services started, but the domains could not be connected. Check the Cloudflare connection and hostname ownership, then retry.",
      "Die Dienste wurden gestartet, aber die Domains konnten nicht verbunden werden. Prüfe die Cloudflare-Verbindung und die Zuordnung der Hostnamen und versuche es erneut.",
    ],
    BACKUP_CREATE_FAILED: [
      "The backup could not be completed. Check free disk space and create a new backup.",
      "Das Backup konnte nicht abgeschlossen werden. Prüfe den freien Speicherplatz und erstelle ein neues Backup.",
    ],
    BACKUP_RESTORE_FAILED: [
      "The backup could not be restored. Check the instance status and test another recovery point.",
      "Das Backup konnte nicht wiederhergestellt werden. Prüfe den Instanzstatus und teste einen anderen Wiederherstellungspunkt.",
    ],
    SERVICE_START_FAILED: [
      "A service could not be started. Check the instance health and retry.",
      "Ein Dienst konnte nicht gestartet werden. Prüfe den Instanzzustand und versuche es erneut.",
    ],
    REQUEST_INTERRUPTED: [
      "The test was interrupted. It may have reached your function; check its effects before sending another request.",
      "Der Test wurde unterbrochen. Er könnte deine Funktion erreicht haben; prüfe die Auswirkungen vor einer weiteren Anfrage.",
    ],
    OPERATION_FAILED: [
      "The operation failed. Your draft and existing data are retained. Check the instance and retry.",
      "Der Vorgang ist fehlgeschlagen. Entwurf und vorhandene Daten bleiben erhalten. Prüfe die Instanz und versuche es erneut.",
    ],
  };
  return t(...(messages[code ?? ""] ?? messages.OPERATION_FAILED!));
}
