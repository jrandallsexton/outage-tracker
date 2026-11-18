import './styles.css';
import { api, ApiError, type Summary } from './api';
import { searchAddresses, findAddress } from './addresses';
import { loadProfile, saveProfile, personalLink, type Home } from './profile';
import { listReports, saveReport, openReport, toBody, PHOTO_KINDS, MAX_PHOTOS, type LocalReport, type PhotoKind } from './reports';
import { startOutbox, queueReport, queuePhoto, kick, codeFixed, clearProblems, type OutboxStatus } from './outbox';
import { compressPhoto } from './photos';
import { readPhotoMeta, type TimeSource } from './phototime';
import { esc, fmtTime, fmtDay, fmtWhen, fmtDuration, toLocalInput, fromLocalInput, sameDay } from './format';

// ---------------------------------------------------------------- state
const profile = loadProfile();
const app = document.getElementById('app')!;
let outbox: OutboxStatus = { pending: 0, sending: false, problems: [], badCode: false };
let editing: 'start' | 'end' | null = null;
let confirmWithdraw = false;
let draftHome: Home | null = null;          // setup screen selection
let pastPhotos: { id: string; kind: PhotoKind; blob: Blob; url: string }[] = [];
let photoKind: PhotoKind = 'other';
let summary: Summary | null = null;
let summaryError = false;
let installPrompt: (Event & { prompt(): Promise<void> }) | null = null;
const thumbs = new Map<string, string>();    // photoId -> object URL, this session only

/** Photo import: one draft per outage found in the picked photos. Lives in memory until saved. */
interface DraftPhoto { id: string; kind: PhotoKind; blob: Blob; url: string; takenAt: Date | null; source: TimeSource | null }
interface Draft { key: string; include: boolean; start: string; h: string; m: string; photos: DraftPhoto[]; dropped: number; note: string | null }
let drafts: Draft[] = [];
let importing = false;
const MAX_AGE_DAYS = 365;
const GROUP_GAP_MS = 45 * 60_000; // same rule the server uses to group neighbors' reports

type Route = 'setup' | 'home' | 'past' | 'import' | 'summary';
function route(): Route {
  const h = location.hash.slice(1);
  if (h === 'summary') return 'summary';
  if (!profile.code || !profile.home || h === 'setup') return 'setup';
  if (h === 'import') return 'import';
  return h === 'past' ? 'past' : 'home';
}

// ---------------------------------------------------------------- rendering
function render() {
  const r = route();
  document.body.dataset.route = r;
  app.innerHTML = r === 'setup' ? setupView() : r === 'past' ? pastView() : r === 'import' ? importView()
    : r === 'summary' ? summaryView() : homeView();
  if (r === 'setup') bindSetup();
  if (r === 'summary' && !summary) void loadSummary();
  updateSync();
}

const header = (extra = '') => `
  <header class="top">
    <h1><img src="/icon-192.png" alt="" class="logo">Entrada Outages</h1>
    ${extra}
  </header>`;

function homeChip() {
  return profile.home ? `<a href="#setup" class="home-chip">📍 ${esc(profile.home.label)} <span>Change</span></a>` : '';
}

function homeView(): string {
  const open = openReport();
  const recent = listReports().slice(0, 6);
  return `${header(homeChip())}
  <main>
    ${banners()}
    ${open ? openCard(open) : `
      <button class="big down" data-action="down">My internet is DOWN<small>One tap. Starts the clock now.</small></button>
      <p class="center"><a href="#past">Report an earlier outage</a></p>`}
    <p id="sync" class="sync"></p>
    ${installCard()}
    ${recent.length ? `<section class="card"><h2>My recent reports</h2><ul class="reports">${recent.map(reportItem).join('')}</ul></section>` : ''}
    <footer class="foot">
      <a href="#summary">📊 Neighborhood outage summary</a>
      <button class="link" data-action="share-link">🔗 Share my setup link</button>
    </footer>
  </main>
  <input type="file" id="file" accept="image/*" multiple hidden>`;
}

function banners(): string {
  let html = '';
  if (outbox.badCode) html += `<div class="banner warn">The neighborhood code was not accepted. Your reports are saved on this phone.
    <a href="#setup">Enter the current code</a></div>`;
  if (outbox.problems.length) html += `<div class="banner warn">${outbox.problems.map(esc).join('<br>')}
    <button class="link" data-action="dismiss-problems">Dismiss</button></div>`;
  return html;
}

function openCard(r: LocalReport): string {
  const ms = Date.now() - new Date(r.startedAt).getTime();
  const stale = ms > 12 * 3_600_000;
  return `<section class="card open">
    <p class="state-down"><span class="dot"></span>Internet down</p>
    <p class="since">Since <strong>${fmtWhen(r.startedAt)}</strong> · <span id="elapsed">${fmtDuration(ms)}</span></p>
    ${stale ? `<p class="hint">Still down after ${fmtDuration(ms)}? If it came back, use “Came back earlier”.</p>` : ''}
    <button class="big ok" data-action="back">It's BACK</button>
    ${editing ? timeEditor(r) : `<div class="row">
        <button class="secondary" data-action="edit-start">Started earlier?</button>
        <button class="secondary" data-action="edit-end">Came back earlier?</button>
      </div>`}
    ${photoBlock(r.photos.map((p) => ({ id: p.id, kind: p.kind, url: thumbs.get(p.id) })))}
    <p class="center"><button class="link danger" data-action="withdraw">${confirmWithdraw ? 'Tap again to remove this report' : 'Reported by mistake?'}</button></p>
  </section>`;
}

function timeEditor(r: LocalReport): string {
  const isStart = editing === 'start';
  const value = toLocalInput(isStart ? new Date(r.startedAt) : new Date());
  return `<div class="time-edit">
    <label>${isStart ? 'It went down at' : 'It came back at'}
      <input type="datetime-local" id="time-input" value="${value}" max="${toLocalInput(new Date())}"></label>
    <div class="row">
      <button class="primary" data-action="save-time">Save</button>
      <button class="secondary" data-action="cancel-time">Cancel</button>
    </div>
    <p id="time-msg" class="msg"></p>
  </div>`;
}

function photoBlock(photos: { id: string; kind: PhotoKind; url?: string }[]): string {
  const full = photos.length >= MAX_PHOTOS;
  return `<div class="photos">
    <p class="label">Add proof <span class="muted">(optional)</span></p>
    ${full ? `<p class="hint">That's the maximum of ${MAX_PHOTOS} photos.</p>` : `<div class="photo-buttons">
      ${PHOTO_KINDS.map((k) => `<button class="chip" data-action="add-photo" data-kind="${k.kind}">${k.icon} ${esc(k.label)}</button>`).join('')}
    </div>`}
    ${photos.length ? `<ul class="thumbs">${photos.map((p) => `<li>${p.url ? `<img src="${p.url}" alt="">` : '<span class="thumb-ph">🖼️</span>'}
      <small>${esc(PHOTO_KINDS.find((k) => k.kind === p.kind)?.label ?? 'Photo')}</small></li>`).join('')}</ul>` : ''}
  </div>`;
}

function reportItem(r: LocalReport): string {
  const start = new Date(r.startedAt);
  const tag = r.withdrawn ? '<span class="tag">removed</span>' : !r.endedAt && !r.endUnknown ? '<span class="tag down">ongoing</span>' : '';
  const span = r.endedAt
    ? `${fmtTime(start)}–${fmtTime(r.endedAt)}${sameDay(start, new Date(r.endedAt)) ? '' : ` (${fmtDay(r.endedAt)})`} · ${fmtDuration(new Date(r.endedAt).getTime() - start.getTime())}`
    : `${fmtTime(start)}${r.endUnknown ? ' · length not given' : ''}`;
  return `<li class="${r.withdrawn ? 'withdrawn' : ''}"><strong>${fmtDay(start)}</strong> ${span}
    ${r.photos.length ? ` · ${r.photos.length} photo${r.photos.length > 1 ? 's' : ''}` : ''} ${tag}</li>`;
}

function installCard(): string {
  const standalone = matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone;
  if (standalone || localStorage.getItem('entrada.installDismissed')) return '';
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent);
  if (!ios && !installPrompt) return '';
  return `<section class="card install">
    <p><strong>Put this on your home screen</strong> so reporting is one tap away and your address is never forgotten.</p>
    ${ios ? '<p class="hint">In Safari, tap the Share button <span aria-hidden="true">⎋</span>, then <strong>Add to Home Screen</strong>.</p>'
          : '<button class="primary" data-action="install">Install app</button>'}
    <button class="link" data-action="dismiss-install">Not now</button>
  </section>`;
}

function setupView(): string {
  const complete = !!(profile.code && profile.home);
  draftHome ??= profile.home;
  return `${header()}
  <main class="setup">
    <p class="lead">Set up once. After that, reporting an outage takes one tap.</p>
    <section class="card">
      <h2>1. Neighborhood code</h2>
      <p class="hint">It's in the HOA email or flyer. It keeps the tracker for Entrada residents.</p>
      <input id="code" value="${esc(profile.code)}" autocomplete="off" autocapitalize="characters" spellcheck="false" aria-label="Neighborhood code">
      <p id="code-msg" class="msg"></p>
    </section>
    <section class="card">
      <h2>2. Your address</h2>
      <p id="picked" class="picked">${draftHome ? `✓ ${esc(draftHome.label)}` : 'Type your house number or street:'}</p>
      <input id="addr-q" type="search" placeholder="e.g. 3283 or Baravaldo" autocomplete="off" aria-label="Search addresses">
      <ul id="addr-results" class="results"></ul>
      <button class="link" data-action="custom-toggle">My address isn't listed</button>
      <div id="custom" hidden>
        <input id="custom-text" placeholder="House number and street" maxlength="160" aria-label="Your address">
        <button class="secondary" data-action="custom-use">Use this address</button>
      </div>
    </section>
    <button class="big primary" data-action="setup-save">Save</button>
    <p id="setup-msg" class="msg center"></p>
    ${complete ? '<p class="center"><a href="#">Cancel</a></p>' : ''}
    <p class="center"><a href="#summary">View the neighborhood outage summary</a></p>
  </main>`;
}

function bindSetup() {
  const q = document.getElementById('addr-q') as HTMLInputElement;
  const list = document.getElementById('addr-results')!;
  q.addEventListener('input', () => {
    const hits = searchAddresses(q.value);
    list.innerHTML = hits.map((a) => `<li><button data-action="pick" data-id="${a.id}">${esc(a.label)}</button></li>`).join('')
      || (q.value.trim() ? '<li class="muted">No match. Check the spelling, or use “My address isn\'t listed”.</li>' : '');
  });
}

function pastView(): string {
  const start = new Date(Date.now() - 3_600_000);
  return `${header(homeChip())}
  <main>
    <section class="card import-cta">
      <h2>Have photos or screenshots?</h2>
      <p class="hint">Pick them all at once. The app reads when each was taken and groups them into outages for you to check.</p>
      <button class="big primary" data-action="import-pick">📷 Report outages from photos</button>
    </section>
    <section class="card">
      <h2>Or enter an outage by hand</h2>
      <label>When did it go down?
        <input type="datetime-local" id="p-start" value="${toLocalInput(start)}" max="${toLocalInput(new Date())}"></label>
      <label>How long did it last? <span class="muted">(optional)</span></label>
      <div class="row dur">
        <input type="number" id="p-h" min="0" max="336" inputmode="numeric" placeholder="0" aria-label="Hours"> h
        <input type="number" id="p-m" min="0" max="59" inputmode="numeric" placeholder="0" aria-label="Minutes"> min
      </div>
      <label class="check"><input type="checkbox" id="p-still"> It's still down</label>
      <label>Notes <span class="muted">(optional)</span>
        <textarea id="p-notes" maxlength="500" rows="2"></textarea></label>
      <div id="past-photos">${photoBlock(pastPhotos)}</div>
      <button class="big primary" data-action="past-save">Save report</button>
      <p id="past-msg" class="msg center"></p>
      <p class="center"><a href="#">Cancel</a></p>
    </section>
  </main>
  <input type="file" id="file" accept="image/*" multiple hidden>
  <input type="file" id="bulk-file" accept="image/*" multiple hidden>`;
}

// ---------------------------------------------------------------- photo import

const SOURCE_TEXT: Record<TimeSource, string> = { exif: 'time from photo', xmp: 'time from screenshot', file: 'time from file date (check it)' };

function importView(): string {
  if (importing) return `${header(homeChip())}<main><p class="center muted">Reading photos…</p></main>`;
  if (!drafts.length) return `${header(homeChip())}<main><section class="card"><p>No photos picked yet.</p>
    <button class="big primary" data-action="import-pick">📷 Pick photos</button>
    <p class="center"><a href="#">Back</a></p></section></main>
    <input type="file" id="bulk-file" accept="image/*" multiple hidden>`;
  const included = drafts.filter((d) => d.include).length;
  return `${header(homeChip())}
  <main>
    <h2 class="page-title">${drafts.length === 1 ? 'Found 1 outage' : `Found ${drafts.length} outages`}</h2>
    <p class="hint">Photos taken within 45 minutes of each other count as one outage. Check the times, add how long it lasted if you know, then save.</p>
    ${drafts.map(draftCard).join('')}
    <button class="secondary wide" data-action="import-pick">➕ Add more photos</button>
    <button class="big primary" data-action="import-save" ${included ? '' : 'disabled'}>Save ${included} outage${included === 1 ? '' : 's'}</button>
    <p id="import-msg" class="msg center"></p>
    <p class="center"><button class="link" data-action="import-cancel">Cancel</button></p>
  </main>
  <input type="file" id="bulk-file" accept="image/*" multiple hidden>`;
}

function draftCard(d: Draft): string {
  const src = d.photos.find((p) => p.takenAt)?.source;
  return `<section class="card draft ${d.include ? '' : 'excluded'}" data-key="${d.key}">
    <label class="check"><input type="checkbox" data-draft="include" ${d.include ? 'checked' : ''}> Include this outage</label>
    ${d.note ? `<p class="banner warn">${esc(d.note)}</p>` : ''}
    <label>Went down at
      <input type="datetime-local" data-draft="start" value="${d.start}" max="${toLocalInput(new Date())}"></label>
    <p class="hint">${src ? esc(SOURCE_TEXT[src]) : '<strong>No time found in these photos.</strong> Please enter it.'}</p>
    <label>Lasted <span class="muted">(optional)</span></label>
    <div class="row dur">
      <input type="number" data-draft="h" min="0" max="336" inputmode="numeric" placeholder="0" value="${esc(d.h)}" aria-label="Hours"> h
      <input type="number" data-draft="m" min="0" max="59" inputmode="numeric" placeholder="0" value="${esc(d.m)}" aria-label="Minutes"> min
    </div>
    <ul class="thumbs">${d.photos.map((p) => `<li><img src="${p.url}" alt="">
      <select data-photo="${p.id}" aria-label="What this photo shows">${PHOTO_KINDS.map((k) =>
        `<option value="${k.kind}" ${k.kind === p.kind ? 'selected' : ''}>${esc(k.label.replace(' screenshot', ''))}</option>`).join('')}</select>
      ${p.takenAt ? `<small>${fmtTime(p.takenAt)}</small>` : ''}</li>`).join('')}</ul>
    ${d.dropped ? `<p class="hint">Only ${MAX_PHOTOS} photos fit in one report; ${d.dropped} more were left out.</p>` : ''}
    <p class="center"><button class="link danger" data-action="import-remove" data-key="${d.key}">Remove</button></p>
  </section>`;
}

/** Copy what the resident typed into the drafts before anything redraws the screen. */
function syncDrafts() {
  for (const card of document.querySelectorAll<HTMLElement>('.draft')) {
    const d = drafts.find((x) => x.key === card.dataset.key);
    if (!d) continue;
    const v = (name: string) => card.querySelector<HTMLInputElement>(`[data-draft="${name}"]`);
    d.include = v('include')!.checked;
    d.start = v('start')!.value;
    d.h = v('h')!.value;
    d.m = v('m')!.value;
  }
}

async function importFiles(files: File[]) {
  importing = true;
  if (route() !== 'import') location.hash = 'import'; else render();
  const photos: DraftPhoto[] = [];
  for (const file of files) {
    try {
      const meta = await readPhotoMeta(file);           // before compressing: that strips the time
      const blob = await compressPhoto(file);
      photos.push({ id: crypto.randomUUID(), blob, url: URL.createObjectURL(blob), takenAt: meta.takenAt, source: meta.source,
        kind: meta.screenshot ? 'isp_app' : 'router_light' });
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not read one of the photos.');
    }
  }
  addToDrafts(photos);
  importing = false;
  render();
}

/** Group photos into outages: sorted by time, a gap of more than 45 minutes starts a new outage. */
function addToDrafts(photos: DraftPhoto[]) {
  const timed = photos.filter((p) => p.takenAt).sort((a, b) => a.takenAt!.getTime() - b.takenAt!.getTime());
  const groups: DraftPhoto[][] = [];
  for (const p of timed) {
    const last = groups.at(-1);
    if (last && p.takenAt!.getTime() - last.at(-1)!.takenAt!.getTime() <= GROUP_GAP_MS) last.push(p);
    else groups.push([p]);
  }
  for (const p of photos.filter((x) => !x.takenAt)) groups.push([p]); // no time: one card each, time entered by hand

  for (const g of groups) {
    const start = g[0].takenAt;
    // Joins an outage already in the list if it's within 45 minutes of it.
    const existing = start && drafts.find((d) => {
      const t = fromLocalInput(d.start);
      return t && Math.abs(t.getTime() - start.getTime()) <= GROUP_GAP_MS;
    });
    if (existing) {
      const room = MAX_PHOTOS - existing.photos.length;
      existing.photos.push(...g.slice(0, Math.max(0, room)));
      existing.dropped += Math.max(0, g.length - Math.max(0, room));
      continue;
    }
    const already = start && listReports().find((r) => !r.withdrawn && Math.abs(new Date(r.startedAt).getTime() - start.getTime()) <= GROUP_GAP_MS);
    drafts.push({
      key: crypto.randomUUID(), include: !already, start: start ? toLocalInput(start) : '', h: '', m: '',
      photos: g.slice(0, MAX_PHOTOS), dropped: Math.max(0, g.length - MAX_PHOTOS),
      note: already ? `You already reported an outage at ${fmtWhen(already.startedAt)}. Left unchecked so it isn't counted twice.` : null,
    });
  }
  drafts.sort((a, b) => (a.start && b.start ? a.start.localeCompare(b.start) : a.start ? -1 : 1));
}

function saveDrafts() {
  syncDrafts();
  const msg = document.getElementById('import-msg')!;
  const chosen = drafts.filter((d) => d.include);
  const reports: { r: LocalReport; d: Draft }[] = [];
  for (const [i, d] of chosen.entries()) {
    const label = `Outage ${i + 1}`;
    const start = fromLocalInput(d.start);
    if (!start || isNaN(start.getTime())) { msg.textContent = `${label}: please enter when it went down.`; return; }
    if (start.getTime() > Date.now() + 60_000) { msg.textContent = `${label}: the time is in the future.`; return; }
    if (Date.now() - start.getTime() > MAX_AGE_DAYS * 86_400_000) { msg.textContent = `${label}: only outages from the last year can be reported.`; return; }
    const durMs = (Number(d.h || 0) * 60 + Number(d.m || 0)) * 60_000;
    const end = durMs > 0 ? new Date(start.getTime() + durMs) : null;
    if (end && end.getTime() > Date.now() + 60_000) { msg.textContent = `${label}: it would end in the future.`; return; }
    reports.push({ d, r: { id: crypto.randomUUID(), home: profile.home!, startedAt: start.toISOString(), endedAt: end?.toISOString() ?? null,
      notes: null, withdrawn: false, photos: d.photos.map((p) => ({ id: p.id, kind: p.kind })), endUnknown: !end } });
  }
  for (const { r, d } of reports) {
    persist(r);
    for (const p of d.photos) { thumbs.set(p.id, p.url); void queuePhoto(r.id, p.id, p.kind, p.blob); }
  }
  drafts = [];
  toast(`Saved ${reports.length} outage${reports.length === 1 ? '' : 's'}. Thank you!`);
  goHome();
}

function summaryView(): string {
  const back = `<a href="#" class="home-chip">← Back</a>`;
  if (summaryError) return `${header(back)}<main><p class="banner warn">Couldn't load the summary. Check your connection and
    <button class="link" data-action="reload-summary">try again</button>.</p></main>`;
  if (!summary) return `${header(back)}<main><p class="center muted">Loading… the first load can take up to a minute.</p></main>`;
  const s = summary;
  const byDay = new Map<string, typeof s.events>();
  for (const e of s.events) { const k = new Date(e.start).toDateString(); byDay.set(k, [...(byDay.get(k) ?? []), e]); }
  return `${header(back)}
  <main>
    <h2 class="page-title">Entrada internet outages · last ${s.days} days</h2>
    <div class="stats">
      <div><strong>${s.totals.outages}</strong><span>${s.totals.outages === 1 ? 'outage' : 'outages'} reported</span></div>
      <div><strong>${s.totals.reportedDowntimeHours}</strong><span>${s.totals.reportedDowntimeHours === 1 ? 'hour' : 'hours'} down (reported)</span></div>
      <div><strong>${s.totals.largestOutageHomes}</strong><span>${s.totals.largestOutageHomes === 1 ? 'home' : 'homes'} in the largest outage</span></div>
    </div>
    ${s.events.length === 0 ? '<p class="center muted">No outages reported in this period.</p>' : [...byDay].map(([, evs]) => `
      <section class="card day"><h3>${fmtDay(evs[0].start)}</h3><ul class="events">
        ${evs.map((e) => `<li>
          <span class="when">${fmtTime(e.start)} – ${e.ongoing ? '<span class="tag down">ongoing</span>' : e.end ? fmtTime(e.end) : '<span class="muted">end not reported</span>'}</span>
          ${e.end ? `<span class="dur">${fmtDuration(new Date(e.end).getTime() - new Date(e.start).getTime())}</span>` : ''}
          <span class="homes">${e.homes} home${e.homes === 1 ? '' : 's'}</span></li>`).join('')}
      </ul></section>`).join('')}
    <p class="hint center">Built from residents' reports. Addresses are never shown here.</p>
  </main>`;
}

async function loadSummary() {
  summaryError = false;
  try { summary = await api.summary(30); } catch { summaryError = true; }
  if (route() === 'summary') render();
}

function updateSync() {
  const el = document.getElementById('sync');
  if (!el) return;
  el.className = 'sync' + (outbox.pending ? ' pending' : '');
  el.textContent = outbox.pending
    ? (outbox.sending ? `Sending ${outbox.pending} item${outbox.pending > 1 ? 's' : ''}…`
      : `📶 ${outbox.pending} item${outbox.pending > 1 ? 's' : ''} saved on this phone. They'll be sent automatically when you have signal.`)
    : listReports().length ? '✓ All reports sent' : '';
}

let toastTimer: number | undefined;
function toast(msg: string) {
  let el = document.getElementById('toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; el.setAttribute('role', 'status'); document.body.append(el); }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el!.classList.remove('show'), 3500);
}

/** Go to the home screen. Setting an empty hash when it's already empty fires no event, so redraw directly. */
function goHome() {
  if (location.hash) location.hash = '';
  else { editing = null; render(); window.scrollTo(0, 0); }
}

// ---------------------------------------------------------------- actions
function persist(r: LocalReport) {
  saveReport(r);
  void queueReport(r.id, toBody(r, profile));
}

const actions: Record<string, (el: HTMLElement) => void | Promise<void>> = {
  down() {
    const r: LocalReport = { id: crypto.randomUUID(), home: profile.home!, startedAt: new Date().toISOString(),
      endedAt: null, notes: null, withdrawn: false, photos: [] };
    persist(r);
    navigator.vibrate?.(30);
    toast('Reported. Thank you! Tap “It\'s BACK” when service returns.');
    render();
  },
  back() {
    const r = openReport(); if (!r) return;
    r.endedAt = new Date().toISOString();
    persist(r);
    editing = null; confirmWithdraw = false;
    toast(`Marked as back after ${fmtDuration(Date.now() - new Date(r.startedAt).getTime())}.`);
    render();
  },
  'edit-start'() { editing = 'start'; render(); },
  'edit-end'() { editing = 'end'; render(); },
  'cancel-time'() { editing = null; render(); },
  'save-time'() {
    const r = openReport(); if (!r) return;
    const t = fromLocalInput((document.getElementById('time-input') as HTMLInputElement).value);
    const msg = document.getElementById('time-msg')!;
    if (!t || isNaN(t.getTime())) { msg.textContent = 'Please pick a date and time.'; return; }
    if (t.getTime() > Date.now() + 60_000) { msg.textContent = "That's in the future."; return; }
    if (editing === 'start') {
      if (Date.now() - t.getTime() > MAX_AGE_DAYS * 86_400_000) { msg.textContent = 'That is more than a year ago.'; return; }
      r.startedAt = t.toISOString();
    } else {
      if (t < new Date(r.startedAt)) { msg.textContent = 'It has to be after the outage started.'; return; }
      r.endedAt = t.toISOString();
      toast(`Marked as back after ${fmtDuration(t.getTime() - new Date(r.startedAt).getTime())}.`);
    }
    persist(r); editing = null; render();
  },
  withdraw() {
    if (!confirmWithdraw) { confirmWithdraw = true; render(); return; }
    const r = openReport(); if (!r) return;
    r.withdrawn = true; persist(r); confirmWithdraw = false;
    toast('Report removed.'); render();
  },
  'add-photo'(el) {
    photoKind = (el.dataset.kind as PhotoKind) ?? 'other';
    (document.getElementById('file') as HTMLInputElement).click();
  },
  'past-save'() {
    const msg = document.getElementById('past-msg')!;
    const start = fromLocalInput((document.getElementById('p-start') as HTMLInputElement).value);
    const h = Number((document.getElementById('p-h') as HTMLInputElement).value || 0);
    const m = Number((document.getElementById('p-m') as HTMLInputElement).value || 0);
    const still = (document.getElementById('p-still') as HTMLInputElement).checked;
    const notes = (document.getElementById('p-notes') as HTMLTextAreaElement).value.trim() || null;
    if (!start || isNaN(start.getTime())) { msg.textContent = 'Please enter when it went down.'; return; }
    if (start.getTime() > Date.now() + 60_000) { msg.textContent = 'The start time is in the future.'; return; }
    if (Date.now() - start.getTime() > MAX_AGE_DAYS * 86_400_000) { msg.textContent = 'Only outages from the last year can be reported.'; return; }
    if (still && openReport()) { msg.textContent = 'You already have an open outage. Mark it as back first.'; return; }
    const durMs = (h * 60 + m) * 60_000;
    let end: Date | null = null;
    if (!still && durMs > 0) {
      end = new Date(start.getTime() + durMs);
      if (end.getTime() > Date.now() + 60_000) { msg.textContent = 'That would end in the future. Did you mean “It\'s still down”?'; return; }
    }
    const r: LocalReport = { id: crypto.randomUUID(), home: profile.home!, startedAt: start.toISOString(),
      endedAt: end?.toISOString() ?? null, notes, withdrawn: false, photos: pastPhotos.map((p) => ({ id: p.id, kind: p.kind })), endUnknown: !still && !end };
    persist(r);
    for (const p of pastPhotos) { thumbs.set(p.id, p.url); void queuePhoto(r.id, p.id, p.kind, p.blob); }
    pastPhotos = [];
    toast('Report saved. Thank you!');
    goHome();
  },
  pick(el) {
    const a = findAddress(el.dataset.id); if (!a) return;
    draftHome = { id: a.id, label: a.label };
    document.getElementById('picked')!.textContent = `✓ ${a.label}`;
    (document.getElementById('addr-q') as HTMLInputElement).value = '';
    document.getElementById('addr-results')!.innerHTML = '';
  },
  'custom-toggle'() { document.getElementById('custom')!.hidden = false; (document.getElementById('custom-text') as HTMLInputElement).focus(); },
  'custom-use'() {
    const text = (document.getElementById('custom-text') as HTMLInputElement).value.replace(/\s+/g, ' ').trim();
    if (text.length < 5) { document.getElementById('picked')!.textContent = 'Please enter your house number and street.'; return; }
    draftHome = { id: null, label: text };
    document.getElementById('picked')!.textContent = `✓ ${text}`;
  },
  async 'setup-save'(el) {
    const code = (document.getElementById('code') as HTMLInputElement).value.trim();
    const codeMsg = document.getElementById('code-msg')!, msg = document.getElementById('setup-msg')!;
    codeMsg.textContent = msg.textContent = '';
    if (!code) { codeMsg.textContent = 'Please enter the neighborhood code.'; return; }
    if (!draftHome) { msg.textContent = 'Please choose your address.'; return; }
    el.setAttribute('disabled', ''); el.textContent = 'Checking…';
    try {
      await api.checkCode(code);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        codeMsg.textContent = "That code isn't right. Check the HOA email or flyer.";
        el.removeAttribute('disabled'); el.textContent = 'Save'; return;
      }
      // No connection: save anyway. If the code is wrong, the app will say so when it sends a report.
    }
    profile.code = code; profile.home = draftHome;
    saveProfile(profile);
    codeFixed();
    goHome();
  },
  'import-pick'() {
    if (route() === 'import') syncDrafts();
    (document.getElementById('bulk-file') as HTMLInputElement).click();
  },
  'import-remove'(el) {
    syncDrafts();
    const d = drafts.find((x) => x.key === el.dataset.key);
    d?.photos.forEach((p) => URL.revokeObjectURL(p.url));
    drafts = drafts.filter((x) => x !== d);
    render();
  },
  'import-save'() { saveDrafts(); },
  'import-cancel'() {
    drafts.forEach((d) => d.photos.forEach((p) => URL.revokeObjectURL(p.url)));
    drafts = [];
    goHome();
  },
  'dismiss-problems'() { clearProblems(); },
  'dismiss-install'() { localStorage.setItem('entrada.installDismissed', '1'); render(); },
  async install() { await installPrompt?.prompt(); installPrompt = null; render(); },
  async 'share-link'() {
    const url = personalLink(profile);
    try {
      if (navigator.share) await navigator.share({ title: 'Entrada outage tracker', text: 'Report internet outages in one tap:', url });
      else { await navigator.clipboard.writeText(url); toast('Setup link copied. Anyone who opens it is set up for this address.'); }
    } catch { /* cancelled */ }
  },
  'reload-summary'() { summary = null; render(); },
};

document.addEventListener('click', (ev) => {
  const el = (ev.target as HTMLElement).closest<HTMLElement>('[data-action]');
  if (!el) return;
  ev.preventDefault();
  void actions[el.dataset.action!]?.(el);
});

document.addEventListener('change', async (ev) => {
  const input = ev.target as HTMLInputElement;
  // Photo import screen
  if (input.id === 'bulk-file' && input.files?.length) {
    const files = [...input.files];
    input.value = '';
    await importFiles(files);
    return;
  }
  if (input.dataset.photo) {
    for (const d of drafts) for (const p of d.photos) if (p.id === input.dataset.photo) p.kind = input.value as PhotoKind;
    return;
  }
  if (input.dataset.draft === 'include') { syncDrafts(); render(); return; }
  if (input.id !== 'file' || !input.files?.length) return;
  const files = [...input.files];
  input.value = '';
  const r = route() === 'home' ? openReport() : null;
  for (const file of files) {
    const count = r ? r.photos.length : pastPhotos.length;
    if (count >= MAX_PHOTOS) { toast(`Maximum ${MAX_PHOTOS} photos per report.`); break; }
    try {
      const blob = await compressPhoto(file);
      const id = crypto.randomUUID();
      const url = URL.createObjectURL(blob);
      if (r) {
        r.photos.push({ id, kind: photoKind });
        saveReport(r);
        thumbs.set(id, url);
        await queuePhoto(r.id, id, photoKind, blob);
      } else {
        pastPhotos.push({ id, kind: photoKind, blob, url });
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not add that photo.');
    }
  }
  if (route() === 'past') document.getElementById('past-photos')!.innerHTML = photoBlock(pastPhotos);
  else render();
});

// ---------------------------------------------------------------- start-up
window.addEventListener('hashchange', () => { editing = null; confirmWithdraw = false; render(); window.scrollTo(0, 0); });
window.addEventListener('outbox', (e) => {
  const prevBad = outbox.badCode, prevProblems = outbox.problems.length;
  outbox = (e as CustomEvent<OutboxStatus>).detail;
  if (route() === 'home' && (prevBad !== outbox.badCode || prevProblems !== outbox.problems.length)) render();
  else updateSync();
});
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e as typeof installPrompt; if (route() === 'home') render(); });
setInterval(() => {
  const el = document.getElementById('elapsed'), r = openReport();
  if (el && r) el.textContent = fmtDuration(Date.now() - new Date(r.startedAt).getTime());
}, 30_000);

render();
startOutbox(() => ({ code: profile.code, deviceId: profile.deviceId }));
// Wake the database while the resident is looking at the screen, so their tap is saved quickly.
if (profile.code && profile.home) api.ping().catch(() => { /* offline or asleep; the outbox will retry */ });
if (import.meta.env.PROD && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => { /* */ });
// Expose a manual retry for the rare case a phone sits on a stale connection.
window.addEventListener('focus', kick);
