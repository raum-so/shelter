import { useSyncExternalStore } from 'react';

export interface BrandPalette { primary: string; background: string; foreground: string; surface: string }
export interface Branding {
  version: 1;
  name: string;
  claim: string;
  description: string;
  logoLayout: 'symbol' | 'wordmark';
  logoLight: string | null;
  logoDark: string | null;
  icon: string | null;
  light: BrandPalette;
  dark: BrandPalette;
  supportUrl: string;
  documentationUrl: string;
  privacyUrl: string;
  legalUrl: string;
  loginMessage: string;
  footer: string;
}
export interface BrandingState { profile: Branding; revision: string }
export const DEFAULT_BRANDING: Branding = {
  version: 1, name: 'Shelter', claim: 'give your code a home',
  description: 'Self-hosted deployments and domains on your own server.',
  logoLayout: 'symbol', logoLight: null, logoDark: null, icon: null,
  light: { primary: '#6652df', background: '#f5f7fc', foreground: '#17243b', surface: '#ffffff' },
  dark: { primary: '#705be8', background: '#061321', foreground: '#f3f5fc', surface: '#0a1c2e' },
  supportUrl: '', documentationUrl: '', privacyUrl: '', legalUrl: '', loginMessage: '', footer: '',
};
export let BRAND_NAME = DEFAULT_BRANDING.name;
export let BRAND_CLAIM = DEFAULT_BRANDING.claim;
export const SESSION_EXPIRED_EVENT = 'shelter:session-expired';
let state: BrandingState = { profile: DEFAULT_BRANDING, revision: '' };
const listeners = new Set<() => void>();
export const getBranding = () => state;
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function useBranding() { return useSyncExternalStore(subscribe, getBranding, getBranding); }
export function brandCopy(value: string): string {
  return value.replace(/\bShelter\b/g, () => state.profile.name).replaceAll('give your code a home', () => state.profile.claim);
}
export function setBranding(next: BrandingState): void {
  state = next;
  BRAND_NAME = next.profile.name;
  BRAND_CLAIM = next.profile.claim;
  if (typeof document !== 'undefined') {
    const profile = next.profile;
    const revision = encodeURIComponent(next.revision);
    document.title = `${profile.name}${profile.claim ? ` — ${profile.claim}` : ''}`;
    const values: Record<string, string> = {
      'application-name': profile.name, 'apple-mobile-web-app-title': profile.name,
      description: profile.description, 'og:site_name': profile.name,
      'og:title': document.title, 'og:description': profile.description,
      'theme-color': profile[document.documentElement.classList.contains('dark') ? 'dark' : 'light'].background,
    };
    for (const [key, value] of Object.entries(values)) {
      document.querySelector(`meta[name="${key}"],meta[property="${key}"]`)?.setAttribute('content', value);
    }
    for (const element of document.querySelectorAll<HTMLLinkElement>('link[rel="icon"],link[rel="apple-touch-icon"]')) {
      element.href = `/api/branding/assets/icon?v=${revision}`;
    }
    let theme = document.querySelector<HTMLLinkElement>('#branding-theme');
    if (!theme) {
      theme = document.createElement('link'); theme.id = 'branding-theme'; theme.rel = 'stylesheet';
      document.head.append(theme);
    }
    theme.href = `/api/branding/theme.css?v=${revision}`;
  }
  listeners.forEach((listener) => listener());
}
export async function loadBranding(): Promise<void> {
  const embedded = document.getElementById('platform-branding')?.textContent;
  if (embedded) {
    try { setBranding(JSON.parse(embedded) as BrandingState); return; } catch { /* Fetch if the bootstrap data is unavailable. */ }
  }
  try {
    const response = await fetch('/api/branding', { signal: AbortSignal.timeout(5000) });
    if (response.ok) setBranding(await response.json() as BrandingState);
  } catch { /* The default brand keeps the login available during API failures. */ }
}
