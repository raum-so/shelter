// Template links contain permissions only, never credentials. Cloudflare still
// asks the operator to review account/zone resources before creating the token.
export function cloudflareTokenTemplateUrl(accountId = ''): string {
  const url = new URL('https://dash.cloudflare.com/profile/api-tokens');
  url.searchParams.set(
    'permissionGroupKeys',
    JSON.stringify([
      { key: 'account_settings', type: 'read' },
      { key: 'zone', type: 'read' },
      { key: 'dns', type: 'edit' },
      { key: 'argotunnel', type: 'edit' },
    ]),
  );
  url.searchParams.set(
    'accountId',
    /^[a-f0-9]{32}$/i.test(accountId) ? accountId : '*',
  );
  url.searchParams.set('zoneId', 'all');
  url.searchParams.set('name', 'Shelter');
  return url.toString();
}
