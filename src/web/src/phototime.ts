/**
 * Reads when a photo or screenshot was taken, without any libraries.
 * Must run on the original file: compressing (canvas) throws this information away.
 *
 * Sources, best first:
 *   exif - EXIF DateTimeOriginal (camera photos; JPEG/HEIC, and PNG "eXIf" chunks)
 *   xmp  - XMP DateCreated/CreateDate text (some screenshots)
 *   file - the file's last-modified date, only if clearly in the past (may just be when it was saved)
 */
export type TimeSource = 'exif' | 'xmp' | 'file';
export interface PhotoMeta { takenAt: Date | null; source: TimeSource | null; screenshot: boolean }

const SCAN_BYTES = 1_500_000;

export async function readPhotoMeta(file: File): Promise<PhotoMeta> {
  const screenshot = file.type === 'image/png' || /screenshot/i.test(file.name);
  let found: { date: Date; source: TimeSource } | null = null;
  try {
    const bytes = new Uint8Array(await file.slice(0, SCAN_BYTES).arrayBuffer());
    found = isPng(bytes) ? fromPng(bytes) : fromExifMarker(bytes);
    found ??= fromXmp(bytes);
  } catch { /* unreadable: fall through */ }

  if (!found && file.lastModified && Date.now() - file.lastModified > 5 * 60_000) {
    found = { date: new Date(file.lastModified), source: 'file' };
  }
  if (found && !plausible(found.date)) found = null;
  return { takenAt: found?.date ?? null, source: found?.source ?? null, screenshot };
}

const plausible = (d: Date) => !isNaN(d.getTime()) && d.getFullYear() >= 2015 && d.getTime() < Date.now() + 86_400_000;

const isPng = (b: Uint8Array) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

/** JPEG and HEIC both store EXIF behind the marker "Exif\0\0", followed by a TIFF structure. */
function fromExifMarker(b: Uint8Array) {
  for (let i = 0; i < b.length - 12; i++) {
    if (b[i] === 0x45 && b[i + 1] === 0x78 && b[i + 2] === 0x69 && b[i + 3] === 0x66 && b[i + 4] === 0 && b[i + 5] === 0) {
      const d = fromTiff(b, i + 6);
      if (d) return { date: d, source: 'exif' as const };
    }
  }
  return null;
}

function fromPng(b: Uint8Array) {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let pos = 8;
  while (pos + 12 <= b.length) {
    const len = view.getUint32(pos);
    const type = String.fromCharCode(b[pos + 4], b[pos + 5], b[pos + 6], b[pos + 7]);
    const data = pos + 8;
    if (type === 'IDAT' || type === 'IEND') break;
    if (type === 'eXIf') { const d = fromTiff(b, data); if (d) return { date: d, source: 'exif' as const }; }
    if (type === 'iTXt' || type === 'tEXt') {
      const r = fromXmp(b.subarray(data, Math.min(data + len, b.length)));
      if (r) return r;
    }
    pos = data + len + 4;
  }
  return null;
}

function fromXmp(b: Uint8Array) {
  const text = new TextDecoder('latin1').decode(b.subarray(0, Math.min(b.length, SCAN_BYTES)));
  const m = text.match(/(?:photoshop:DateCreated|xmp:CreateDate|exif:DateTimeOriginal)(?:>|=")\s*([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+(?:Z|[+-][0-9]{2}:?[0-9]{2})?)/);
  if (!m) return null;
  const d = new Date(m[1]);
  return isNaN(d.getTime()) ? null : { date: d, source: 'xmp' as const };
}

/** Minimal TIFF/EXIF reader: DateTimeOriginal (+ its time-zone offset), then fallbacks. */
function fromTiff(b: Uint8Array, start: number): Date | null {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (start + 8 > b.length) return null;
  const le = view.getUint16(start) === 0x4949;
  const u16 = (o: number) => view.getUint16(start + o, le);
  const u32 = (o: number) => view.getUint32(start + o, le);
  if (u16(2) !== 42) return null;

  const readIfd = (off: number) => {
    const tags = new Map<number, string | number>();
    if (start + off + 2 > b.length) return tags;
    const n = u16(off);
    for (let i = 0; i < n && i < 500; i++) {
      const e = off + 2 + i * 12;
      if (start + e + 12 > b.length) break;
      const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
      if (type === 2) { // ASCII
        const at = count <= 4 ? start + e + 8 : start + u32(e + 8);
        if (at + count <= b.length) tags.set(tag, String.fromCharCode(...b.subarray(at, at + count)).replace(/\0.*$/, '').trim());
      } else if (type === 4 || type === 13) tags.set(tag, u32(e + 8)); // LONG / IFD pointer
    }
    return tags;
  };

  const ifd0 = readIfd(u32(4));
  const exifPtr = ifd0.get(0x8769);
  const exif = typeof exifPtr === 'number' ? readIfd(exifPtr) : new Map<number, string | number>();
  const original = (exif.get(0x9003) ?? exif.get(0x9004) ?? ifd0.get(0x0132)) as string | undefined;
  const offset = (exif.get(0x9011) ?? exif.get(0x9012) ?? exif.get(0x9010)) as string | undefined;
  return original ? parseExifDate(original, offset) : null;
}

/** "2026:11:10 07:42:13" (+ optional "-05:00"). Without an offset it's the phone's local time. */
export function parseExifDate(s: string, offset?: string): Date | null {
  const m = s.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m;
  if (offset && /^[+-]\d{2}:\d{2}$/.test(offset)) return new Date(`${y}-${mo}-${d}T${h}:${mi}:${se}${offset}`);
  return new Date(+y, +mo - 1, +d, +h, +mi, +se);
}
