// MCP (Model Context Protocol, Streamable HTTP, plain-JSON transport):
// server/discover (2026-07-28) and the legacy initialize handshake, tools/list
// and tools/call for the six github-mcp-server tools. No sessions: every POST
// is answered by one JSON body. Tool results carry both a text block and
// structuredContent, as the suite reads either.
import { VIEWER, type Store } from './store.ts';

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, { type: string; description?: string }>; required: string[] };
}

const TOOLS: readonly ToolDef[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Issue state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
]);

const ACCEPTED_REVISIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function toolOk(result: unknown): Record<string, unknown> {
  const text = JSON.stringify(result);
  return { content: [{ type: 'text', text }], structuredContent: result, isError: false };
}

function toolErr(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

/** Dispatch one tools/call. Returns a tool result object (or an error string). */
function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const repoName = typeof args.repo === 'string' ? args.repo : '';
  switch (name) {
    case 'create_repo': {
      const repoTitle = typeof args.name === 'string' ? args.name : '';
      const created = store.createRepo(repoTitle, typeof args.description === 'string' ? args.description : '', args.private === true);
      if (created === 'exists') return toolErr(`Repository ${VIEWER.login}/${repoTitle} already exists`);
      return toolOk({
        id: created.id,
        name: created.name,
        full_name: created.fullName,
        owner: { login: created.owner },
        private: created.privateFlag,
        description: created.description,
        default_branch: created.defaultBranch,
      });
    }
    case 'get_repo': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolErr(`Repository ${owner}/${repoName} not found`);
      return toolOk({
        id: repo.id,
        name: repo.name,
        full_name: repo.fullName,
        owner: { login: repo.owner },
        private: repo.privateFlag,
        description: repo.description,
        default_branch: repo.defaultBranch,
      });
    }
    case 'create_issue': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolErr(`Repository ${owner}/${repoName} not found`);
      const title = typeof args.title === 'string' ? args.title : '';
      const created = repo.createIssue(title, typeof args.body === 'string' ? args.body : '', []);
      if ('error' in created) return toolErr(created.error);
      return toolOk({
        id: created.id,
        number: created.number,
        title: created.title,
        body: created.body,
        state: created.state,
        labels: created.labels.map((l) => ({ name: l.name })),
        user: { login: created.user.login },
        created_at: created.createdAt,
        updated_at: created.updatedAt,
      });
    }
    case 'list_issues': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolErr(`Repository ${owner}/${repoName} not found`);
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = repo.issues
        .filter((i) => state === 'all' || i.state === state)
        .sort((a, b) => b.number - a.number)
        .map((i) => ({ id: i.id, number: i.number, title: i.title, body: i.body, state: i.state, user: { login: i.user.login }, created_at: i.createdAt }));
      return toolOk({ issues });
    }
    case 'create_pull_request': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolErr(`Repository ${owner}/${repoName} not found`);
      const created = repo.createPull(
        typeof args.title === 'string' ? args.title : '',
        typeof args.body === 'string' ? args.body : '',
        typeof args.head === 'string' ? args.head : '',
        typeof args.base === 'string' ? args.base : '',
      );
      if ('error' in created) return toolErr(created.error);
      return toolOk({
        id: created.id,
        number: created.number,
        title: created.title,
        body: created.body,
        state: created.state,
        head: { ref: created.headRef, sha: created.headSha },
        base: { ref: created.baseRef, sha: created.baseSha },
      });
    }
    case 'merge_pull_request': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolErr(`Repository ${owner}/${repoName} not found`);
      const number = asNumber(args.pull_number);
      if (number === null) return toolErr('pull_number is required');
      const pull = repo.getPull(number);
      if (!pull) return toolErr(`Pull request #${number} not found`);
      if (pull.merged || pull.state !== 'open') return toolErr(`Pull request #${number} is already closed`);
      const result = repo.squashMerge(pull);
      if (result === 'conflict') return toolErr('Merge conflict');
      if (result === 'stale') return toolErr('Head branch is stale');
      return toolOk({ merged: true, number: pull.number, sha: result, state: 'closed' });
    }
    default:
      return toolErr(`Unknown tool: ${name}`);
  }
}

/**
 * Handle a POST /mcp body (raw text, so a parse failure can answer -32700).
 * Returns { status, body } where body is null for a 202 notification answer.
 */
export function handleMcp(store: Store, bodyText: string): { status: number; body: Record<string, unknown> | null } {
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (!isRecord(body) || typeof body.method !== 'string') {
    return { status: 400, body: { jsonrpc: '2.0', id: isRecord(body) ? (body.id ?? null) : null, error: { code: -32600, message: 'Invalid Request' } } };
  }
  const id = body.id;
  const method = body.method as string;
  const params = isRecord(body.params) ? body.params : {};

  // Notifications (no id) are acknowledged with 202 and an empty body.
  if (id === undefined) {
    return { status: 202, body: null };
  }

  if (method === 'server/discover') {
    return {
      status: 200,
      body: rpcResult(id, {
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        capabilities: { tools: {} },
        supportedVersions: ['2026-07-28', '2025-11-25'],
      }),
    };
  }

  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? (params.protocolVersion as string) : '';
    const negotiated = ACCEPTED_REVISIONS.includes(offered) ? offered : '2025-11-25';
    return {
      status: 200,
      body: rpcResult(id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      }),
    };
  }

  if (method === 'tools/list') {
    return { status: 200, body: rpcResult(id, { tools: TOOLS }) };
  }

  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const tool = TOOLS.find((t) => t.name === toolName);
    if (!tool) {
      return { status: 200, body: rpcError(id, -32602, `Unknown tool: ${toolName}`) };
    }
    const args = isRecord(params.arguments) ? params.arguments : {};
    const missing = tool.inputSchema.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
    if (missing.length > 0) {
      return { status: 200, body: rpcError(id, -32602, `Missing required argument(s): ${missing.join(', ')}`) };
    }
    const result = callTool(store, toolName, args);
    return { status: 200, body: rpcResult(id, result) };
  }

  if (method === 'ping') {
    return { status: 200, body: rpcResult(id, {}) };
  }

  return { status: 200, body: rpcError(id, -32601, `Method not found: ${method}`) };
}
