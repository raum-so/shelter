# External customer domains

Shelter can connect customer subdomains through a CNAME without taking over the
customer's DNS zone. Cloudflare for SaaS terminates HTTPS; the existing outbound
Cloudflare Tunnel and Traefik file provider route requests to the project.
No additional public VPS ports or Docker socket mounts are needed.

## Start in the project

Open **Project → Domains → Add domain → External customer domain**. Domains,
verification, HTTPS status, and API permissions belong to that project. The
shared Cloudflare setup is only shown as a prerequisite when needed. Following
that link opens the basic setup and returns you to the same project afterward.

## Operator setup

1. Connect Cloudflare to Shelter and deploy the target project successfully.
2. In **Settings → Cloudflare → Cloudflare for SaaS — basic setup**, choose
   **Set up Cloudflare for SaaS**. Shelter suggests its configured primary
   domain and the corresponding Cloudflare zone, for example `hosting.example.com`.
3. Enable **Cloudflare for SaaS** for that zone in Cloudflare. Review
   Cloudflare's current billing before enabling it.
4. Select the suggested primary hostname as the SaaS **fallback origin** and
   wait for its status to become active. Its existing proxied DNS record already
   points to this Shelter installation; no customer needs the tunnel hostname.
5. Shelter requests **SSL and Certificates Write** (`ssl-and-certificates.write`)
   in addition to its existing OAuth permissions. For an older connection, allow
   that scope in the registered OAuth client, then use **Reconnect Cloudflare**
   in Shelter. Keep the existing connection until its replacement is verified.
   API-token setup includes **SSL and Certificates Edit** in its template; scope
   it to this zone.
6. In Shelter, choose **Verify and save setup** (or **Save and return to project**
   when you started from a project).

You can keep using an existing dedicated fallback such as `connect.example.com`.
For a new dedicated fallback, create a proxied CNAME to this installation's
`<tunnel-id>.cfargotunnel.com`, then select it as the Cloudflare fallback. Those
DNS instructions are available under **DNS for a custom destination**. Existing
saved connection targets are never replaced with the suggested primary domain.

This shared setup is optional and remains collapsed until you open it. Configure
it once per Shelter installation, not once per project.

Shelter validates the active zone, fallback origin, proxy status, and exact
owned tunnel target. The primary domain can be the shared CNAME destination,
but it remains reserved for the panel and cannot be assigned to a project.
Shelter does not create or replace the provider's zone-wide
fallback, and it never changes customer DNS. You cannot change the saved target
while external domain bindings exist. Account and tunnel changes are also blocked
until those bindings are removed. To move installations or zones, plan a
migration; do not repoint a live fallback independently of Shelter.

See [Cloudflare setup](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/getting-started/),
[Cloudflare's tunnel architecture](https://developers.cloudflare.com/reference-architecture/design-guides/extending-cloudflares-benefits-to-saas-providers-end-customers/),
and [current plans](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/plans/).

## Connect a customer

Open a project's **Domains → Add domain → External customer domain** and enter a subdomain,
for example `portal.customer.com`. Shelter returns:

- a CNAME from that hostname to the configured connection target (normally the
  Shelter primary domain);
- a random TXT proof at `_shelter-verification.portal.customer.com`.

Set both at the customer's existing authoritative DNS provider. The customer's
CNAME must be **DNS-only**: proxied or flattened customer records hide the CNAME
and are not supported by this verification flow. Some DNS panels automatically
append the zone name; use the relative record name in those panels.

Keep the TXT proof until ownership has been confirmed. The CNAME must remain in
place. Shelter registers the exact custom hostname only after both records
match, then requests a domain-validated certificate using HTTP validation at
Cloudflare. If Cloudflare returns additional DNS validation instructions, they
appear alongside the other records. CAA restrictions and provider certificate
issuance can delay activation.

The domain list combines managed and customer domains. Expand a row for its DNS
instructions, connection progress and access settings. Ownership, CNAME,
certificate and deployment states are displayed separately.
The verifier uses public recursive DNS (`1.1.1.1` and `8.8.8.8`) rather than
the host's resolver, whose private overrides or negative cache can hide newly
created records. Operators can set `EXTERNAL_DOMAIN_DNS_SERVERS` to one to four
recursive DNS IP addresses, separated by spaces or commas. Outbound DNS to those
servers must be allowed. Public resolvers can still cache older answers until
their DNS TTL expires. **Check now** reports the remaining step after each check.
Traffic is enabled only when the exact Cloudflare hostname and its certificate
are active and the project has an active deployment with an internal port.
External routes redirect HTTP to HTTPS. The original Host header is preserved.

This first version supports explicit ASCII subdomains, including subdomains
under multi-part public suffixes. Apex domains, IP addresses, wildcard domains,
IDN input, customer-side proxying, and preview subdomain generation beneath an
external domain are not supported. Existing managed Cloudflare domains retain
their current behavior, including managed apex support. There is a limit of
1,000 external bindings per installation, independent of Cloudflare plan limits.

## Shared application or dedicated installation

Both modes use the same domain API:

- **Shared application:** attach several customer hostnames to one project.
  The application maps each approved request hostname to a customer and loads
  that customer's branding and data.
- **Dedicated installation:** create one project per customer and attach that
  customer's hostnames. Each project has independent deployments and runtime
  configuration.

Shelter stores the project/domain relationship. Your application stores customer
identity, branding and authorization. A hostname selects a customer context; it
is not authentication. Enforce customer membership on every data operation,
reject unknown hostnames, use host-scoped cookies and generate login, reset and
invitation links from stored approved domains. Trust forwarded headers only
through the configured proxy chain. Do not expose Shelter API credentials to
browser code. Adding a domain does not rewrite an application's own canonical
URL settings or create a customer deployment automatically.

## API integration

Create an API token with **Project domains only** and select the target project.
This token can read, create, verify and delete domains for that project and read
the connection target. It cannot deploy projects, change environment variables,
list other projects, or modify Cloudflare setup. Existing read/write token
presets remain compatible.

```http
POST /api/projects/{projectId}/domains
Authorization: Bearer <server-side-token>
Content-Type: application/json

{"hostname":"portal.customer.com","connection":"external"}
```

The response is HTTP 202 with `domain.id`, `domain.status`, and
`domain.external.records` (`type`, `name`, `value`). Repeating this request for
the same external hostname and project returns the existing binding and proof.
A hostname cannot belong to another project simultaneously.

- `GET /api/projects/{projectId}/domains`: list domains and verification details.
- `GET /api/projects/{projectId}/domains/{domainId}`: read one domain.
- `POST /api/projects/{projectId}/domains/{domainId}/verify`: check now; at most
  15 calls per minute per client. HTTP 200 reports the observed state, including
  pending validation or a provider error; it does not itself mean activation.
- `DELETE /api/projects/{projectId}/domains/{domainId}`: disable routing and
  delete the owned custom hostname/certificate, then return HTTP 200.

Without `connection`, creation uses the existing managed Cloudflare flow.
`zoneId` is not accepted for external connections; the operator selects it once.
The settings response also includes `suggestedZoneId` and `suggestedCnameTarget`,
derived from the current Shelter primary domain. These are suggestions, not an
activated connection. The OpenAPI document at `/api/openapi.json` describes the
request and response.

`domain.external.phase` is one of `ownership`, `dns`, `certificate`, `deployment`,
`active`, `removing`, or `error`. Only `domain.status === "active"` means routed.
The response also contains `ownershipVerified`, `dnsReady`, `hostnameStatus`,
`tlsStatus`, `lastCheckedAt` and `error`. Keep your application-side customer
mapping keyed by the returned domain ID; polling is sufficient, without webhooks.

## Recovery, removal and upgrades

A missing OAuth certificate grant produces a reconnect instruction before any
SaaS API call. A provider permission denial produces an actionable permission
error instead of a generic 502. A failed or reduced-consent login never replaces
the active connection. See [OAuth upgrade instructions](../README.md#upgrade-an-existing-oauth-connection).

Verification runs in the API process, which already holds Cloudflare credentials.
Persistent state and operation leases survive API restarts. Pending connections
are revisited about once per minute; active bindings about every five minutes.
Checks are serialized and bounded, so large queues can take longer.

A confirmed CNAME mismatch disables routing. A temporary DNS or provider outage
is recorded without deleting an established route. Removing a domain immediately
quarantines its route; failed provider cleanup stays visible and retries in the
background. Project deletion also removes its external custom hostnames. Customer
DNS records and the shared fallback are never deleted. A new binding receives a
new TXT proof, so a stale CNAME alone cannot establish ownership.

Only provider IDs received and saved by Shelter are managed. A custom hostname
already present in Cloudflare is not silently adopted. If the process loses the
response to a successful hostname creation, an orphan may need manual review in
Cloudflare. Verify the exact hostname, zone and origin before removing that
resource, then retry. Drifted custom origins are left untouched and reported.

Storage changes are additive: a separate external-domain table and an optional
project restriction on API tokens. Back up the database before upgrading. Before
rolling back to a version without external-domain support, remove these bindings
and revoke project-domain tokens on the newer version; older versions do not
understand their verification, cleanup or token restrictions. Existing projects,
domains, data and Docker volumes are preserved.

Before production rollout, test an explicitly disposable customer domain end to
end: DNS propagation, certificate issuance, original Host at the app, both
project layouts, removal and certificate cleanup. Local provider mocks do not
replace that live acceptance test.

