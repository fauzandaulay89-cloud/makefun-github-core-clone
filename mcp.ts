// MCP at /mcp: JSON-RPC 2.0 Streamable HTTP for the 2026-07-28 revision
// (server/discover) with a 2025-11-25 legacy handshake fallback. The six
// tools share the same store as REST and GraphQL.

import { type Issue, type Repo, type Store } from './store.ts';
import { createIssueInRepo, createPullInRepo, issueJson, pullJson, repoJson } from './rest.ts';

export const MCP_SERVER_INFO = { name: 'github-forge', version: '1.0.0' };
export const MCP_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const str = (desc: string) => ({ type: 'string', description: desc });

export const MCP_TOOLS: Record<string, unknown>[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: { name: str('Name of the repository to create.'), description: str('Repository description.'), private: { type: 'boolean', description: 'Whether the repository is private.' } },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and repository name.',
    inputSchema: {
      type: 'object',
      properties: { owner: str('Owner login of the repository.'), repo: str('Name of the repository.') },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('Owner login of the repository.'),
        repo: str('Name of the repository.'),
        title: str('Title of the issue.'),
        body: str('Body of the issue.'),
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('Owner login of the repository.'),
        repo: str('Name of the repository.'),
        state: str('Issue state filter: open, closed or all.'),
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('Owner login of the repository.'),
        repo: str('Name of the repository.'),
        title: str('Title of the pull request.'),
        head: str('Name of the head branch.'),
        base: str('Name of the base branch.'),
        body: str('Body of the pull request.'),
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit onto its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('Owner login of the repository.'),
        repo: str('Name of the repository.'),
        pull_number: { type: 'integer', description: 'Number of the pull request to merge.' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
];

interface RpcError {
  code: number;
  message: string;
}

function okResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function errResult(id: unknown, e: RpcError): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: e };
}

function textResult(payload: unknown): Record<string, unknown> {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return { content: [{ type: 'text', text }], structuredContent: payload };
}

function errorTextResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

function normName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9_]/g, '');
}

function findTool(name: string): Record<string, unknown> | undefined {
  const n = normName(name);
  for (const t of MCP_TOOLS) {
    const tn = normName(String(t.name));
    if (tn === n || n.endsWith(tn) || tn.endsWith(n)) return t;
  }
  return undefined;
}

function resolveRepo(store: Store, args: Record<string, unknown>): Repo | null {
  const owner = typeof args.owner === 'string' ? args.owner : typeof args.owner_login === 'string' ? args.owner_login : '';
  let repoName = '';
  if (typeof args.repo === 'string') repoName = args.repo;
  else if (typeof args.repository === 'string') repoName = args.repository;
  else if (typeof args.full_name === 'string') {
    const parts = args.full_name.split('/');
    if (parts.length === 2) repoName = parts[1]!;
  }
  if (owner !== store.login) return null;
  return store.getRepo(owner, repoName) ?? null;
}

function missingArg(args: Record<string, unknown>, required: string[]): string | null {
  for (const r of required) {
    const v = args[r];
    if (v === undefined || v === null || v === '') return r;
  }
  return null;
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = findTool(name);
  if (!tool) throw { code: -32601, message: `Method not found: ${name}` } as RpcError;
  const toolName = String(tool.name);
  const schema = tool.inputSchema as { required?: string[] };
  const required = schema.required ?? [];
  // Synonym mapping: the client may fill a differently-named property.
  const aliases: Record<string, string[]> = {
    owner: ['owner_login', 'org', 'login', 'username'],
    repo: ['repository', 'repo_name', 'repository_name'],
    title: ['name'],
    head: ['head_ref', 'head_branch', 'source_branch', 'source'],
    base: ['base_ref', 'base_branch', 'target_branch', 'target'],
    pull_number: ['pr_number', 'number', 'pull_request_number'],
    body: ['description', 'content'],
  };
  const merged: Record<string, unknown> = { ...args };
  for (const [canonical, alts] of Object.entries(aliases)) {
    if (merged[canonical] === undefined) {
      for (const a of alts) {
        if (merged[a] !== undefined) {
          merged[canonical] = merged[a];
          break;
        }
      }
    }
  }
  if (typeof merged.full_name === 'string' && (merged.owner === undefined || merged.repo === undefined)) {
    const parts = (merged.full_name as string).split('/');
    if (parts.length === 2) {
      if (merged.owner === undefined) merged.owner = parts[0];
      if (merged.repo === undefined) merged.repo = parts[1];
    }
  }
  const missing = missingArg(merged, required);
  if (missing) return errorTextResult(`Missing required argument: ${missing}`);

  if (toolName === 'create_repo') {
    const repoName = String(merged.name);
    if (store.getRepo(store.login, repoName)) return errorTextResult(`Repository ${repoName} already exists`);
    const repo = store.createRepo(repoName, merged.private === true, typeof merged.description === 'string' ? merged.description : '');
    return textResult(repoJson(store, repo));
  }
  if (toolName === 'get_repo') {
    const repo = resolveRepo(store, merged);
    if (!repo) return errorTextResult('Repository not found');
    return textResult(repoJson(store, repo));
  }
  if (toolName === 'create_issue') {
    const repo = resolveRepo(store, merged);
    if (!repo) return errorTextResult('Repository not found');
    const iss = createIssueInRepo(store, repo, String(merged.title), typeof merged.body === 'string' ? merged.body : '');
    return textResult(JSON.parse(issueJson(store, repo, iss)));
  }
  if (toolName === 'list_issues') {
    const repo = resolveRepo(store, merged);
    if (!repo) return errorTextResult('Repository not found');
    const state = typeof merged.state === 'string' ? merged.state : 'open';
    let list = [...repo.issues];
    if (state === 'open') list = list.filter((i) => i.state === 'open');
    else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
    list.sort((a, b) => b.number - a.number);
    const issues = list.map((i) => JSON.parse(issueJson(store, repo, i)) as Issue);
    return textResult({ issues });
  }
  if (toolName === 'create_pull_request') {
    const repo = resolveRepo(store, merged);
    if (!repo) return errorTextResult('Repository not found');
    const pr = createPullInRepo(
      store,
      repo,
      String(merged.title),
      typeof merged.body === 'string' ? merged.body : '',
      String(merged.head),
      String(merged.base),
    );
    if (!pr) return errorTextResult('Head or base branch not found');
    return textResult(pullJson(store, repo, pr));
  }
  if (toolName === 'merge_pull_request') {
    const repo = resolveRepo(store, merged);
    if (!repo) return errorTextResult('Repository not found');
    const num = Number(merged.pull_number);
    const pr = repo.pulls.find((p) => p.number === num);
    if (!pr) return errorTextResult('Pull request not found');
    if (pr.merged && pr.mergeSha) return textResult({ sha: pr.mergeSha, merged: true, number: pr.number, pull_number: pr.number });
    if (store.prConflicted(repo, pr)) return errorTextResult('Merge conflict');
    const sha = store.mergePull(repo, pr);
    if (!sha) return errorTextResult('Merge conflict');
    pr.state = 'closed';
    pr.merged = true;
    pr.mergeSha = sha;
    pr.mergedAt = store.isoFromSeq(store.timeSeq);
    return textResult({ sha, merged: true, number: pr.number, pull_number: pr.number });
  }
  throw { code: -32601, message: `Method not found: ${name}` } as RpcError;
}

export interface McpResult {
  status: number;
  headers?: Record<string, string>;
  body: string | null;
}

export function handleMcp(store: Store, raw: Buffer, headers: Record<string, string | string[] | undefined>): McpResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return {
      status: 400,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }),
    };
  }
  const req = parsed as Record<string, unknown>;
  const id = req.id;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = (req.params ?? {}) as Record<string, unknown>;
  const isNotification = id === undefined;

  const sessionId = typeof headers['mcp-session-id'] === 'string' ? headers['mcp-session-id'] : 'session-1';
  const respHeaders: Record<string, string> = { 'content-type': 'application/json', 'mcp-session-id': sessionId };

  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return { status: 202, headers: respHeaders, body: null };
  }

  try {
    if (method === 'server/discover') {
      const result = {
        protocolVersion: '2026-07-28',
        supportedVersions: MCP_VERSIONS,
        serverInfo: MCP_SERVER_INFO,
        capabilities: { tools: {} },
        _meta: { 'io.modelcontextprotocol/serverInfo': MCP_SERVER_INFO },
      };
      return { status: 200, headers: respHeaders, body: JSON.stringify(okResult(id, result)) };
    }
    if (method === 'initialize') {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
      const version = MCP_VERSIONS.includes(requested) ? requested : '2025-11-25';
      const result = {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: MCP_SERVER_INFO,
        instructions: 'GitHub-compatible git forge MCP server.',
      };
      return { status: 200, headers: respHeaders, body: JSON.stringify(okResult(id, result)) };
    }
    if (method === 'ping') {
      return { status: 200, headers: respHeaders, body: JSON.stringify(okResult(id, {})) };
    }
    if (method === 'tools/list') {
      // Byte-identical every time: the constant array is never mutated.
      return { status: 200, headers: respHeaders, body: JSON.stringify(okResult(id, { tools: MCP_TOOLS })) };
    }
    if (method === 'tools/call') {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const result = callTool(store, toolName, args);
      return { status: 200, headers: respHeaders, body: JSON.stringify(okResult(id, result)) };
    }
    if (isNotification) {
      return { status: 202, headers: respHeaders, body: null };
    }
    return { status: 200, headers: respHeaders, body: JSON.stringify(errResult(id, { code: -32601, message: `Method not found: ${method}` })) };
  } catch (e) {
    if (e && typeof e === 'object' && 'code' in (e as Record<string, unknown>)) {
      const rpc = e as RpcError;
      return { status: 200, headers: respHeaders, body: JSON.stringify(errResult(id, rpc)) };
    }
    return { status: 200, headers: respHeaders, body: JSON.stringify(errResult(id, { code: -32603, message: 'Internal error' })) };
  }
}
