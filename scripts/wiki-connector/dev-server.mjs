import http from 'node:http';
import { createService } from './service.mjs';
import { readJsonBody, safeError, MAX_BYTES } from './protocol.mjs';

export async function startDevServer(options) {
  const service = await createService(options);
  const server = http.createServer(async (req, res) => {
    const reply = (code, data) => {
      const body = JSON.stringify(data);
      if (Buffer.byteLength(body) > MAX_BYTES) { res.writeHead(413); res.end('{"error":"PAYLOAD_TOO_LARGE"}'); return; }
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(body);
    };
    if (req.headers.origin || !/^127\.0\.0\.1:\d+$/.test(req.headers.host ?? '')) return reply(403, { error: 'FORBIDDEN' });
    if (req.method !== 'POST' || req.url !== '/sync' || req.headers['content-type'] !== 'application/json') return reply(404, { error: 'NOT_FOUND' });
    try {
      const body = await readJsonBody(req);
      const result = await service.request((req.headers.authorization ?? '').replace(/^Bearer /, ''), body.action, body.input ?? {});
      reply(200, result);
    } catch (e) { reply(e.message === 'UNAUTHORIZED' ? 401 : 400, { error: safeError(e) }); }
  });
  server.requestTimeout = 10000;
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 0, '127.0.0.1', resolve); }); }
  catch (e) { await service.close(); throw e; }
  return { url: `http://127.0.0.1:${server.address().port}/sync`, service, async close() { await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve())); await service.close(); } };
}
