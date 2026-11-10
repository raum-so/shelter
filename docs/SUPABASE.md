# Managed Supabase

Shelter manages a pinned self-hosted Supabase stack on the same VPS as your
applications. Open **Services → Add database**. This is a production-oriented
self-hosting integration, not an exposed `supabase start` development stack.

## Guided setup

1. Choose the app that will use the database. Shelter suggests its name, website, and a matching domain. When only one domain is connected, it is selected automatically.
2. Keep the default mail server or choose to configure sign-in emails later. Custom addresses and replacement of existing connection variables are under **Advanced settings**.
3. Choose **Create database** and follow the setup status. The current app remains online.
4. Choose **Update app** to activate the prepared connection. Then test the connection or open Studio directly from Shelter.

No manual API key copying is needed for a managed app connection. The app's code still needs to use the configured database variables; connecting an app does not rewrite its features or migrate an unrelated database.

## Requirements and boundaries

- Linux Docker Engine on amd64 or arm64, at least 8 GB RAM and 4 CPU cores.
  Leave capacity for Shelter, builds, and every other application. Installation
  also checks current Docker memory use and available disk space.
- A connected Cloudflare account and tunnel, and two unused hostnames in its zones.
- Plan at least 20 GB of free space for installation, plus the growing database,
  files, image cache, and backup working space. Backups and restores need extra
  space; a full disk can make Postgres unavailable.
- One instance is one Supabase project. Multiple instances have separate
  credentials, volumes, and networks and consume additional resources.
- This is still a single VPS. It provides neither high availability nor an
  off-site disaster-recovery service. The operator maintains the host, monitors
  capacity, and copies backups off the VPS.

The initial version pins `self-hosted/v0.8.3` to upstream commit
`bc27d2661edd09a5d0b8d76ce33da6d4071a756e` and fixes each of the ten images to an
OCI digest. The included services are Postgres 17, Auth, PostgREST, Realtime,
Storage, imgproxy, postgres-meta, Studio, Envoy, and the optional Edge Runtime. See the machine-readable
[manifest](../apps/server/assets/supabase/manifest.json). Upstream configuration
and its Apache license are included in the same directory. Shelter deliberately
uses its own lifecycle, mount, resource, and ingress policies.

The current interface does not offer Supabase version upgrades, an arbitrary
Compose editor, cloud branching, the Supabase
Management API, S3 storage backends, a connection pooler, or automated imports
from existing development volumes. Do not run upstream update/reset scripts
against these managed resources. Version upgrades require a separately reviewed
migration and restore procedure; replacing an image tag is not a database upgrade.

## Access model

Use two different hostnames, for example:

| Endpoint | Example | Protection |
| --- | --- | --- |
| Application API | `https://supabase.example.com` | Supabase keys, user JWTs, grants, and RLS |
| Studio | `https://studio.example.com` | Mandatory generated administrator password |
| Postgres | VPS loopback, assigned port | Database credentials and SSH tunnel |

Shelter redirects HTTP requests to HTTPS. The only HTTP target reachable by
Traefik is the Supabase gateway. Backend components are on a separate per-instance
network. No component receives the Docker socket. Only Postgres has a host port,
and that port is bound to `127.0.0.1`.

The gateway selects hosts itself, even if a client bypasses normal DNS. Unknown
hosts have no route. The application hostname has no Studio, postgres-meta, MCP,
or Realtime tenant-administration route. The public Realtime endpoints are the
WebSocket and broadcast endpoints. Every request on the Studio hostname requires
Basic authentication; possession of an application API key does not bypass it.
Studio responses are not cached and are marked noindex. Its external ingress is
rate-limited. Studio mutations additionally require a matching HTTPS Origin
header. Gateway request logging is disabled because URLs can contain keys,
OAuth codes, or signed storage tokens. A separate Cloudflare Access policy can
add an operator-managed identity layer to the Studio hostname; do not put a
browser-only Access policy on the public API hostname.

Open **Connection credentials**, enter your current Shelter password, and copy
credentials into a password manager. The response cannot be requested with a
personal API token. API status responses exclude credentials. Never put the
service-role key, database password, or SMTP password in a frontend build. RLS
must be enabled and tested on application tables: an anon key is intentionally
public, and the service-role key intentionally bypasses RLS.

**Rotate Studio password** replaces the generated Studio password.
**Rotate API keys and revoke sessions** separately replaces the JWT signing
secret and the anon/service-role keys, restarts the services with their existing
data, and invalidates existing application keys and user sessions, including refresh
tokens. User accounts and application data are retained. This operation
requires typing the instance name. Reconnect and redeploy applications afterwards;
Shelter never silently overwrites linked application variables. Older backups
contain their original credentials, so rotate again after restoring a backup if
those credentials were compromised.

Database-password rotation and provider-specific OAuth configuration are not
currently exposed as managed operations. Keep those secrets restricted; do not
manually edit the SQLite record or container environment to rotate them.

## Auth and application configuration

Supply the application's HTTPS URL and explicit additional redirect URLs when
creating the instance. Wildcard redirects are not accepted. SMTP is optional,
but without it public email signup is disabled. Email and phone autoconfirmation
and anonymous sign-in are disabled. Configure a real SMTP account under **Settings → Email & SMTP** if the
application needs email authentication. New instances inherit the verified global
configuration. Existing custom SMTP settings are retained; opt into global SMTP
explicitly to update them. Use **Edit email settings** on any instance to override
the global default with its own SMTP credentials or to disable email. Newly saved
SMTP servers require implicit TLS on port 465. See [Outgoing email](SMTP.md) for verification,
provider presets, and controlled updates.

Choose an existing app during setup to fill its website address and reserve a
connection. You can also connect apps later from **Services → Connected apps**
or from the app's **Environment** tab. One app has one managed Supabase connection;
one Supabase instance can serve multiple apps.

Shelter prepares only the public API URL and anon key, after Supabase is running
and any app deployment has finished. Variable names are suggested from the app's
stored analysis and existing configuration: `NEXT_PUBLIC_` for Next.js, `VITE_`
for Vite, `REACT_APP_` for Create React App, `PUBLIC_` for Astro, and unprefixed
`SUPABASE_URL` / `SUPABASE_ANON_KEY` for server applications. You can choose other
names before creating the connection. The application code must use those variables;
Shelter does not rewrite code or migrate an external database automatically.

The connection status distinguishes waiting, changed configuration, and a required
app deployment. **Redeploy app** explicitly starts a deployment; connecting never
silently redeploys a live app. A deployment after the variables were prepared is
shown as current, but this does not prove that the application's code uses Supabase.
API-key rotation or a restore can require updating the connection and redeploying.

Existing values require explicit replacement, and edits made while provisioning
are not overwritten. On disconnect, only unchanged managed variables are removed;
manually edited values are kept. Disconnecting does not revoke public keys or delete
Supabase data. A new app's exact HTTPS website is added to Auth's allowed destinations
when needed, with a brief Auth restart; no wildcard is added. Explicit callback URLs
still belong in the additional sign-in destinations. When sharing an instance,
each app must supply its own allowed redirect URL to the Auth client; the default
site URL remains the one chosen during setup. Disconnecting preserves those
Auth destinations; review them before retiring or transferring a domain.

Connections never copy the service-role key or database password, and they do not
join application containers to the database's Docker network.

## Database and Supabase CLI

The database port is assigned by Docker and displayed in the credentials view.
It may change when containers are recreated during restore or API-key rotation. From your computer:

```sh
ssh -N -L 65432:127.0.0.1:ASSIGNED_PORT USER@YOUR_VPS
```

Use host `127.0.0.1`, port `65432`, database `postgres`, and user `postgres` in
your database tool. Supply the password through its protected credential prompt
or password file, not a command argument. The SSH tunnel encrypts the external
transport. The connection terminates directly at Postgres, so migrations and
session-dependent database tools are not subject to transaction-pooler limits.

Supabase CLI commands that support `--db-url` can use this endpoint. For example,
use the password-free URL `postgresql://postgres@127.0.0.1:65432/postgres?sslmode=disable` with
`supabase db push`, supplying the password through the CLI's protected prompt or
supported secret configuration. Check the installed CLI version before running
schema changes. `sslmode=disable` applies only to the loopback connection carried
inside the SSH tunnel; do not use it for an unencrypted external database connection.
A connection test is not permission to reset a database.

Cloud-oriented commands such as project linking/creation and Supabase Cloud function
deployment are not supported by this instance. Deploy self-hosted functions through Shelter. Never expose the development
stack created by `supabase start` as a substitute.

## Backup, restore, and archival

**Create backup** removes public routing, stops the entire instance, and takes a
cold physical snapshot of the database, Postgres configuration volume, Storage,
Studio snippets, Edge Functions, and gateway configuration. It encrypts the archive with
AES-256-GCM using a key derived from Shelter's `APP_SECRET`; the authenticated
identity binds it to the instance, template version, and backup ID. Plaintext
working archives are removed when the operation ends. Previously running
instances are restarted; previously stopped instances remain stopped.

Encrypted archives are stored under
`DATA_DIR/supabase-backups/<instance-id>/<backup-id>.enc`. Retain the corresponding
Shelter database and `APP_SECRET` with your recovery material. A copy of the
archive alone is not sufficient to recover the instance's encrypted credentials.
Copy the encrypted archive and recovery material to independent storage; snapshots
on the same VPS do not protect against host or disk loss. Daily scheduling and optional S3 replication are available on the instance’s Backups page. Retention and recovery-material copies remain operator responsibilities; Shelter never automatically deletes recovery points.

Restore accepts only a completed backup of the same instance and exact template
version and requires typing the instance name. Shelter verifies the ciphertext
checksum and authenticates/decrypts the complete archive before changing
containers. It restores into a fresh volume generation, starts and checks that
generation, and then switches the recorded generation. Previous volumes are
retained. A failed restore attempts to restart the previous generation without
modifying its volumes. Re-check the displayed database port after restoration.

Archiving requires the instance name, stops the instance, removes its owned DNS
records, and retains all data and backups. Archived hostnames stay reserved; **Reactivate instance** starts the retained
instance and provisions its owned DNS again.
There is intentionally no automatic volume pruning or destructive purge button.
An administrator must account for retained generations when planning disk space.

## Operations and verification

Jobs are persisted in SQLite and serialized per instance. The worker resumes
interrupted operations, checks container health, and only publishes a running
instance after successful setup. On failure, the UI shows a bounded error and
retains data. Inspect capacity, provider configuration, and owned container health
before retrying. Docker access is root-equivalent; container inspect output and
backend logs can contain private information and must not be pasted into public
issues.

The regular test suite covers authorization, CSRF, secret disclosure, validation,
job conflicts, and backup authentication. Run the separate real-container gate
on a disposable Docker host with adequate capacity:

```sh
npm run test:supabase
```

It creates its own random, labelled resources, uses no Cloudflare credentials,
and checks mandatory Studio authentication, API/admin separation including path
normalization, key enforcement, RLS, WebSocket upgrade, Storage, API-key revocation, and a cold
backup/restore. It removes only its own resources afterwards. Run it on each
supported architecture before releasing the template. Separately verify your
real HTTPS hostnames, DNS ownership, SMTP delivery, OAuth callbacks when used,
and off-site restore procedure before putting an installation into service.
Local tests do not attest that a particular VPS or Cloudflare account is ready.

### Docker network capacity

Each instance uses two isolated Docker networks. Docker's default address pools
can run out before the server runs out of memory or disk space. In that case the
panel reports that no network range is available and retains the instance data.

An operator can reserve an unused private `/16` by setting, for example,
`SUPABASE_NETWORK_POOL=10.252.0.0/16` in the installation's `.env` and applying the
configuration through the normal installer. Check the entire range against host,
LAN, VPN and Docker routes first; Shelter cannot discover routes outside Docker.
Only `10.x.0.0/16` ranges are accepted. The worker creates distinct `/24` subnets
within that range and skips subnets already claimed by Docker. Existing networks
are reused and never renumbered. Ordinary app networks use the separate
`PROJECT_NETWORK_POOL` setting, for example `10.251.0.0/16`; reserve distinct
ranges for the two settings. A Docker daemon restart is not required.

PostgREST's pinned image has no shell. The worker checks REST readiness with
`postgrest --ready` directly, including ongoing reconciliation; Docker therefore
shows this container without a native health status. The other services retain
their native Docker healthchecks. An older shell-based REST healthcheck is repaired
by recreating only that stateless container, preserving the database and volumes.

### Open Studio from Shelter

**Open Studio** signs you in using your current Shelter browser session. A
host-only browser nonce binds the handoff to the browser that initiated it. The
handoff ticket is single-use, expires after 60 seconds, and travels in a URL
fragment so it is not sent in HTTP requests or referrers. Its hash is stored in
SQLite. The resulting Studio cookie is Secure, HttpOnly, SameSite=Strict and
host-only; it expires after at most eight hours or when the parent Shelter
session expires. Logout, credential rotation, a restored database generation,
or a stopped instance invalidates access. No Studio password is sent to browser
JavaScript or embedded in a URL.

Traefik checks each Studio request with the internal Shelter authorization
endpoint and adds the instance's Basic authorization only on the private hop to
the gateway. The gateway continues to enforce its password and same-origin
mutation checks. The authorization endpoint accepts only the internal API host
from the configured Traefik address. Explicit Studio password login remains
available as a fallback and is independent of the Shelter browser session.

## Edge Functions

New instances include the pinned Supabase Edge Runtime. For an existing instance,
open its **Edge Functions** tab in Shelter and deploy its first function.
This briefly updates Studio and the API gateway while preserving the database,
files and credentials. Studio reads the shared function directory; the runtime
and its main router have separate read-only mounts.

Deploy a single-file TypeScript function from Shelter using a lowercase name,
for example `hello`, and its `index.ts` source. Deploying the same name replaces
that entrypoint atomically. The current editor accepts one file up to 256 KiB;
multi-file uploads, custom per-function secrets and Supabase Cloud CLI deployment
are not offered. Imports can use the runtime's normal module resolution.

Invoke it at `https://API_HOST/functions/v1/hello` with a valid Supabase JWT in
the `Authorization: Bearer …` header. User tokens and the legacy anon/service
keys are supported. JWT signature and expiry checks are mandatory; anonymous
requests are rejected, apart from CORS preflight. Authentication alone does not
authorize an application action: validate claims and inputs inside each function.

Function code runs with this instance's Supabase service credentials, can access
its database, and must be treated as trusted administrator code. It has no Docker
socket and no public host port. The runtime is limited to 512 MiB, each user
worker to 150 MiB and 30 seconds. HTTP functions are supported; WebSocket
upgrades are not. Code and router files are included in encrypted instance
backups. Existing backups without functions still restore normally.

The Shelter function workspace uses a locally bundled Monaco editor with
TypeScript diagnostics, Deno API hints, formatting, `.ts` import/download and
fullscreen mode. Use Ctrl/Cmd+Enter to deploy. Syntax is checked before the
request is queued; remote-module types are not fetched in the administrator's
browser, and editor diagnostics do not replace runtime testing. Source and
workers load from Shelter itself, without a CDN. Drafts remain in memory across
workspace tabs; leaving with unsaved edits prompts for confirmation. Importing
or resetting over an edited draft also requires confirmation. Download a draft
before closing the browser if it needs to be retained.


## Instance workspace and safe function delivery

Services is a compact overview. Open an instance for its Overview, Apps, Edge
Functions, Backups, Settings and Activity pages. Studio remains the full database,
Auth and Storage interface; Shelter owns provisioning and delivery.

The function list is synchronized from bounded, regular `index.ts` files on the
worker. Symlinks and oversized catalogs are rejected. Existing source and each
version are encrypted in Shelter's database, never included in instance listings
or broad job logs. Source/history endpoints require a browser session; mutations
also require CSRF. Personal API tokens cannot retrieve code or execute tests.

Updates carry the hash of the version the editor loaded. Changes from another
browser or from disk result in a conflict instead of an overwrite. The worker
loads a candidate in the pinned runtime before switching the entrypoint. This
executes top-level module code; administrators must treat their source as trusted.
Activation recycles the function worker pool. If activation fails, Shelter tries
to restore the previous entrypoint and reports whether recovery succeeded.
Versions can be loaded as a draft, compared with the active source, and deployed
again. Removed endpoints retain their encrypted history and can be recovered.

The test console invokes the active function using either the public anon key or
no token, never an implicit service-role key. Requests may change application
data. Responses are bounded to 64 KiB and request-window runtime logs to 16 KiB;
known instance credentials are redacted. Logs can include concurrent requests.
They are available only through the authenticated operation result, not general
instance listings. Interrupted test requests are marked failed and never replayed
automatically. Other operations are serialized and recover their persisted phase.

App connection status distinguishes applied settings, a subsequent deployment,
and a successful connectivity test from the owned app container's network
namespace. A successful test proves network reachability and key acceptance at
the Auth health endpoint; it does not prove application code uses Supabase or
that every RLS policy is correct. A new deployment, changed credentials or changed
configuration invalidates the previous connectivity result.

## Scheduled backups and external storage

Daily schedules use an explicit UTC hour and remain disabled until configured.
A busy or unavailable instance defers the scheduled backup. An optional weekly
restore test runs after a successful local backup when the previous successful
test is older than seven days. It needs capacity for an additional Supabase stack.
The test authenticates the archive, restores into isolated temporary volumes,
starts the services on internal-only Docker networks without public routing or external egress, and probes Auth before removing its
own containers, volumes and networks. The live instance and its data generation
are not switched. The UI distinguishes an available archive from a successful
restore test and a verified external copy.

S3-compatible storage is optional; the local encrypted archive is always kept.
Use a public HTTPS endpoint, region, bucket and scoped access key. Credentials are
encrypted and never returned by the API. Private, loopback and link-local network
destinations are rejected during connection lookup. The storage test writes,
checks and removes a uniquely named disposable object. Required permissions are
PutObject, GetObject/HeadObject and DeleteObject for the test, plus multipart upload
and abort permissions for large backups. The bucket must support SHA-256 object
checksums and checksum-enabled HEAD requests. Files over 32 MiB use bounded,
sequential multipart uploads. The worker verifies the stored checksum and size
before marking a copy verified. Failed uploads leave the local archive available
and can be retried from the backup row. External keys use
`shelter/<instance-id>/<backup-id>.enc`.

Keep the corresponding Shelter database and APP_SECRET in independent recovery
storage as well: an external encrypted archive alone is not a complete disaster
recovery kit. Verify restoration regularly and account for retained generations
and recovery points when planning disk capacity.

## Readiness and operational status

The setup page suggests connection addresses from the selected app and domain.
Advanced address overrides remain available. Connecting a project prepares its
configuration; the operator explicitly reviews and deploys the app afterwards.
A successful reachability check verifies access from its current runtime network,
not whether every application query or RLS policy is correct.

Before creation, Shelter checks recent worker-reported memory, storage, Docker,
worker status and available subnets in the configured Supabase pool. Unknown or
stale measurements are labelled as such. The worker repeats its authoritative
capacity checks when provisioning; a setup preview cannot reserve future free
memory or guarantee that a third party will not claim a hostname or subnet.

The overview separates instance health, app connection, outgoing email and data
protection. A running instance is not presented as fully backed up. Backup time,
external-copy verification and restore-test time are shown separately. Scheduled
backups and weekly restore tests remain opt-in because a backup briefly pauses the
instance and a restore test requires extra server resources. These are cold full
snapshots; they do not provide continuous PITR or high availability. A single VPS
remains a shared failure domain. For strict uptime or recovery objectives, deploy
an independently operated database/backup architecture rather than treating the
panel's readiness indicators as such a guarantee.
