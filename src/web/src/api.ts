export class ApiError extends Error {
  constructor(public status: number, public code: string, public details: string[] = []) {
    super(`${status} ${code}${details.length ? ': ' + details.join(' ') : ''}`);
  }
  /** Worth trying again later: no connection, server or database waking up, or rate limited. */
  get retryable() { return this.status === 0 || this.status === 408 || this.status === 429 || this.status >= 500; }
}

export interface ReportBody {
  deviceId: string;
  addressId: string | null;
  addressText: string;
  startedAt: string;
  endedAt: string | null;
  notes: string | null;
  withdrawn: boolean;
}

async function call<T>(method: string, path: string, opts: { code?: string; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
  const ctrl = new AbortController();
  // A paused database can take most of a minute to wake up.
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 50_000);
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      signal: ctrl.signal,
      headers: {
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(opts.code ? { 'X-Neighborhood-Code': opts.code } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError(0, 'network');
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    let code = 'error', details: string[] = [];
    try { const j = await res.json(); code = j.error ?? code; details = j.details ?? []; } catch { /* no body */ }
    throw new ApiError(res.status, code, details);
  }
  return res.status === 204 ? (undefined as T) : (res.json() as Promise<T>);
}

export const api = {
  checkCode: (code: string) => call<void>('POST', '/api/check-code', { code, timeoutMs: 15_000 }),
  putReport: (id: string, code: string, body: ReportBody) => call<{ id: string }>('PUT', `/api/reports/${id}`, { code, body }),
  putPhoto: (reportId: string, photoId: string, code: string, deviceId: string, kind: string) =>
    call<{ uploadUrl: string }>('PUT', `/api/reports/${reportId}/photos/${photoId}`, { code, body: { deviceId, kind } }),
  remember: (data: unknown) => call<void>('POST', '/api/remember', { body: data, timeoutMs: 15_000 }),
  ping: () => call<void>('GET', '/api/ping'),
  summary: (days = 30) => call<Summary>('GET', `/api/summary?days=${days}`, { timeoutMs: 60_000 }),
};

export async function uploadBlob(url: string, blob: Blob): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, { method: 'PUT', headers: { 'x-ms-blob-type': 'BlockBlob', 'Content-Type': 'image/jpeg' }, body: blob });
  } catch {
    throw new ApiError(0, 'network');
  }
  if (!res.ok) throw new ApiError(res.status >= 500 ? res.status : 503, 'upload_failed');
}

export interface OutageEventDto { start: string; end: string | null; ongoing: boolean; homes: number; reports: number }
export interface Summary {
  generatedAt: string;
  days: number;
  totals: { outages: number; reportedDowntimeHours: number; largestOutageHomes: number };
  events: OutageEventDto[];
}
