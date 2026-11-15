// The server: one in-memory Store per process, routed to the git smart-HTTP
// endpoints, the REST v3 API, the GraphQL API and the MCP endpoint. main.ts
// owns the entry <-> env lifecycle and stays as it is.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store, VIEWER_LOGIN } from './store.ts';
import {
  advertisementV0,
  advertisementV2,
  applyPush,
  fetchV0,
  fetchV2,
  lsRefsV2,
  parseReceivePack,
  parseV0Fetch,
  parseV2Fetch,
  parseV2LsRefs,
  pushReportResponse,
  readPack,
  unpackErrorResponse,
} from './git.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest, type RestRequest } from './rest.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 128 * 1024 * 1024;

/** The request id every JSON reply carries; random per request. */
function requestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = body === null ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'x-github-request-id': requestId(),
    ...(body === null ? {} : { 'content-length': Buffer.byteLength(text) }),
    ...headers,
  });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': requestId(),
  });
  res.end(body);
}

function sendText(res: ServerResponse, status: number, text: string, contentType = 'text/plain; charset=utf-8'): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': Buffer.byteLength(text), 'x-github-request-id': requestId() });
  res.end(text);
}

/** The bearer token this process expects, or null when none is configured. */
function expectedToken(): string | null {
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  return token === '' ? null : token;
}

/** True when the request carries the expected bearer token. */
function isAuthed(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const presented = header.slice('Bearer '.length);
  const expected = expectedToken();
  if (expected === null) return presented !== '';
  return presented === expected;
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** Read the whole request body, or null when it exceeds the cap. */
function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        done = true;
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!done) resolve(Buffer.concat(chunks));
    });
    req.on('error', () => {
      if (!done) resolve(Buffer.concat(chunks));
    });
  });
}

function parseJsonBody(raw: Buffer): { ok: true; value: unknown } | { ok: false } {
  const text = raw.toString('utf8');
  if (text.trim() === '') return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

function decodeSegments(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '').map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  });
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const path = pathOf(req);
      const method = req.method ?? 'GET';
      const query = queryOf(req);
      const host = req.headers.host ?? 'localhost';

      try {
        // The env's boot check calls this twice: 200 {"ok":true}.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // ---- Git smart HTTP: /{owner}/{repo}.git/... ----
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git(?:\/(.*))?$/.exec(path);
        if (gitMatch !== null) {
          const owner = gitMatch[1] as string;
          const repoName = gitMatch[2] as string;
          const suffix = gitMatch[3] ?? '';
          if (!isAuthed(req)) {
            sendJson(res, 401, { message: 'Bad credentials' });
            return;
          }
          if (owner !== VIEWER_LOGIN) {
            sendText(res, 404, 'Not Found');
            return;
          }
          const repo = store.getRepo(repoName);
          if (repo === undefined) {
            sendText(res, 404, 'Not Found');
            return;
          }
          const protocolV2 = req.headers['git-protocol'] === 'version=2';

          if (method === 'GET' && suffix === 'info/refs') {
            const service = query.get('service');
            if (service === 'git-upload-pack') {
              if (protocolV2) {
                sendBuffer(res, 200, advertisementV2(), 'application/x-git-upload-pack-advertisement');
              } else {
                sendBuffer(res, 200, advertisementV0(repo, 'git-upload-pack'), 'application/x-git-upload-pack-advertisement');
              }
              return;
            }
            if (service === 'git-receive-pack') {
              sendBuffer(res, 200, advertisementV0(repo, 'git-receive-pack'), 'application/x-git-receive-pack-advertisement');
              return;
            }
            sendText(res, 400, 'service parameter is required');
            return;
          }

          if (method === 'POST' && suffix === 'git-upload-pack') {
            const raw = await readBody(req);
            if (raw === null) {
              sendText(res, 413, 'Request body too large');
              return;
            }
            if (protocolV2) {
              const firstLine = raw.toString('utf8', 4, Math.min(raw.length, 64));
              if (firstLine.startsWith('command=ls-refs')) {
                sendBuffer(res, 200, lsRefsV2(repo, parseV2LsRefs(raw)), 'application/x-git-upload-pack-result');
              } else if (firstLine.startsWith('command=fetch')) {
                sendBuffer(res, 200, fetchV2(repo, parseV2Fetch(raw)), 'application/x-git-upload-pack-result');
              } else {
                sendBuffer(res, 200, fetchV2(repo, parseV2Fetch(raw)), 'application/x-git-upload-pack-result');
              }
            } else {
              sendBuffer(res, 200, fetchV0(repo, parseV0Fetch(raw)), 'application/x-git-upload-pack-result');
            }
            return;
          }

          if (method === 'POST' && suffix === 'git-receive-pack') {
            const raw = await readBody(req);
            if (raw === null) {
              sendText(res, 413, 'Request body too large');
              return;
            }
            try {
              const { commands, pack } = parseReceivePack(raw);
              const packObjects = pack.length === 0 ? new Map() : readPack(pack).objects;
              const report = applyPush(repo, commands, packObjects);
              sendBuffer(res, 200, pushReportResponse(report), 'application/x-git-receive-pack-result');
            } catch (error) {
              const detail = error instanceof Error ? error.message : String(error);
              sendBuffer(res, 200, unpackErrorResponse(detail), 'application/x-git-receive-pack-result');
            }
            return;
          }

          sendText(res, 404, 'Not Found');
          return;
        }

        // ---- REST v3: /api/v3/... ----
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          if (!isAuthed(req)) {
            sendJson(res, 401, { message: 'Bad credentials' });
            return;
          }
          const segments = path === '/api/v3' ? [] : decodeSegments(path.slice('/api/v3/'.length));
          let body: unknown = {};
          if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
            const raw = await readBody(req);
            if (raw === null) {
              sendJson(res, 413, { message: 'Request body too large' });
              return;
            }
            const parsed = parseJsonBody(raw);
            if (!parsed.ok) {
              sendJson(res, 400, { message: 'Problems parsing JSON' });
              return;
            }
            body = parsed.value;
          }
          const request: RestRequest = { method, segments, query, body, host };
          const result = handleRest(store, request);
          if (result === null) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          sendJson(res, result.status, result.json, result.headers ?? {});
          return;
        }

        // ---- GraphQL: POST /api/graphql ----
        if (path === '/api/graphql') {
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          if (!isAuthed(req)) {
            sendJson(res, 401, { message: 'Bad credentials' });
            return;
          }
          const raw = await readBody(req);
          if (raw === null) {
            sendJson(res, 413, { message: 'Request body too large' });
            return;
          }
          const parsed = parseJsonBody(raw);
          if (!parsed.ok) {
            sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
            return;
          }
          const result = handleGraphql(store, parsed.value);
          sendJson(res, result.status, result.json);
          return;
        }

        // ---- MCP: POST /mcp ----
        if (path === '/mcp') {
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          if (!isAuthed(req)) {
            sendJson(res, 401, { message: 'Bad credentials' });
            return;
          }
          const raw = await readBody(req);
          if (raw === null) {
            sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
            return;
          }
          const text = raw.toString('utf8');
          let parsedBody: unknown;
          try {
            parsedBody = text.trim() === '' ? null : (JSON.parse(text) as unknown);
          } catch {
            sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
            return;
          }
          const result = handleMcp(store, parsedBody);
          if (result.status === 202) {
            res.writeHead(202, { 'x-github-request-id': requestId() });
            res.end();
            return;
          }
          sendJson(res, result.status, result.json);
          return;
        }

        // Everything else, every method: GitHub's 404 body.
        sendJson(res, 404, { message: 'Not Found' });
      } catch (error) {
        // A request must never crash the server: answer 500 and keep serving.
        process.stderr.write(`[entry] request ${method} ${path} failed: ${error instanceof Error ? error.message : String(error)}\n`);
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
        else res.end();
      }
    })();
  });
}
