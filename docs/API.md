# Shelter API

Shelter exposes the same project and deployment capabilities used by its web panel as an authenticated HTTP API. Every installation serves its own API and OpenAPI document.

## Discover the API

Control-plane updates are browser-session-only endpoints, excluded from the
personal-access-token contract: `GET /api/settings/updates` reads cached release
and host status, `POST /api/settings/updates/check` refreshes verified stable
release metadata, and `POST /api/settings/updates` accepts `{tag, fromVersion,
currentPassword, backupConfirmed: true}` and returns HTTP 202 with the queued
job. Both POST routes require CSRF. No API token scope grants access. See the
[operator setup and recovery instructions](RELEASES.md#updates-from-the-panel).

Replace `https://panel.example.com` with the public URL of your Shelter installation:

```text
https://panel.example.com/api
https://panel.example.com/api/openapi.json
```

The API currently follows the Shelter `1.0.0` contract. It is part of the MVP, so review release notes before upgrading automation across Shelter versions.

## Create an access token

1. Sign in to the Shelter panel.
2. Open **Settings → API & CLI**.
3. Choose **Create token**.
4. Give the token a purpose-specific name, choose its access level and expiration, then confirm with the current administrator password.
5. Copy the secret immediately. Shelter stores only its hash and cannot show it again.

Three access presets are available:

| Preset | Scopes |
| --- | --- |
| Read only | `projects:read` |
| Project domains only | `domains:write`, restricted to one selected project’s domain endpoints |
| Deploy & manage | `projects:read`, `projects:write`, `deployments:write`, `uploads:write`, `domains:write`, `environment:write` |

Tokens expire after at most 365 days. Revocation takes effect on the next request. Changing the administrator password revokes every active API token.

## Authenticate requests

Send the token in the standard Bearer header:

```sh
export SHELTER_URL=https://panel.example.com
export SHELTER_TOKEN='shelter_pat_v1_…'

curl --fail-with-body \
  --header "Authorization: Bearer $SHELTER_TOKEN" \
  "$SHELTER_URL/api/projects"
```

Use HTTPS for every remote Shelter installation. Never put a token in a URL, command argument, repository, image, build log, or issue. Store CI tokens in the CI provider's encrypted secret store and prefer one token per automation.

API-token requests do not use the browser's CSRF header. Browser sessions still require CSRF protection for mutations. Cloudflare and GitHub connection setup, access-token management, password changes, sign-out, server metrics, and project observability/runtime logs remain browser-session-only.

## Core workflows

### Analyze project files

`POST /api/projects/analyze` performs the same bounded, advisory source analysis used by the project form. It requires `projects:read` and accepts file facts rather than an archive:

```sh
curl --fail-with-body \
  --request POST \
  --header "Authorization: Bearer $SHELTER_TOKEN" \
  --header "Content-Type: application/json" \
  --data '{
    "files": [
      {"path":"package.json","content":"{\"scripts\":{\"build\":\"vite build\"},\"dependencies\":{\"react\":\"19.1.0\",\"vite\":\"7.0.0\"}}"},
      {"path":"src/main.tsx","size":1200,"content":"const origin = import.meta.env.VITE_API_ORIGIN"},
      {"path":"package-lock.json","size":42000}
    ]
  }' \
  "$SHELTER_URL/api/projects/analyze"
```

Requests are limited to 10,000 safe relative POSIX paths, 512 KiB of allowlisted text content, at most 64 KiB per supported source file, at most 384 KiB across source files, and a 4 MiB HTTP body. Lockfiles remain presence/size facts. Supported JavaScript, TypeScript, Astro, Vue, and Svelte source can include content for bounded environment-reference detection; tests, fixtures, generated trees, and unsupported source types remain presence-only. Content from real `.env` files is rejected; only explicit example/sample files may be inspected. Responses expose structured environment requirements, keys, source paths, and line numbers but never environment values or source snippets. The result also includes detected applications, framework and rendering mode, package manager, root, commands, output directory, port, confidence, and evidence. Workspace-root manifests and lockfiles should be included when analyzing a monorepo so the recommended commands match the eventual npm, pnpm, Yarn, or Bun build. Treat the result as a recommendation: Shelter validates the checked-out or extracted source again during deployment.

### Verify a token

```sh
curl --fail-with-body \
  --header "Authorization: Bearer $SHELTER_TOKEN" \
  "$SHELTER_URL/api/api-tokens/current"
```

### Create a project from public Git

```sh
curl --fail-with-body \
  --request POST \
  --header "Authorization: Bearer $SHELTER_TOKEN" \
  --header "Content-Type: application/json" \
  --data '{
    "name": "Example app",
    "repositoryUrl": "https://github.com/example/app.git",
    "branch": "main"
  }' \
  "$SHELTER_URL/api/projects/git"
```

GitHub App registration, staged replacement upgrades, repository selection, and project linking remain interactive, browser-session-only operations. Provider credentials and a pending replacement App cannot be managed with an API token. Automation can create a project from a public HTTPS Git source and redeploy an already configured GitHub-backed project.

### Deploy current source

```sh
curl --fail-with-body \
  --request POST \
  --header "Authorization: Bearer $SHELTER_TOKEN" \
  --header "Content-Type: application/json" \
  --data '{}' \
  "$SHELTER_URL/api/projects/prj_REPLACE/deploy"
```

The response contains a deployment ID. Poll its state and logs:

```sh
curl --fail-with-body \
  --header "Authorization: Bearer $SHELTER_TOKEN" \
  "$SHELTER_URL/api/deployments/dep_REPLACE"

curl --fail-with-body \
  --header "Authorization: Bearer $SHELTER_TOKEN" \
  "$SHELTER_URL/api/deployments/dep_REPLACE/logs?after=0"
```

Terminal deployment states are `ready`, `failed`, and `cancelled`.

Deployment responses include structured safety metadata:

- `failureKind` distinguishes timeouts, build failures, health-check failures, activation failures, worker interruptions, superseded builds, and user cancellation.
- `cancelRequestedAt` is set while cooperative cancellation is still stopping the active process and cleaning up.
- `rollbackStatus` and `rollbackDeploymentId` report whether Shelter automatically kept or restored the prior production deployment.

### Cancel a deployment

Queued and running deployments can be cancelled through the deployment resource:

```sh
curl --fail-with-body \
  --request POST \
  --header "Authorization: Bearer $SHELTER_TOKEN" \
  "$SHELTER_URL/api/deployments/dep_REPLACE/cancel"
```

Cancellation is cooperative. A running Docker or Git process is terminated and candidate resources are removed before the deployment reaches the terminal `cancelled` state. The short `switching` phase cannot be cancelled because Shelter is completing an atomic traffic transition.

### Roll back to a ready deployment

Rollback creates a new immutable deployment; it does not mutate deployment history:

```sh
curl --fail-with-body \
  --request POST \
  --header "Authorization: Bearer $SHELTER_TOKEN" \
  "$SHELTER_URL/api/deployments/dep_READY_VERSION/rollback"
```

The current production container stays online while the selected image is started and health-checked. Shelter switches routing only after the candidate is healthy.

### Replace uploaded source

Upload-based projects use a resumable ZIP workflow:

1. `POST /api/uploads` with the filename and exact byte size.
2. Split the file according to the returned `chunkSize`.
3. `PUT /api/uploads/{uploadId}/chunks/{index}` with each binary chunk.
4. `POST /api/uploads/{uploadId}/complete`.
5. `PUT /api/projects/{projectId}/source` with the completed `uploadId`.

Use the Shelter CLI for this workflow unless direct HTTP integration is required; it handles chunk sizing, cleanup, completion, and optional deployment waiting.

### Manage domains

List active Cloudflare zones with `GET /api/settings/cloudflare/zones`. Add a hostname with `POST /api/projects/{projectId}/domains` and remove it with `DELETE /api/projects/{projectId}/domains/{domainId}`. Domain mutations require a connected Cloudflare account and the `domains:write` scope.

For external customer subdomains, send `{"hostname":"portal.customer.com","connection":"external"}` to the same creation endpoint. The operator must first configure Cloudflare for SaaS in Settings. HTTP 202 returns DNS instructions in `domain.external.records`. Repeating creation for the same project and external hostname returns the existing binding. Poll `GET /api/projects/{projectId}/domains/{domainId}` or call `POST /api/projects/{projectId}/domains/{domainId}/verify`; activate your app-side domain mapping only after `domain.status` is `active`. `GET /api/projects/{projectId}/domains` returns all bindings and their verification details.

A **Project domains only** token is recommended for application integration. The token creation endpoint accepts `access: "domains"` with the required `projectId`, alongside the existing fields. Such tokens can only call that project's domain endpoints and read `GET /api/settings/external-domains`. The session-only `PUT /api/settings/external-domains` validates `{zoneId, cnameTarget}` without modifying the provider fallback. See [setup, both tenancy modes and recovery](EXTERNAL-DOMAINS.md).

Configure sharing and search visibility with:

```http
PUT /api/projects/{projectId}/domains/{domainId}/access
Content-Type: application/json

{
  "passwordProtectionEnabled": true,
  "password": "a separate shared site password",
  "accessSessionTtlHours": 168,
  "seoIndexing": false
}
```

`password` is required when protection is enabled for the first time and otherwise optional; omitting it preserves the current password. It must contain 8–256 characters. Session duration is 1–720 hours. Enabling protection always forces effective search indexing off. The response exposes only `passwordConfigured`, never the password hash.

`POST /api/projects/{projectId}/domains/{domainId}/access/revoke` invalidates every visitor cookie for that domain without changing the password. Both endpoints require `domains:write`.

### Inspect project observability in the administrator panel

The following read-only endpoints intentionally require the administrator's browser session and reject personal access tokens because application output can contain sensitive data:

- `GET /api/projects/{projectId}/observability?range=1h` returns the active production container's CPU, memory and configured limits, network rates, block I/O, uptime, restart count, OOM/health/status, concrete warning states, and at most 180 downsampled history points. Ranges are `15m`, `1h`, `6h`, `24h`, and `48h`.
- `GET /api/projects/{projectId}/runtime-logs?after=0&limit=500` returns bounded structured output for the active deployment only.
- `GET /api/projects/{projectId}/runtime-logs/stream?after=0` forwards newly persisted records over SSE. The worker collects Docker output at `METRICS_INTERVAL_SECONDS`, so this is near-live rather than instantaneous streaming. Connections are rate-limited and rotate after ten minutes.

Runtime output is separate from immutable build/deployment logs. Shelter keeps at most 5,000 lines per project within `METRICS_RETENTION_HOURS` and returns at most 500 at once. The worker redacts exact values of configured project environment variables before persistence. Applications can still print derived, encoded, split, or reformatted secrets, so review runtime logs as sensitive administrator data before sharing them. The API process never receives the Docker socket; only the worker performs the label-validated collection.

## Errors and rate limits

Errors use a stable JSON envelope:

```json
{
  "error": "Human-readable message",
  "code": "MACHINE_READABLE_CODE"
}
```

Typical status codes are:

| Status | Meaning |
| --- | --- |
| `400` | Invalid input |
| `401` | Missing, malformed, expired, or revoked token |
| `403` | Token lacks the required scope, or a browser session is required |
| `404` | Resource does not exist |
| `409` | Current project, upload, deployment, or domain state conflicts with the request |
| `429` | Rate limit exceeded |
| `502` | An upstream provider such as Cloudflare failed |

Clients should use the machine-readable `code`, apply bounded retries only to transient failures, and never retry validation or permission failures blindly.

## Shelter CLI

The [Shelter CLI](../apps/cli/README.md) lives in this monorepo as `@shelter/cli`.
Once its first npm release is published, install with `npm install --global
@shelter/cli` or use `npx --yes @shelter/cli --help`. Until then, build it locally:

```sh
npm ci
npm run build -w @shelter/cli
npm install --global ./apps/cli
shelter login --server https://panel.example.com
shelter projects --json
shelter commands --json
```

The CLI supports projects, configuration, production and preview environments,
upload creation/replacement, deployments, cancellation, rollback, build logs,
domains and domain access, previews, and API discovery. `shelter api METHOD
/api/path --input file.json` covers additional JSON workflows without waiting
for a dedicated command. Use `--input -` for sensitive JSON over stdin.

All requests retain the API's token scopes and session-only restrictions.
Provider setup, API-token management, passwords, server metrics, and runtime
observability still require the administrator panel. See the
[CLI guide](../apps/cli/README.md) for commands, exit behavior and agent examples.


## Platform branding

`GET /api/branding` publicly returns `{ profile, revision }` because the appearance
is also used before sign-in. It contains only versioned display fields, embedded
PNG images, colors and public links. Treat all branding fields as public.

Branding administration requires a browser session and CSRF protection; API tokens
cannot manage it. `GET /api/settings/branding/export` downloads only the profile.
`POST /api/settings/branding/validate` accepts `{ profile }`, validates an imported
version-1 profile and returns it without saving. `PUT /api/settings/branding`
accepts `{ profile, revision }`; `POST /api/settings/branding/reset` accepts
`{ revision }`. Use the current revision from `GET /api/branding`. A stale revision
returns `409 BRANDING_CONFLICT`; invalid fields or versions return `400 VALIDATION`.
All fields are validated and unknown fields are rejected. Changes do not alter
projects, credentials, hostnames, or provider resources.


## Managed Supabase

`GET /api/supabase` and `GET /api/supabase/:id` require `projects:read` and return
instance, job, and backup metadata without credentials. `POST /api/supabase`
requires both `projects:write` and `domains:write`, accepts `name`, `apiHostname`,
`studioHostname`, `siteUrl`, optional `redirectUrls`, and optional `smtp`, and
returns `202` with an instance and worker job ID.

`POST /api/supabase/:id/actions` requires `deployments:write`. Supply `action`
(`start`, `stop`, `backup`, `restore`, `rotate`, `rotate-keys`, or `archive`). Restore additionally
requires a same-instance, same-version completed `backupId`. Restore, archive, and `rotate-keys`
require `confirmation` equal to the instance name. `rotate` changes the Studio
password only; `rotate-keys` invalidates API keys and user sessions. Busy instances return `409`.

`POST /api/supabase/:id/credentials` requires an administrator browser session,
CSRF, and `currentPassword`. It rejects personal API tokens and returns a
non-cacheable sensitive response. `POST /api/supabase/:id/connections` requires
`environment:write`, `projects:write`, and `deployments:write`. It takes `projectId`,
optional `urlVariable`, `keyVariable`, `siteUrl`, and `replace`. Variable names default
to the app's detected framework. It persists a managed connection and prepares only
the public API URL and anon key; deployments are explicit. Exact app sign-in
redirects may require a queued Auth restart. `GET /api/supabase/connections` requires
`projects:read` and returns redacted connection status plus eligible app options.
`DELETE /api/supabase/:id/connections/:projectId` requires `environment:write` and
`projects:write`; it removes unchanged managed variables and preserves edited values.

Creation also accepts `connection: { projectId, urlVariable?, keyVariable?, replace? }`.
This requires `environment:write` in addition to the creation scopes. The app's active
website supplies `siteUrl` if omitted. The connection is reserved atomically with
the new instance and applied only after provisioning; conflicts reject the request.
See [app connections](SUPABASE.md#auth-and-application-configuration) for status,
reconnection, redirect and deployment behavior.

The same lifecycle is available through `shelter supabase-list`,
`supabase-instance`, `supabase-create`, `supabase-action`, and `supabase-connect`.
Use `--input -` for JSON containing SMTP credentials. See [Supabase operations](SUPABASE.md)
for network, backup, CLI compatibility, and production verification boundaries.


## Global SMTP

Global SMTP configuration, connection verification, test messages, and applying
settings require a browser session and CSRF for mutations. Personal API tokens
cannot read or change the global mail server. See [Global outgoing email](SMTP.md)
for request fields, revision checks, and instance-consumer behavior.

### Managed Edge Functions (browser session)

`POST /api/supabase/:id/functions` requires an authenticated Shelter browser
session and its CSRF token. The instance must be running and have no active
operation. An empty JSON object enables the pinned Edge Runtime on an existing
instance. `{ "name": "hello", "source": "Deno.serve(() => new Response('Hello'));" }`
queues a single-file TypeScript deployment. Names use lowercase letters,
digits, `_` and `-`, start with a letter, and cannot be `main`. Source is limited
to 256 KiB and encrypted while queued. The response is `202 { "jobId": "..." }`;
poll the instance's jobs for completion. This endpoint executes trusted
administrator code with that Supabase instance's service credentials; personal
API tokens cannot deploy functions. Invoke deployed functions at
`/functions/v1/:name` on the instance's API hostname with a valid Supabase Bearer
token. Function files are included in instance backups.


### Supabase workspace operations

Browser-session-only routes under `/api/supabase/:id` support `GET /functions`,
`POST /functions/refresh`, `GET /functions/:name?versionId=...`,
`POST /functions` (`name`, `source`, `expectedHash`), and
`DELETE /functions/:name` (`expectedHash`). A null expected hash creates a new
function; updates require the hash returned with the current source.
`POST /functions/:name/invoke` accepts `method`, `body`, `query` and
`auth: "anon" | "none"`. No service-role test mode is implicit.

`POST /connections/:projectId/check` tests from the app's owned network namespace.
`GET/PUT /backup-policy` manage `enabled`, `hourUtc`, `verifyWeekly`, `destination`
and optional S3 settings. `POST /backup-policy/check` checks the saved destination.
`POST /backups/:backupId/verify` runs an isolated restore test;
`POST /backups/:backupId/upload` retries an external copy.

All POST/PUT/DELETE operations require CSRF and return a queued `jobId` (policy
PUT returns the saved redacted policy). Read a test's bounded, private result
using `GET /operations/:jobId/result`. Instance job metadata includes the
operation kind, phase and timestamps. Source, request bodies, responses and
provider credentials are excluded from public job metadata. A failed action may
coexist with a healthy running instance. Do not automatically repeat an
interrupted function test: its application-side effects may already have happened.

### Administrator login with a second factor

For an administrator with two-factor authentication enabled, `POST /api/auth/login`
returns `{ "mfaRequired": true }` and a short-lived `shelter_mfa` HttpOnly cookie,
without creating an authenticated session. Submit the authenticator or recovery
code to `POST /api/auth/mfa/challenge` using that cookie to obtain the usual
session and CSRF token. Personal API tokens keep their existing scope model;
MFA enrollment and removal require an authenticated browser session and CSRF
protection. Enabling or disabling MFA revokes other sessions and personal tokens.
