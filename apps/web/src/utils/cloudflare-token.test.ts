import { describe, expect, it } from 'vitest';
import { cloudflareTokenTemplateUrl } from './cloudflare-token';

describe('Cloudflare token template', () => {
  it('includes precisely the four Shelter permissions and restricts a known account', () => {
    const url = new URL(cloudflareTokenTemplateUrl('a'.repeat(32)));
    expect(url.origin).toBe('https://dash.cloudflare.com');
    expect(url.pathname).toBe('/profile/api-tokens');
    expect(url.searchParams.get('accountId')).toBe('a'.repeat(32));
    expect(JSON.parse(url.searchParams.get('permissionGroupKeys')!)).toEqual([
      { key: 'account_settings', type: 'read' },
      { key: 'zone', type: 'read' },
      { key: 'dns', type: 'edit' },
      { key: 'argotunnel', type: 'edit' },
    ]);
  });
  it('never includes arbitrary account input or credentials in the external URL', () => {
    const url = new URL(
      cloudflareTokenTemplateUrl('secret&redirect=https://evil.example'),
    );
    expect(url.searchParams.get('accountId')).toBe('*');
    expect(url.toString()).not.toContain('secret');
    expect(url.toString()).not.toContain('evil.example');
  });
});
