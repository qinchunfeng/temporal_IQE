import http from 'node:http';
import { pathToFileURL } from 'node:url';

export const ORIGINAL_LOG = [
  '2026-11-03T06:58:01.123456Z ERROR run_kernel_test: segfault at 0x7f3a21c0 ip 0x00007f3a error 4 in /opt/build/libflash_attn.so',
  'Traceback (most recent call last):',
  'RuntimeError: flash attention kernel failed, exit code 139 (run id 8f14e45f-ceea-467f-a9d2-3f21c0b9a111)',
].join('\n');

type Scenario = 'stable_fail' | 'flaky' | 'all_pass' | 'paused' | 'timeout';

interface Run {
  scenario: Scenario;
  attempt: number;
}

export function createFakeCiServer() {
  const runs = new Map<string, Run>();
  const idem = new Map<string, string>();
  const stats = { creations: 0, dedups: 0 };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const send = (code: number, body: unknown): void => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (req.method === 'GET' && url.pathname === '/healthz') return send(200, { ok: true });

    if (req.method === 'GET' && url.pathname === '/stats') return send(200, stats);

    if (req.method === 'GET' && url.pathname === '/original-log') return send(200, { log_tail: ORIGINAL_LOG });

    if (req.method === 'GET' && url.pathname.startsWith('/runs/')) {
      const ref = decodeURIComponent(url.pathname.slice('/runs/'.length));
      const run = runs.get(ref);
      if (!run) return send(404, { error: 'unknown run' });
      let state: string;
      switch (run.scenario) {
        case 'stable_fail': state = 'failed'; break;
        case 'all_pass': state = 'success'; break;
        case 'flaky': state = run.attempt <= 1 ? 'failed' : 'success'; break;
        case 'paused': state = 'queued'; break;
        case 'timeout': state = 'running'; break;
      }
      return send(200, { state, ...(state === 'failed' ? { log_tail: ORIGINAL_LOG } : {}) });
    }

    if (req.method === 'POST' && url.pathname === '/trigger') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          const a = JSON.parse(body);
          if (!a.run_ref?.startsWith('repro__')) return send(400, { error: 'run_ref must start with repro__' });
          const existing = idem.get(a.idempotency_key);
          if (existing) {
            stats.dedups += 1;
            return send(200, { run_ref: existing, dedup: true });
          }
          runs.set(a.run_ref, { scenario: a.scenario ?? 'stable_fail', attempt: a.attempt ?? 1 });
          idem.set(a.idempotency_key, a.run_ref);
          stats.creations += 1;
          return send(201, { run_ref: a.run_ref });
        } catch {
          return send(400, { error: 'bad json' });
        }
      });
      return;
    }

    send(404, { error: 'not found' });
  });

  return {
    server,
    start(port = Number(process.env.FAKE_CI_PORT ?? 8200)): Promise<number> {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          const addr = server.address();
          resolve(typeof addr === 'object' && addr ? addr.port : port);
        });
      });
    },
    close(): Promise<void> {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const ci = createFakeCiServer();
  ci.start().then((port) => console.log(`[fake-ci] listening on 127.0.0.1:${port}`));
}