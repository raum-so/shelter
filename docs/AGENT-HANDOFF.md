# Platform integration handoff

This document is the entry point for agents continuing the 0.8.x platform work.
Read the repository's `AGENTS.md` first. Do not infer publication or production
acceptance from a working source installation.

The user-facing changes and upgrade instructions are in the
[0.8.0 release notes](releases/0.8.0.md),
[0.8.1 release notes](releases/0.8.1.md), and
[0.8.2 release notes](releases/0.8.2.md).

## Release scope

The release candidate combines the tested source installation's changes:

- External customer subdomains, project-scoped domain API tokens, DNS ownership
  verification, Cloudflare for SaaS certificates, and project-first management.
- Cloudflare OAuth certificate permissions, safe reauthorization of older
  connections, current Access dashboard links, and typed empty HTTP mutations.
- Managed self-hosted Supabase, app connections, Studio access, Edge Functions,
  backup and recovery operations, and global SMTP with instance overrides.
- Administrator MFA and the local security-event history.
- Explicit project network capacity handling and bounded archive extraction.
- The shared neutral design system, responsive administration pages, and
  illustrative documentation screenshots.

These changes target the existing single-VPS architecture. They do not add
public container ports or give the API, Traefik, or cloudflared the Docker socket.
Only the worker controls Docker.

## Customer-domain contracts

See [external domains](EXTERNAL-DOMAINS.md) for the API and operator workflow.

### 0.8.1: automatic certificate-path exceptions

Version 0.8.1 adds an opt-in Single Redirect exception flow to the shared SaaS
setup. This is **not part of v0.8.0**. The automatic flow has been tested locally
with provider fixtures; it has not been installed or tested against live
provider mutations. The earlier live pilot used a manually approved Cloudflare
rule edit. Verify publication through the immutable GitHub release, separately
from this implementation and acceptance record.

`CloudflareAcmeRedirects` previews complete rule expressions, binds a five-minute
one-use token to the administrator session and connection, then patches only
approved rules after re-reading them. Preserve complete writable rule fields:
Cloudflare PATCH replaces a rule definition and is not an expression-only merge.
Do not replace the whole ruleset, introduce a WAF bypass or disable HTTPS. The
only excluded path prefix is `/.well-known/acme-challenge/`.

`dynamic-redirect.write` is requested only through the feature-specific OAuth
start option or to retain a previous grant. Do not add it to the universal
minimum scopes. Existing setup calls without a redirect preview remain
provider-read-only. Project-scoped API tokens cannot inspect or change rules.

Original rules are encrypted in `cloudflare.acme_redirect_backup.<zone-id>`
before the latest attempted update. Detected drift and unknown rule shapes stop
the flow. Partial writes remain in place; re-preview shows only remaining
exceptions. There is no documented provider CAS precondition, so avoid
concurrent Cloudflare edits and do not promise an atomic multi-rule update.
Bulk Redirects, Workers and other redirect sources still need operator review.

Local verification on 2026-11-26: `npm run check` passed, including the existing
installation/release checks, server/web/CLI suites and builds. The new setup
regression fails against the prior route (missing preview endpoint) and passes
with this implementation. Focused UI tests also cover permission failure during
inspection and during apply. These are local mocked-provider tests, not a live
Cloudflare acceptance test or evidence of publication/deployment.

The following contracts apply to both the published base and this extension.

- Domain management starts inside a project. Cloudflare for SaaS basic setup is
  shared across the installation and is requested only when needed.
- Customers use the configured Shelter primary hostname as their normal CNAME
  destination. The internal `cfargotunnel.com` target is not the customer-facing
  destination. A previously saved dedicated fallback remains supported.
- A customer keeps its authoritative DNS provider. Subdomains require an exact
  DNS-only CNAME. The apex extension accepts an ALIAS, ANAME or flattened CNAME
  at the registrable root. Shelter checks its public A and AAAA answers against
  the configured destination. In both modes the binding-specific TXT proof is
  required before provider registration. Shared Cloudflare edge addresses
  establish neither ownership nor an active custom hostname.
- A shared application maps approved hosts to its own tenants. A dedicated
  installation uses one project per customer. Shelter handles domains and
  routing; the application remains responsible for tenancy, branding, sessions,
  authorization, canonical URLs, and authentication callbacks.
- Routing needs verified ownership, matching DNS, an active custom hostname
  and certificate, and a deployable project. Never report a verify request's
  HTTP 200 as proof that a domain is active.
- Preserve ownership checks, provider IDs, quarantine on removal, and the
  additive database migration. Do not adopt unrelated Cloudflare resources.

## OAuth and HTTP lessons

`apps/server/src/lib/cloudflare-scopes.ts` is the minimum OAuth scope source.
It includes `ssl-and-certificates.write`; an old explicit environment scope list
must not omit this minimum. The registered Cloudflare OAuth client must also
allow that scope. Existing grants need new consent; changing a configuration
string does not upgrade a token.

The UI identifies missing permissions and stages a replacement connection.
Reject explicitly reduced grants before staging or activation. Keep the active
connection when authorization fails. The request's stored scopes are used only
when the provider omits the token response's `scope`, as allowed by OAuth.

An empty mutation can reach Fastify with transfer framing through the tunnel and
fail with HTTP 415 before the handler. The shared web API request helper sends
typed JSON `null` for mutations without arguments. Preserve real JSON bodies,
FormData, binary uploads, CSRF headers, and read-only request behavior. Do not
repair this by disabling content-type validation or accepting arbitrary bodies.

Customer-domain DNS checks deliberately use public recursive resolvers. A pilot
failure showed a correct public TXT proof hidden by the host resolver's negative
cache. `EXTERNAL_DOMAIN_DNS_SERVERS` selects up to four resolver IPs; the default
is Cloudflare and Google public DNS. Do not replace this with an unbounded lookup
or weaken the exact TXT and subdomain CNAME checks. The apex mode is stored per
binding. Existing rows default to `cname` through an additive migration. An apex
registration may expose a second TXT record from Cloudflare for hostname
validation. A manual check that overlaps the background
checker is reported as in progress, rather than as a failed verification.

## Evidence and remaining acceptance

The apex extension was tested on 2026-11-26 with the existing Cloudflare SaaS
fallback and tunnel. A disposable apex with a DNS-only flattened CNAME
returned the fallback's IPv4 and IPv6 addresses. A second hostname in that
zone used a regular DNS-only CNAME. The candidate performed the TXT and DNS
checks, created the exact custom hostnames and exposed the additional
Cloudflare TXT proof for apex ownership. Both provider hostnames and
certificates reached active. A temporary app reached through the existing
Tunnel and Traefik responded with HTTP 200 and received each original Host
header, with normal certificate verification enabled. The test DNS records
and custom hostnames were removed. The candidate ran against an isolated
database and a temporary router, with no production version update. ALIAS and
ANAME were covered at the address-verification boundary. The live DNS test
used Cloudflare's CNAME flattening.

The source pilot was checked on 2026-11-10:

- Cloudflare client permission update, browser consent, and adoption of the new
  connection succeeded with the existing account, tunnel, and primary hostname.
- The browser connection test reported a healthy tunnel and an active connector.
- Cloudflare for SaaS fallback verification succeeded and basic setup persisted
  as ready for customer domains.
- API and worker health, SQLite integrity, and the existing tunnel identity were
  verified after installation. This does not certify unrelated Access policies.
- Local regression suites cover DNS and provider failure states, scoped tokens,
  both project layouts, OAuth upgrades, and the HTTP 415 regression.
- The opt-in `npm run test:supabase` suite passed all three real Docker cases,
  including RLS, Studio/API protection, credential rotation, Edge Functions,
  encrypted data recovery, and isolated restore networking. An invalid candidate
  can exhaust the bounded runtime request; that path now reports
  `FUNCTION_VALIDATION_FAILED`, preserves cleanup, and does not replace the
  active function. Do not turn a validation timeout into a successful upload.

An operator-requested live customer binding passed TXT ownership and CNAME
verification after the public-DNS fix. An existing blanket HTTP redirect then
blocked the ACME validation paths. After the operator approved a narrow path
exception, both validation URLs returned HTTP 200 with the expected tokens.
Cloudflare's hostname and certificate reached `active`, Shelter displayed all
four readiness steps, and the application loaded at the customer hostname with
valid HTTPS and HTTP 200. No application deployment was needed for activation.

Do not remove that live binding for testing. Application-specific tenant
isolation, both deployment layouts, and removal/cleanup still need their own
acceptance evidence. Use explicitly authorized disposable resources for
destructive tests; do not describe mocked provider tests as that end-to-end
acceptance.

## Continue safely

- Envoy's internal Basic-auth filter currently accepts only `{SHA}` htpasswd
  entries. The Studio credential is generated with 24 cryptographically random
  bytes on creation and rotation; it is never a human-selected password. The
  SHA-1 digest is a compatibility verifier inside the isolated instance gateway,
  not Shelter's administrator password storage or a signature. Do not allow
  user-chosen Studio credentials with this verifier. See the
  [Envoy filter documentation](https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_filters/basic_auth_filter).
  Administrator passwords retain the separate scrypt-based authentication path.
  The Studio proxy also hashes two in-memory Authorization values to a fixed
  length solely for `timingSafeEqual`; these digests are neither stored nor used
  as password verifiers. CodeQL's password-storage findings for these locations
  were reviewed with these data flows and recorded as false positives, without
  disabling either scanner rule.
- Read [Supabase operations](SUPABASE.md), [SMTP](SMTP.md), and
  [the security model](../SECURITY.md) before changing managed services or MFA.
- Keep source-checkout and published-release deployments distinct. Local source
  directories can contain unrelated work and server-specific Compose overrides;
  do not copy them wholesale into a release or overwrite another worktree.
- Commit coherent changes, run the complete check on the combined candidate,
  and use [the release flow](RELEASES.md). Promote through `dev`; never tag a
  feature branch or move an already published tag.
- CI limits server and web test workers to two so hosted-runner CPU discovery
  cannot create an unbounded memory load. Keep the full suites and isolation;
  do not replace a hanging integration gate with skipped tests.
- Update this handoff with evidence when the missing customer-domain acceptance
  is completed. Published versions are identified by immutable GitHub releases,
  their tags, and verified manifests, not by this document's intended version.
