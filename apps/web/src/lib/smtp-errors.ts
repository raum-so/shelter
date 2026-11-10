import { ApiError } from "@/api/client";
import type { useI18n } from "@/i18n";

export function smtpError(error: unknown, t: ReturnType<typeof useI18n>["t"]) {
  const details = error instanceof ApiError ? error.details : undefined;
  const code =
    details && typeof details === "object" && "code" in details
      ? details.code
      : undefined;
  const messages: Record<string, [string, string]> = {
    SMTP_CHANGED: [
      "The settings changed. Reload this page before continuing.",
      "Die Einstellungen wurden geändert. Lade diese Seite neu.",
    ],
    SMTP_PASSWORD_REQUIRED: [
      "Enter the password or API key for the selected server.",
      "Gib das Passwort oder den API-Schlüssel des gewählten Servers ein.",
    ],
    SMTP_AUTH_FAILED: [
      "The SMTP server rejected the credentials.",
      "Der SMTP-Server hat die Zugangsdaten abgewiesen.",
    ],
    SMTP_TLS_FAILED: [
      "A trusted TLS connection could not be established.",
      "Es konnte keine vertrauenswürdige TLS-Verbindung aufgebaut werden.",
    ],
    SMTP_CONNECTION_FAILED: [
      "The SMTP connection failed. Check the server, port and network.",
      "Die SMTP-Verbindung ist fehlgeschlagen. Prüfe Server, Port und Netzwerk.",
    ],
    SMTP_NOT_VERIFIED: [
      "Verify the saved connection first.",
      "Prüfe zuerst die gespeicherte Verbindung.",
    ],
    INSTANCE_BUSY: [
      "Wait for the current instance operation to finish.",
      "Warte, bis der aktuelle Instanzvorgang abgeschlossen ist.",
    ],
    SMTP_INSTANCES_BUSY: [
      "Wait for the current service operations to finish.",
      "Warte, bis die laufenden Dienstvorgänge abgeschlossen sind.",
    ],
    SMTP_RECIPIENT_INVALID: [
      "Your administrator email must be a valid recipient address.",
      "Deine Administrator-E-Mail muss eine gültige Empfängeradresse sein.",
    ],
    VALIDATION: [
      "Check your input. Secure SMTP on port 465 is required.",
      "Prüfe deine Eingaben. Sicheres SMTP auf Port 465 ist erforderlich.",
    ],
  };
  const message = typeof code === "string" ? messages[code] : undefined;
  return message
    ? t(...message)
    : t(
        "The request failed. Please try again.",
        "Die Anfrage ist fehlgeschlagen. Bitte versuche es erneut.",
      );
}
