// The forge's HTTP server: one process serving git smart HTTP, REST v3,
// GraphQL v4 and MCP from a single in-memory store. Node stdlib only.
//
// Auth: the trial's bearer token is $MAKEFUN_SHOP_TOKEN; every surface
// requires it (a missing or wrong token is 401 {message}). When the variable
// is unset (local runs), any non-empty bearer token is accepted.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { infoRefs, receivePack, uploadPack } from './src/githttp.ts';
import { handleGraphql } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import { handleRest } from './src/rest.ts';
import { Store } from './src/store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

const EXPECTED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

/** Whether the request's Authorization header carries the trial token. */
function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length);
  if (token === '') return false;
  if (EXPECTED_TOKEN === '') return true;
  return token === EXPECTED_TOKEN;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (body === null) {
    res.writeHead(status, { 'x-github-request-id': nextRequestId(), ...headers });
    res.end();
    return;
  }
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
  });
  res.end(body);
}

/** Read the whole request body (binary-safe), capped at MAX_BODY_BYTES. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let tooBig = false;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        tooBig = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooBig) reject(new Error('request body too large'));
      else resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

/** Split a pathname into percent-decoded segments (empty segments dropped). */
function segmentsOf(pathname: string): string[] {
  return pathname
    .split('/')
    .filter((part) => part !== '')
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
}

export function createApp(): Server {
  const store = new Store();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        const method = req.method ?? 'GET';
        const pathname = url.pathname;

        // The env's boot probe: 200 {"ok":true}.
        if (method === 'GET' && pathname === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        const needsAuth =
          pathname.startsWith('/api/') || pathname === '/mcp' || pathname.includes('/info/refs') || pathname.includes('/git-upload-pack') || pathname.includes('/git-receive-pack');
        if (needsAuth && !authorized(req)) {
          sendJson(res, 401, { message: 'Requires authentication' });
          return;
        }

        // MCP: POST (JSON-RPC), DELETE (session close), anything else 405.
        if (pathname === '/mcp') {
          if (method === 'DELETE') {
            res.writeHead(204, { 'x-github-request-id': nextRequestId() });
            res.end();
            return;
          }
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          const body = await readBody(req);
          const result = handleMcp(store, body.toString('utf8'));
          if (result.body === null) {
            res.writeHead(result.status, { 'x-github-request-id': nextRequestId() });
            res.end();
            return;
          }
          sendJson(res, result.status, result.body);
          return;
        }

        // GraphQL v4.
        if (pathname === '/api/graphql') {
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          const body = await readBody(req);
          let parsed: unknown = null;
          let parseError = false;
          if (body.length > 0) {
            try {
              parsed = JSON.parse(body.toString('utf8'));
            } catch {
              parseError = true;
            }
          }
          if (parseError) {
            sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
            return;
          }
          sendJson(res, 200, handleGraphql(store, parsed));
          return;
        }

        // REST v3.
        if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
          const restPath = pathname.slice('/api/v3'.length);
          const segments = segmentsOf(restPath);
          const host = req.headers.host ?? '127.0.0.1';
          const baseUrl = `http://${host}`;
          let body: unknown = null;
          let bodyParseError = false;
          if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
            const raw = await readBody(req);
            if (raw.length > 0) {
              try {
                body = JSON.parse(raw.toString('utf8'));
              } catch {
                bodyParseError = true;
              }
            }
          }
          const result = handleRest(store, { method, segments, query: url.searchParams, body, bodyParseError, baseUrl });
          sendJson(res, result.status, result.body, result.headers ?? {});
          return;
        }

        // Git smart HTTP: /{owner}/{repo}/info/refs, /git-upload-pack, /git-receive-pack.
        const gitMatch = /^\/([^/]+)\/([^/]+)\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
        if (gitMatch) {
          const owner = decodeURIComponent(gitMatch[1] as string);
          // The git client appends `.git` to the repository path.
          const repoName = decodeURIComponent(gitMatch[2] as string).replace(/\.git$/, '');
          const service = gitMatch[3] as string;
          const repo = store.getRepo(owner, repoName);
          if (service === 'info/refs') {
            if (method !== 'GET') {
              sendJson(res, 405, { message: 'Method Not Allowed' });
              return;
            }
            const queryService = url.searchParams.get('service');
            if (queryService !== 'git-upload-pack' && queryService !== 'git-receive-pack') {
              sendJson(res, 400, { message: 'service is required' });
              return;
            }
            const gitProtocol2 = (req.headers['git-protocol'] ?? '') === 'version=2';
            const result = infoRefs(repo, queryService, gitProtocol2);
            if (result.status === 404) {
              sendJson(res, 404, { message: 'Not Found' });
              return;
            }
            sendBuffer(res, result.status, result.contentType, result.body);
            return;
          }
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          const body = await readBody(req);
          const result = service === 'git-upload-pack' ? uploadPack(repo, body) : receivePack(repo, body);
          if (result.status === 404) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          if (result.contentType.startsWith('application/json')) {
            sendJson(res, result.status, JSON.parse(result.body.toString('utf8')));
            return;
          }
          sendBuffer(res, result.status, result.contentType, result.body);
          return;
        }

        // Everything else: GitHub's JSON 404.
        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        // Never crash the process on a request: answer 500 and stay up.
        try {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        } catch {
          try {
            res.destroy();
          } catch {
            // ignore
          }
        }
      }
    })();
  });
}
