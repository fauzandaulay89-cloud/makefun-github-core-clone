// HTTP server: routing for git smart HTTP, REST v3, GraphQL and MCP, plus
// /healthz. Auth (Bearer MAKEFUN_SHOP_TOKEN) applies to the API surfaces
// only; the git endpoints are unauthenticated, as the git protocol requires.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { advertisementV0, advertisementV2, handleReceivePack, handleUploadPack } from './git.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 256 * 1024 * 1024) {
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createApp(): Server {
  const store = new Store();
  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  let requestSeq = 0;

  function send(res: ServerResponse, status: number, contentType: string, body: Buffer | string | null, extraHeaders: Record<string, string> = {}): void {
    const headers: Record<string, string> = {
      'content-type': contentType,
      'x-github-request-id': `req-${++requestSeq}`,
      ...extraHeaders,
    };
    const buf = body === null ? Buffer.alloc(0) : typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
    headers['content-length'] = String(buf.length);
    res.writeHead(status, headers);
    res.end(buf);
  }

  function sendJson(res: ServerResponse, status: number, value: unknown, extraHeaders: Record<string, string> = {}): void {
    send(res, status, 'application/json; charset=utf-8', JSON.stringify(value), extraHeaders);
  }

  function authorized(req: IncomingMessage): boolean {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) return false;
    const token = auth.slice('Bearer '.length);
    if (token === '') return false;
    if (expectedToken !== '') return token === expectedToken;
    return true;
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const pathname = url.pathname;
      const method = req.method ?? 'GET';

      if (pathname === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      // ---- REST v3 ----
      if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
        if (!authorized(req)) {
          sendJson(res, 401, { message: 'Requires authentication' });
          return;
        }
        const seg = pathname.slice('/api/v3'.length).split('/').filter((s) => s !== '');
        let body: Record<string, unknown> | null = null;
        let malformed = false;
        if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
          const raw = await readBody(req);
          if (raw.length > 0) {
            try {
              body = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
            } catch {
              malformed = true;
            }
          }
        }
        const result = await handleRest({
          store,
          method,
          seg,
          query: url.searchParams,
          body,
          malformed,
          host: req.headers.host ?? 'localhost',
          base: `http://${req.headers.host ?? 'localhost'}`,
        });
        send(res, result.status, 'application/json; charset=utf-8', result.body, result.headers ?? {});
        return;
      }

      // ---- GraphQL ----
      if (pathname === '/api/graphql') {
        if (method !== 'POST') {
          sendJson(res, 405, { message: 'Method not allowed' });
          return;
        }
        if (!authorized(req)) {
          sendJson(res, 401, { message: 'Requires authentication' });
          return;
        }
        const raw = await readBody(req);
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw.toString('utf8'));
        } catch {
          sendJson(res, 400, { errors: [{ message: 'Request body must be valid JSON' }] });
          return;
        }
        const out = handleGraphQL(store, parsed);
        send(res, out.status, 'application/json; charset=utf-8', out.body);
        return;
      }

      // ---- MCP ----
      if (pathname === '/mcp') {
        if (method !== 'POST') {
          sendJson(res, 405, { message: 'Method not allowed' });
          return;
        }
        if (!authorized(req)) {
          sendJson(res, 401, { message: 'Requires authentication' });
          return;
        }
        const raw = await readBody(req);
        const out = handleMcp(store, raw, req.headers as Record<string, string | string[] | undefined>);
        send(res, out.status, 'application/json; charset=utf-8', out.body, out.headers ?? {});
        return;
      }

      // ---- Git smart HTTP ----
      const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(pathname);
      if (gitMatch) {
        const owner = decodeURIComponent(gitMatch[1]!);
        const repoName = decodeURIComponent(gitMatch[2]!);
        const suffix = gitMatch[3] ?? '';
        const repo = owner === store.login ? store.getRepo(owner, repoName) : null;
        if (!repo) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        if (method === 'GET' && suffix === '/info/refs') {
          const service = url.searchParams.get('service');
          if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
            sendJson(res, 400, { message: 'Invalid service' });
            return;
          }
          const wantsV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '').includes('version=2');
          const ad = wantsV2 ? advertisementV2() : advertisementV0(repo, service);
          const ct = `application/x-${service}-advertisement`;
          send(res, 200, ct, ad);
          return;
        }
        if (method === 'POST' && suffix === '/git-upload-pack') {
          const raw = await readBody(req);
          const isV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
          const out = handleUploadPack(repo, raw, isV2);
          send(res, out.status, out.contentType, out.body);
          return;
        }
        if (method === 'POST' && suffix === '/git-receive-pack') {
          const raw = await readBody(req);
          const out = handleReceivePack(repo, raw);
          send(res, out.status, out.contentType, out.body);
          return;
        }
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }

      sendJson(res, 404, { message: 'Not Found' });
    } catch (err) {
      process.stderr.write(`[app] ${err instanceof Error ? err.message : String(err)}\n`);
      if (!res.headersSent) {
        sendJson(res, 500, { message: 'Internal Server Error' });
      } else {
        res.end();
      }
    }
  });

  return server;
}
