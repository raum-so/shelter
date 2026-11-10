export const CLOUDFLARE_REQUIRED_OAUTH_SCOPES = [
  "account-settings.read",
  "zone.read",
  "dns.write",
  "argotunnel.write",
  "ssl-and-certificates.write"
] as const;

export function parseCloudflareScopes(value: string): string[] {
  return [...new Set(value.split(/\s+/).filter(Boolean))];
}

export function requestedCloudflareScopes(configured: string): string[] {
  // Older installations may explicitly configure the previous default list.
  return [...new Set([...CLOUDFLARE_REQUIRED_OAUTH_SCOPES, ...parseCloudflareScopes(configured), "offline_access"])];
}

export function missingCloudflareScopes(granted: readonly string[], configured: string): string[] {
  return requestedCloudflareScopes(configured).filter(scope => scope !== "offline_access" && !granted.includes(scope));
}
