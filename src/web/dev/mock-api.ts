import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * In-memory stand-in for the Azure Functions API, used only by `npm run dev`.
 * Neighborhood code: "entrada". You are always an admin.
 * GET /__mock/offline?on=1 (or 0) makes every API call fail, to test the offline queue.
 */
export function mockApi(): Plugin {
  const reports = new Map<string, Record<string, unknown> & { deviceId: string; startedAt: string; endedAt: string | null; createdAt: string }>();
  const photos = new Map<string, { id: string; reportId: string; kind: string; blob?: Buffer }>();
  let offline = false;

  const readBody = (req: IncomingMessage) => new Promise<Buffer>((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
  const send = (res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers });
    res.end(body !== undefined ? JSON.stringify(body) : undefined);
  };
  const codeOk = (req: IncomingMessage) =>
    String(req.headers['x-neighborhood-code'] ?? '').replace(/[^a-z0-9]/gi, '').toUpperCase() === 'ENTRADA';

  return {
    name: 'mock-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const path = url.pathname;

        if (path === '/__mock/offline') { offline = url.searchParams.get('on') === '1'; return send(res, 200, { offline }); }
        if (path === '/.auth/me') return send(res, 200, { clientPrincipal: { userDetails: 'dev@localhost', userRoles: ['anonymous', 'authenticated', 'admin'] } });
        if (path.startsWith('/mock-blob/') && req.method === 'PUT') {
          const p = photos.get(path.split('/').pop()!.replace('.jpg', ''));
          if (p) p.blob = await readBody(req);
          return send(res, 201);
        }
        if (path.startsWith('/mock-blob/') && req.method === 'GET') {
          const p = photos.get(path.split('/').pop()!.replace('.jpg', ''));
          if (!p?.blob) return send(res, 404);
          res.writeHead(200, { 'Content-Type': 'image/jpeg' }); return res.end(p.blob);
        }
        if (!path.startsWith('/api/')) return next();
        if (offline) { req.socket.destroy(); return; }   // looks like no signal
        await new Promise((r) => setTimeout(r, 300));     // a little realism

        let m: RegExpMatchArray | null;
        if (path === '/api/ping') return send(res, 204);
        if (path === '/api/check-code') return codeOk(req) ? send(res, 204) : send(res, 401, { error: 'bad_code' });
        if (path === '/api/remember') {
          const b64 = (await readBody(req)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
          return send(res, 204, undefined, { 'Set-Cookie': `entrada_home=${b64}; Path=/; Max-Age=34560000; SameSite=Lax` });
        }
        if ((m = path.match(/^\/api\/reports\/([0-9a-f-]{36})$/i)) && req.method === 'PUT') {
          if (!codeOk(req)) return send(res, 401, { error: 'bad_code' });
          const body = JSON.parse((await readBody(req)).toString());
          const existing = reports.get(m[1]);
          if (existing && existing.deviceId !== body.deviceId) return send(res, 403, { error: 'not_owner' });
          if (body.endedAt && body.endedAt < body.startedAt) return send(res, 400, { error: 'invalid', details: ['Outage end is before its start.'] });
          reports.set(m[1], { ...body, id: m[1], createdAt: existing?.createdAt ?? new Date().toISOString() });
          return send(res, 200, { id: m[1] });
        }
        if ((m = path.match(/^\/api\/reports\/([0-9a-f-]{36})\/photos\/([0-9a-f-]{36})$/i)) && req.method === 'PUT') {
          if (!codeOk(req)) return send(res, 401, { error: 'bad_code' });
          const body = JSON.parse((await readBody(req)).toString());
          if (!reports.has(m[1])) return send(res, 404, { error: 'no_report' });
          if (!photos.has(m[2])) photos.set(m[2], { id: m[2], reportId: m[1], kind: body.kind });
          return send(res, 200, { uploadUrl: `/mock-blob/${m[2]}.jpg` });
        }
        if (path === '/api/summary') {
          const days = Number(url.searchParams.get('days') ?? 30);
          const since = Date.now() - days * 86_400_000;
          const list = [...reports.values()].filter((r) => !r.withdrawn && +new Date(r.startedAt) >= since)
            .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
          const events: { start: string; end: string | null; ongoing: boolean; homes: number; reports: number }[] = [];
          let cur: typeof list = [], latest = 0;
          const flush = () => {
            if (!cur.length) return;
            const ongoing = cur.some((r) => !r.endedAt && Date.now() - +new Date(r.startedAt) < 12 * 3_600_000);
            const ends = cur.filter((r) => r.endedAt).map((r) => r.endedAt!).sort();
            events.push({ start: cur[0].startedAt, end: ongoing || !ends.length ? null : ends.at(-1)!, ongoing,
              homes: new Set(cur.map((r) => r.addressId ?? r.addressText)).size, reports: cur.length });
            cur = [];
          };
          for (const r of list) {
            if (cur.length && +new Date(r.startedAt) > latest + 45 * 60_000) flush();
            if (!cur.length) latest = +new Date(r.startedAt);
            cur.push(r);
            latest = Math.max(latest, +new Date(r.endedAt ?? r.startedAt));
          }
          flush();
          const done = events.filter((e) => e.end);
          return send(res, 200, {
            generatedAt: new Date().toISOString(), days,
            totals: { outages: events.length,
              reportedDowntimeHours: Math.round(done.reduce((h, e) => h + (+new Date(e.end!) - +new Date(e.start)) / 3_600_000, 0) * 10) / 10,
              largestOutageHomes: Math.max(0, ...events.map((e) => e.homes)) },
            events: events.reverse(),
          });
        }
        if (path === '/api/admin/reports') {
          return send(res, 200, { days: 30, reports: [...reports.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).map((r) => ({
            ...r, isListedAddress: !!r.addressId,
            photos: [...photos.values()].filter((p) => p.reportId === r.id).map((p) => ({ id: p.id, kind: p.kind, url: `/mock-blob/${p.id}.jpg` })),
          })) });
        }
        return send(res, 404, { error: 'not_found' });
      });
    },
  };
}
