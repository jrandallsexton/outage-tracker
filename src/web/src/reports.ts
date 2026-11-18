import type { Home, Profile } from './profile';
import type { ReportBody } from './api';

export type PhotoKind = 'router_light' | 'isp_app' | 'outage_map' | 'other';
export const PHOTO_KINDS: { kind: PhotoKind; label: string; icon: string }[] = [
  { kind: 'router_light', label: 'Router light', icon: '🚨' },
  { kind: 'isp_app', label: 'ISP app screenshot', icon: '📱' },
  { kind: 'outage_map', label: 'Outage map screenshot', icon: '🗺️' },
  { kind: 'other', label: 'Other photo', icon: '📷' },
];
export const MAX_PHOTOS = 6;

/** The phone's own copy of a report (so "My reports" works offline). */
export interface LocalReport {
  id: string;
  home: Home;
  startedAt: string;
  endedAt: string | null;
  notes: string | null;
  withdrawn: boolean;
  photos: { id: string; kind: PhotoKind }[];
  /** A past outage reported without a length. It has no end time but is NOT still going. */
  endUnknown?: boolean;
}

const KEY = 'entrada.reports';
const KEEP = 60;

export function listReports(): LocalReport[] {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '[]'); } catch { return []; }
}

export function saveReport(r: LocalReport) {
  const all = listReports().filter((x) => x.id !== r.id);
  all.unshift(r);
  all.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  try { localStorage.setItem(KEY, JSON.stringify(all.slice(0, KEEP))); } catch { /* storage full/blocked */ }
}

/** The outage this phone reported that hasn't been marked as back yet. */
export const openReport = () => listReports().find((r) => !r.endedAt && !r.withdrawn && !r.endUnknown) ?? null;

export const toBody = (r: LocalReport, p: Profile): ReportBody => ({
  deviceId: p.deviceId,
  addressId: r.home.id,
  addressText: r.home.label,
  startedAt: r.startedAt,
  endedAt: r.endedAt,
  notes: r.notes,
  withdrawn: r.withdrawn,
});
