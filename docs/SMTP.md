# Outgoing email: global defaults and instance overrides

Configure **Settings → Email & SMTP** once to share one outgoing mail server
with managed Supabase instances. SMTP is used for authentication messages such as
email confirmation, invitations, magic links, and password recovery.

## Setup

1. Choose Resend, Zoho CPaaS / ZeptoMail, or a custom SMTP server.
2. Enter the hostname, SMTP username, password or sending API key, sender email,
   and sender display name. Provider presets fill only the hostname and username;
   they do not connect an account or create a sending domain.
3. Save, then choose **Verify saved connection**. This checks TLS and SMTP
   authentication without sending an email.
4. Optionally choose **Send test email**. The recipient is always the currently
   signed-in administrator. An accepted SMTP message is not proof of delivery;
   check the inbox and the provider's delivery logs.
5. Choose **Apply to connected instances** to update existing global consumers.
   The screen lists affected instances before queueing the work.

| Provider | SMTP hostname | Username | Password |
| --- | --- | --- | --- |
| Resend | `smtp.resend.com` | `resend` | Sending API key |
| Zoho CPaaS / ZeptoMail | Account's regional SMTP hostname; commonly `smtp.zeptomail.com` | `emailapikey` | SMTP password / Send Mail token from the selected Agent |
| Custom | Your SMTP DNS hostname | Your SMTP username | Your SMTP credential |

See the [Resend SMTP documentation](https://resend.com/docs/send-with-smtp) and
[Zoho CPaaS SMTP settings](https://www.zoho.com/cpaas/help/smtp-home.html). Use the
regional hostname and credentials displayed in your provider account.

New SMTP configurations require **implicit TLS on port 465**, with
certificate validation and TLS 1.2 or newer for Shelter's connection test. It does
not offer plaintext, opportunistic STARTTLS, or a certificate-verification bypass.
This also matches Supabase Auth's port-based implicit-TLS behavior. Existing custom
per-instance configurations remain unchanged. The VPS needs outbound access to
port 465; no inbound SMTP port is opened.

Use a sender domain verified with your provider. Configure the provider's SPF and
DKIM records and an appropriate DMARC policy. Shelter does not overwrite DNS or
create provider resources when an SMTP preset is selected. Rate limits, sending
quotas, bounces, suppression lists, and domain verification remain provider concerns.

## How instances consume changes

New Supabase instances default to **Use global SMTP**. With no global server,
email signup stays disabled. With an enabled global server, its current revision
must have passed the connection test before it can be used.

Existing instances retain their current behavior. Instances with their own SMTP
credentials are not silently switched. Open **Edit email settings** on an instance and choose **Use global SMTP** to
opt it in. Choose **Own SMTP settings** to configure an independent server,
username, password / API key, sender email, and sender name. Its connection is
verified before the change is queued; this does not send mail. Choose **Disable
email** to turn it off for only that instance. New custom configurations use TLS
on port 465. Existing legacy configurations are preserved until explicitly edited.

Saving a global configuration does not immediately change running containers.
**Apply to connected instances** queues a consistent snapshot for global consumers;
if any affected instance is busy, the whole request is rejected rather than
partially applied. Unrelated and custom configurations are untouched.

The worker replaces only the affected Auth container. There is a short interruption
to public routing while health is checked. Databases, files, API keys, and user
sessions are retained. A stopped instance stays stopped. Interrupted or failed
operations retain the desired snapshot and can be retried. Later global edits do
not change a job already in progress; apply the newer revision afterwards.

To disable global email, save the disabled configuration and apply it. Connected
instances then remove SMTP credentials from their desired configuration and disable
email signup. Existing SMTP connections are closed when the Auth service is replaced.

Backups capture instance settings together with encrypted credentials. Restoring an
older snapshot restores its SMTP revision as well; apply the current global settings
afterwards if needed. Snapshots created before SMTP settings were captured restore
with outgoing email disabled to avoid combining an old password with a newer server.

## Security and API

All global SMTP routes require an administrator browser session; personal API
tokens are rejected. Mutations retain CSRF protection. Passwords are encrypted using
Shelter's `APP_SECRET` and are never returned in settings responses. Blank password
input preserves a saved credential only when the hostname and username are unchanged.
Changing either requires explicitly supplying a credential. Each save invalidates
the prior connection verification, and stale save/verify/apply requests are rejected.

SMTP errors are returned as bounded error codes, without raw provider responses or
authentication data. Test mail has fixed content and cannot be used as an arbitrary
relay or sent to a caller-specified recipient. Delivery debugging must not publish
passwords, API keys, email contents, or container environment dumps.

- `GET /api/settings/smtp`: redacted settings, verification status, and instance consumers.
- `PUT /api/settings/smtp`: save settings with `expectedRevision` (`null` initially),
  `enabled`, `provider`, `host`, `port: 465`, `user`, optional `password`, `fromEmail`,
  and `fromName`.
- `POST /api/settings/smtp/verify`: verify the saved `revision`; sends no mail.
- `POST /api/settings/smtp/test-email`: send a fixed test to the administrator using
  the verified `revision`.
- `POST /api/settings/smtp/apply`: queue updates using the expected `revision`.
- `PUT /api/supabase/:id/smtp`: select `source: "global"`, `source: "disabled"`, or
  `source: "custom"` with an `smtp` object containing `host`, `port: 465`, `user`,
  `fromEmail`, `fromName`, and optional `password`. The password may be omitted
  only when keeping the same custom hostname and username. Custom updates verify
  the connection before queueing; changes during verification are rejected.
