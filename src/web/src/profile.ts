import { api } from './api';
import { findAddress } from './addresses';

/** Where the resident lives. id is null for an address they typed in themselves. */
export interface Home { id: string | null; label: string }

/** Everything the phone remembers so the resident never has to set up again. */
export interface Profile { deviceId: string; code: string; home: Home | null }

const KEY = 'entrada.profile';
const COOKIE = 'entrada_home';
const REMEMBERED_AT = 'entrada.rememberedAt';

const uuid = () => crypto.randomUUID();
const safeGet = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const safeSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode etc. */ } };

function isProfile(p: unknown): p is Profile {
  const o = p as Profile;
  return !!o && typeof o.deviceId === 'string' && typeof o.code === 'string'
    && (o.home === null || (typeof o.home === 'object' && typeof o.home.label === 'string'));
}

function fromCookie(): Profile | null {
  const raw = document.cookie.split('; ').find((c) => c.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
  if (!raw) return null;
  try {
    const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
    const json = new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
    const p = JSON.parse(json);
    return isProfile(p) ? p : null;
  } catch { return null; }
}

/**
 * Load order: this browser's storage -> the server-set cookie (survives Safari's 7-day storage wipe)
 * -> a brand-new profile. Then a personal link (?home=...&code=...) can fill in or replace the address.
 */
export function loadProfile(): Profile {
  let p: Profile | null = null;
  try { const s = safeGet(KEY); if (s) { const j = JSON.parse(s); if (isProfile(j)) p = j; } } catch { /* corrupt */ }
  p ??= fromCookie();
  p ??= { deviceId: uuid(), code: '', home: null };

  const params = new URLSearchParams(location.search);
  const homeParam = params.get('home');
  const codeParam = params.get('code');
  let changed = false;
  if (codeParam) { p.code = codeParam; changed = true; }
  if (homeParam) {
    if (homeParam.startsWith('custom:')) { p.home = { id: null, label: homeParam.slice(7).trim() }; changed = true; }
    else { const a = findAddress(homeParam); if (a) { p.home = { id: a.id, label: a.label }; changed = true; } }
  }
  if (homeParam || codeParam) history.replaceState(null, '', location.pathname + location.hash);
  saveProfile(p, changed);
  return p;
}

/** Saves locally, and refreshes the server cookie when something changed or about once a month. */
export function saveProfile(p: Profile, changed = true) {
  safeSet(KEY, JSON.stringify(p));
  const last = Number(safeGet(REMEMBERED_AT) ?? 0);
  if (p.home && p.code && (changed || Date.now() - last > 30 * 86_400_000)) {
    api.remember(p).then(() => safeSet(REMEMBERED_AT, String(Date.now()))).catch(() => { /* try again next time */ });
  }
}

/** A link that sets up a phone in one tap. Handy to text to a family member or bookmark. */
export function personalLink(p: Profile): string {
  const params = new URLSearchParams();
  if (p.home) params.set('home', p.home.id ?? 'custom:' + p.home.label);
  if (p.code) params.set('code', p.code);
  return `${location.origin}/?${params}`;
}
