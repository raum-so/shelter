import { describe, expect, it } from 'vitest';
import { cloudflareRoutingChanged } from './cloudflare-form';

describe('Cloudflare setup navigation guard', () => {
  it('does not report unsaved edits for the suggested tunnel on a fresh installation', () => {
    expect(cloudflareRoutingChanged({ accountId: '', tunnelName: 'shelter', panelDomain: '' }, { accountId: '', tunnelName: null, panelDomain: null })).toBe(false);
  });
  it('protects real account, domain and tunnel edits while ignoring equivalent hostnames', () => {
    const initial = { accountId: 'a'.repeat(32), tunnelName: 'shelter', panelDomain: 'panel.example.com' };
    expect(cloudflareRoutingChanged({ ...initial, panelDomain: 'https://PANEL.example.com/' }, initial)).toBe(false);
    expect(cloudflareRoutingChanged({ ...initial, panelDomain: 'new.example.com' }, initial)).toBe(true);
    expect(cloudflareRoutingChanged({ ...initial, tunnelName: 'another' }, initial)).toBe(true);
    expect(cloudflareRoutingChanged({ ...initial, accountId: 'b'.repeat(32) }, initial)).toBe(true);
  });
});
