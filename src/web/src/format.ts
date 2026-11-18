export const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const day = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

export const fmtTime = (iso: string | Date) => time.format(new Date(iso));
export const fmtDay = (iso: string | Date) => day.format(new Date(iso));
export const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

export function fmtWhen(iso: string): string {
  const d = new Date(iso), now = new Date();
  if (sameDay(d, now)) return `today ${fmtTime(d)}`;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return `yesterday ${fmtTime(d)}`;
  return `${fmtDay(d)}, ${fmtTime(d)}`;
}

export function fmtDuration(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  if (h < 48) return m ? `${h} h ${m} min` : `${h} h`;
  return `${Math.floor(h / 24)} days ${h % 24} h`;
}

/** Value for <input type="datetime-local"> in the phone's own time zone. */
export function toLocalInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
export const fromLocalInput = (s: string) => (s ? new Date(s) : null);
