import './styles.css';
import './admin.css';
import { esc, fmtDay, fmtTime, fmtDuration } from './format';

interface AdminPhoto { id: string; kind: string; url: string }
interface AdminReport {
  id: string; addressId: string | null; addressText: string; isListedAddress: boolean;
  startedAt: string; endedAt: string | null; notes: string | null; withdrawn: boolean; createdAt: string;
  photos: AdminPhoto[];
}
interface Me { clientPrincipal: { userDetails: string; userRoles: string[] } | null }

const root = document.getElementById('admin')!;
const who = document.getElementById('who')!;
const KIND: Record<string, string> = { router_light: 'Router light', isp_app: 'ISP app', outage_map: 'Outage map', other: 'Other' };
let reports: AdminReport[] = [];
let days = 30;
let showWithdrawn = false;

async function start() {
  let me: Me = { clientPrincipal: null };
  try { me = await (await fetch('/.auth/me')).json(); } catch { /* not on Static Web Apps */ }
  const user = me.clientPrincipal;
  if (!user) {
    const back = encodeURIComponent('/admin.html');
    root.innerHTML = `<section class="card"><h2>Admin sign-in</h2>
      <p>Only invited admins can see addresses and photos.</p>
      <p><a class="primary btn" href="/.auth/login/aad?post_login_redirect_uri=${back}">Sign in with Microsoft</a></p>
      <p><a class="primary btn" href="/.auth/login/github?post_login_redirect_uri=${back}">Sign in with GitHub</a></p></section>`;
    return;
  }
  who.innerHTML = `${esc(user.userDetails)} · <a href="/.auth/logout?post_logout_redirect_uri=/admin.html">Sign out</a>`;
  if (!user.userRoles.includes('admin')) {
    root.innerHTML = `<section class="card"><h2>Not an admin</h2><p>You're signed in, but this account hasn't been given the
      <strong>admin</strong> role. Ask the site owner to send you an invitation link.</p></section>`;
    return;
  }
  root.innerHTML = `<section class="card controls">
      <label>Period <select id="days">${[7, 30, 60, 90, 365].map((d) => `<option value="${d}" ${d === days ? 'selected' : ''}>Last ${d} days</option>`).join('')}</select></label>
      <label class="check"><input type="checkbox" id="withdrawn"> Show removed reports</label>
      <button class="primary" id="csv">Export CSV</button>
    </section>
    <p id="status" class="muted"></p>
    <div id="table"></div>`;
  document.getElementById('days')!.addEventListener('change', (e) => { days = Number((e.target as HTMLSelectElement).value); void load(); });
  document.getElementById('withdrawn')!.addEventListener('change', (e) => { showWithdrawn = (e.target as HTMLInputElement).checked; draw(); });
  document.getElementById('csv')!.addEventListener('click', exportCsv);
  await load();
}

async function load() {
  const status = document.getElementById('status')!;
  status.textContent = 'Loading… the first load can take up to a minute while the database wakes up.';
  try {
    const res = await fetch(`/api/admin/reports?days=${days}`);
    if (!res.ok) throw new Error(String(res.status));
    reports = (await res.json()).reports;
    status.textContent = '';
  } catch (e) {
    status.textContent = `Couldn't load reports (${e instanceof Error ? e.message : e}). Try again in a minute.`;
    reports = [];
  }
  draw();
}

const visible = () => reports.filter((r) => showWithdrawn || !r.withdrawn);
const minutes = (r: AdminReport) => (r.endedAt ? Math.round((+new Date(r.endedAt) - +new Date(r.startedAt)) / 60_000) : null);

function draw() {
  const list = visible();
  const homes = new Set(list.map((r) => r.addressId ?? r.addressText.toLowerCase())).size;
  document.getElementById('table')!.innerHTML = `
    <p><strong>${list.length}</strong> report${list.length === 1 ? "" : "s"} from <strong>${homes}</strong> home${homes === 1 ? "" : "s"} ·
      <strong>${list.reduce((n, r) => n + r.photos.length, 0)}</strong> photos</p>
    <div class="table-wrap"><table>
      <thead><tr><th>Started</th><th>Back</th><th>Length</th><th>Address</th><th>Notes</th><th>Photos</th></tr></thead>
      <tbody>${list.map((r) => {
        const m = minutes(r);
        return `<tr class="${r.withdrawn ? 'withdrawn' : ''}">
          <td>${fmtDay(r.startedAt)}<br>${fmtTime(r.startedAt)}</td>
          <td>${r.endedAt ? fmtTime(r.endedAt) : Date.now() - +new Date(r.startedAt) < 12 * 3_600_000 ? '<span class="tag down">open</span>' : '<span class="muted">not given</span>'}</td>
          <td>${m === null ? '' : fmtDuration(m * 60_000)}</td>
          <td>${esc(r.addressText)}${r.isListedAddress ? '' : ' <span class="tag" title="Typed in, not from the list">typed</span>'}${r.withdrawn ? ' <span class="tag">removed</span>' : ''}</td>
          <td>${esc(r.notes ?? '')}</td>
          <td class="ph">${r.photos.map((p) => `<a href="${esc(p.url)}" target="_blank" rel="noopener" title="${esc(KIND[p.kind] ?? p.kind)}"><img src="${esc(p.url)}" alt="${esc(KIND[p.kind] ?? p.kind)}" loading="lazy"></a>`).join('')}</td>
        </tr>`;
      }).join('') || '<tr><td colspan="6" class="muted">No reports in this period.</td></tr>'}</tbody>
    </table></div>`;
}

/** Spreadsheet-safe CSV: quoted fields, and a leading ' on anything that could be read as a formula. */
function csvCell(v: unknown): string {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}
const local = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso), p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

function exportCsv() {
  const header = ['started_local', 'ended_local', 'duration_minutes', 'address', 'address_from_list', 'notes',
    'photo_count', 'photo_kinds', 'removed', 'started_utc', 'ended_utc', 'report_id'];
  const rows = visible().slice().reverse().map((r) => [
    local(r.startedAt), local(r.endedAt), minutes(r) ?? '', r.addressText, r.isListedAddress ? 'yes' : 'no', r.notes ?? '',
    r.photos.length, r.photos.map((p) => KIND[p.kind] ?? p.kind).join('; '), r.withdrawn ? 'yes' : 'no',
    r.startedAt, r.endedAt ?? '', r.id,
  ]);
  const csv = [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `entrada-outages-last-${days}-days-${local(new Date().toISOString()).slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

void start();
