// MCP (Model Context Protocol, Streamable HTTP) over the in-memory store.
// Modern era 2026-07-28 via server/discover, with the legacy initialize +
// notifications/initialized fallback. Six tools; every tool result carries
// both a JSON text content block and a structuredContent object.

import { VIEWER_LOGIN, type Store } from './store.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';

export interface McpResult {
  status: number;
  /** JSON-RPC body, or null for a 202 notification acknowledgement (empty body). */
  json: unknown;
}

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2026-07-28';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[] };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the repository to create.' },
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
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        full_name: { type: 'string', description: 'The full name of the repository, owner/repo.' },
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
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the issue.' },
        body: { type: 'string', description: 'The body of the issue.' },
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
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all.', enum: ['open', 'closed', 'all'] },
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
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the pull request.' },
        head: { type: 'string', description: 'The head branch of the pull request.' },
        base: { type: 'string', description: 'The base branch of the pull request.' },
        body: { type: 'string', description: 'The body of the pull request.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        pull_number: { type: 'integer', description: 'The number of the pull request to merge.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function toolResult(obj: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }], structuredContent: obj };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

function repoFromArgs(store: Store, args: Record<string, unknown>): { owner: string; repo: ReturnType<Store['getRepo']> } | { error: string } {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let name = typeof args.repo === 'string' ? args.repo : '';
  if ((owner === '' || name === '') && typeof args.full_name === 'string') {
    const parts = (args.full_name as string).split('/');
    if (parts.length === 2) {
      owner = parts[0] as string;
      name = parts[1] as string;
    }
  }
  if (owner === '' || name === '') return { error: 'owner and repo are required' };
  if (owner !== VIEWER_LOGIN) return { error: 'Repository not found' };
  const repo = store.getRepo(name);
  if (repo === undefined) return { error: 'Repository not found' };
  return { owner, repo };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) return toolError(`Unknown tool: ${name}`);
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return toolError(`Missing required argument: ${required}`);
    }
  }

  if (name === 'create_repo') {
    const repoName = String(args.name);
    if (!/^[A-Za-z0-9._-]+$/.test(repoName)) return toolError('Repository name is invalid');
    if (store.getRepo(repoName) !== undefined) return toolError(`Repository ${VIEWER_LOGIN}/${repoName} already exists`);
    const repo = store.createRepo(repoName, args.private === true, typeof args.description === 'string' ? args.description : '');
    return toolResult(repoJson(store, repo));
  }

  if (name === 'get_repo') {
    const found = repoFromArgs(store, args);
    if ('error' in found) return toolError(found.error);
    return toolResult(repoJson(store, found.repo as NonNullable<ReturnType<Store['getRepo']>>));
  }

  if (name === 'create_issue') {
    const found = repoFromArgs(store, args);
    if ('error' in found) return toolError(found.error);
    const repo = found.repo as NonNullable<ReturnType<Store['getRepo']>>;
    const issue = store.createIssue(repo, String(args.title), typeof args.body === 'string' ? args.body : '', []);
    return toolResult(issueJson(store, repo, issue));
  }

  if (name === 'list_issues') {
    const found = repoFromArgs(store, args);
    if ('error' in found) return toolError(found.error);
    const repo = found.repo as NonNullable<ReturnType<Store['getRepo']>>;
    const state = typeof args.state === 'string' ? args.state : 'open';
    const list = state === 'all' ? [...repo.issues] : repo.issues.filter((issue) => issue.state === state);
    const issues = list.map((issue) => issueJson(store, repo, issue));
    return toolResult({ issues });
  }

  if (name === 'create_pull_request') {
    const found = repoFromArgs(store, args);
    if ('error' in found) return toolError(found.error);
    const repo = found.repo as NonNullable<ReturnType<Store['getRepo']>>;
    const head = String(args.head);
    const base = String(args.base);
    const headTip = store.refTip(repo, head);
    const baseTip = store.refTip(repo, base);
    if (headTip === null) return toolError(`Head branch ${head} does not exist`);
    if (baseTip === null) return toolError(`Base branch ${base} does not exist`);
    if (headTip === baseTip) return toolError('No commits between base and head');
    const existing = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
    if (existing !== undefined) return toolResult(pullJson(store, repo, existing));
    const pull = store.createPull(repo, String(args.title), typeof args.body === 'string' ? args.body : '', head, base);
    return toolResult(pullJson(store, repo, pull));
  }

  if (name === 'merge_pull_request') {
    const found = repoFromArgs(store, args);
    if ('error' in found) return toolError(found.error);
    const repo = found.repo as NonNullable<ReturnType<Store['getRepo']>>;
    const number = Number(args.pull_number);
    const pull = repo.pulls.find((entry) => entry.number === number);
    if (pull === undefined) return toolError('Pull request not found');
    if (pull.state !== 'open') return toolError(pull.merged ? 'Pull request is already merged' : 'Pull request is closed');
    const headTip = store.refTip(repo, pull.headRef);
    const baseTip = store.refTip(repo, pull.baseRef);
    if (headTip === null || baseTip === null) return toolError('Pull request not found');
    const base = store.mergeBase(repo, baseTip, headTip);
    const mergedTree = store.threeWayMerge(repo, baseTip, headTip, base);
    if (mergedTree === null) return toolError('Merge conflict');
    const message = `Merge pull request #${pull.number} from ${pull.headRef}`;
    const mergeSha = repo.store.makeCommit(mergedTree, [baseTip], message, store.epochSec());
    repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = store.now();
    pull.mergeCommitSha = mergeSha;
    pull.updatedAt = store.now();
    repo.updatedAt = store.now();
    return toolResult({ sha: mergeSha, merged: true, message, number: pull.number });
  }

  return toolError(`Unknown tool: ${name}`);
}

export function handleMcp(store: Store, body: unknown): McpResult {
  if (!isRecord(body)) {
    // A non-object body is a JSON-RPC parse error.
    return { status: 400, json: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  const method = typeof body.method === 'string' ? body.method : '';
  const id = 'id' in body ? body.id : undefined;
  const params = isRecord(body.params) ? body.params : {};

  // Notifications carry no id and get an empty 202.
  if (id === undefined) {
    return { status: 202, json: null };
  }

  const respond = (result: unknown): McpResult => ({ status: 200, json: { jsonrpc: '2.0', id, result } });
  const fail = (code: number, message: string): McpResult => ({ status: 200, json: { jsonrpc: '2.0', id, error: { code, message } } });

  if (method === 'server/discover') {
    const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
    return respond({
      supportedVersions: [PROTOCOL_VERSION, '2025-06-18', '2025-03-26'],
      capabilities: { tools: {} },
      serverInfo,
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
    });
  }

  if (method === 'initialize') {
    const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
    return respond({
      protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo,
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
    });
  }

  if (method === 'ping') {
    return respond({});
  }

  if (method === 'tools/list') {
    return respond({ tools: TOOLS });
  }

  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? params.arguments : {};
    const known = TOOLS.some((tool) => tool.name === toolName);
    if (!known) return fail(-32601, `Unknown tool: ${toolName}`);
    const result = callTool(store, toolName, args);
    if (result.isError === true) {
      // Missing required arguments surface as a JSON-RPC error; other tool
      // failures stay a result with isError so the caller can read the text.
      const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';
      if (text.includes('Missing required argument')) return fail(-32602, text);
    }
    return respond(result);
  }

  return fail(-32601, `Method not found: ${method}`);
}
