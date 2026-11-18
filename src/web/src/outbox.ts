import { api, ApiError, uploadBlob, type ReportBody } from './api';

/**
 * Offline queue. Every report change and photo is saved on the phone first (IndexedDB), and sent when possible.
 * People report while their home internet is down, so they may be on weak cellular or offline.
 * Report sends are "here is the full current state", so re-sending after a failure is harmless.
 */

interface ReportOp { key: string; kind: 'report'; reportId: string; body: ReportBody; queuedAt: number }
interface PhotoOp { key: string; kind: 'photo'; reportId: string; photoId: string; photoKind: string; blob: Blob; queuedAt: number }
type Op = ReportOp | PhotoOp;

export interface OutboxStatus { pending: number; sending: boolean; problems: string[]; badCode: boolean }

const DB_NAME = 'entrada-outbox';
const STORE = 'ops';
const PROBLEMS_KEY = 'entrada.problems';
let dbPromise: Promise<IDBDatabase> | null = null;
let creds: () => { code: string; deviceId: string } = () => ({ code: '', deviceId: '' });
let running = false;
let again = false; // something was queued while a send was in progress
let retryTimer: number | undefined;
let backoffMs = 5_000;
let badCode = false;

function db(): Promise<IDBDatabase> {
  return dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'key' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = fn(d.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
const allOps = () => tx<Op[]>('readonly', (s) => s.getAll() as IDBRequest<Op[]>);
const getOp = (key: string) => tx<Op | undefined>('readonly', (s) => s.get(key) as IDBRequest<Op | undefined>);
const putOp = (op: Op) => tx('readwrite', (s) => s.put(op));
const delOp = (key: string) => tx('readwrite', (s) => s.delete(key));

function problems(): string[] { try { return JSON.parse(localStorage.getItem(PROBLEMS_KEY) ?? '[]'); } catch { return []; } }
function addProblem(msg: string) { try { localStorage.setItem(PROBLEMS_KEY, JSON.stringify([...problems(), msg].slice(-5))); } catch { /* */ } }
export function clearProblems() { try { localStorage.removeItem(PROBLEMS_KEY); } catch { /* */ } notify(); }

async function notify() {
  const pending = (await allOps().catch(() => [])).length;
  const status: OutboxStatus = { pending, sending: running, problems: problems(), badCode };
  window.dispatchEvent(new CustomEvent<OutboxStatus>('outbox', { detail: status }));
}

export async function queueReport(reportId: string, body: ReportBody) {
  await putOp({ key: `report:${reportId}`, kind: 'report', reportId, body, queuedAt: Date.now() });
  kick();
}

export async function queuePhoto(reportId: string, photoId: string, photoKind: string, blob: Blob) {
  await putOp({ key: `photo:${photoId}`, kind: 'photo', reportId, photoId, photoKind, blob, queuedAt: Date.now() });
  kick();
}

/** Try to send everything now. */
export function kick() { backoffMs = 5_000; clearTimeout(retryTimer); void sync(); }

/** Call after the resident enters a new neighborhood code. */
export function codeFixed() { badCode = false; kick(); }

async function sync() {
  if (running) { again = true; return; }
  running = true;
  again = false;
  let stopped = false; // hit a retryable error or bad code: don't immediately loop again
  await notify();
  try {
    const ops = (await allOps()).sort((a, b) => (a.kind === b.kind ? a.queuedAt - b.queuedAt : a.kind === 'report' ? -1 : 1));
    const pendingReports = new Set(ops.filter((o) => o.kind === 'report').map((o) => o.reportId));
    const { code, deviceId } = creds();

    for (const op of ops) {
      try {
        if (op.kind === 'report') {
          await api.putReport(op.reportId, code, op.body);
          pendingReports.delete(op.reportId);
        } else {
          if (pendingReports.has(op.reportId)) continue; // the report itself has to arrive first
          const { uploadUrl } = await api.putPhoto(op.reportId, op.photoId, code, deviceId, op.photoKind);
          await uploadBlob(uploadUrl, op.blob);
        }
        // Only remove it if it wasn't replaced by a newer version while we were sending.
        const latest = await getOp(op.key);
        if (latest && latest.queuedAt === op.queuedAt) await delOp(op.key);
        backoffMs = 5_000;
      } catch (e) {
        const err = e instanceof ApiError ? e : new ApiError(0, 'unknown');
        if (err.status === 401) { badCode = true; stopped = true; break; }
        if (err.retryable) { scheduleRetry(); stopped = true; break; }
        // The server rejected it for good (bad data, someone else's report, ...). Don't retry forever.
        await delOp(op.key);
        addProblem(op.kind === 'report'
          ? `A report couldn't be saved (${err.details.join(' ') || err.code}).`
          : `A photo couldn't be saved (${err.code}).`);
      }
    }
  } finally {
    running = false;
    await notify();
  }
  if (again && !stopped) void sync();
}

function scheduleRetry() {
  clearTimeout(retryTimer);
  retryTimer = window.setTimeout(() => void sync(), backoffMs);
  backoffMs = Math.min(backoffMs * 2, 120_000);
}

export function startOutbox(getCreds: () => { code: string; deviceId: string }) {
  creds = getCreds;
  window.addEventListener('online', kick);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') kick(); });
  // Ask the browser not to clear our storage when space runs low (Android/Chrome honors this).
  navigator.storage?.persist?.().catch(() => { /* not supported */ });
  kick();
}
