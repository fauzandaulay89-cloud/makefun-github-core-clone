// GraphQL over the in-memory store: a small parser and executor for exactly the
// documents the conformance suite sends (viewer, repository, issues, pull
// requests, node, __type introspection, and the five mutations). Unknown fields
// are HTTP 200 with an errors array naming the field; an unknown repository
// is data.repository = null with no errors.

import {
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  type Issue,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';
import {
  commentGlobalId,
  globalId,
  issueGlobalId,
  pullGlobalId,
  repoGlobalId,
} from './rest.ts';

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof' };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const push = (token: Token): void => {
    tokens.push(token);
  };
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '#') {
      if (ch === '#') {
        while (i < source.length && source[i] !== '\n') i += 1;
      } else {
        i += 1;
      }
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          const esc = source[i + 1] as string;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          i += 2;
        } else {
          value += source[i] as string;
          i += 1;
        }
      }
      i += 1;
      push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let num = '';
      while (i < source.length && /[0-9.eE+-]/.test(source[i] as string)) {
        num += source[i] as string;
        i += 1;
      }
      if (num.includes('.') || num.includes('e') || num.includes('E')) push({ kind: 'float', value: Number(num) });
      else push({ kind: 'int', value: Number(num) });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let name = '';
      while (i < source.length && /[A-Za-z0-9_]/.test(source[i] as string)) {
        name += source[i] as string;
        i += 1;
      }
      push({ kind: 'name', value: name });
      continue;
    }
    if ('{}()[]:!=$.@'.includes(ch)) {
      if (ch === '.' && source.slice(i, i + 3) === '...') {
        push({ kind: 'punct', value: '...' });
        i += 3;
        continue;
      }
      push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    throw new Error(`Unexpected character ${ch}`);
  }
  push({ kind: 'eof' });
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selections: SelectionNode[] | null;
}

interface InlineFragmentNode {
  kind: 'inline';
  typeCondition: string | null;
  selections: SelectionNode[];
}

interface FragmentSpreadNode {
  kind: 'spread';
  name: string;
}

type SelectionNode = FieldNode | InlineFragmentNode | FragmentSpreadNode;

interface OperationNode {
  operation: 'query' | 'mutation';
  name: string | null;
  variables: Array<{ name: string; defaultValue: ValueNode | null }>;
  selections: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`Expected ${value}, got ${JSON.stringify(token)}`);
  }

  private acceptPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`Expected name, got ${JSON.stringify(token)}`);
    return token.value;
  }

  parseDocument(): { operations: OperationNode[]; fragments: Map<string, SelectionNode[]> } {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, SelectionNode[]>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ operation: 'query', name: null, variables: [], selections: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        const operation = token.value as 'query' | 'mutation';
        this.next();
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.expectName();
        const variables: OperationNode['variables'] = [];
        if (this.acceptPunct('(')) {
          while (!this.acceptPunct(')')) {
            this.expectPunct('$');
            const varName = this.expectName();
            this.expectPunct(':');
            this.parseType();
            let defaultValue: ValueNode | null = null;
            if (this.acceptPunct('=')) defaultValue = this.parseValue();
            variables.push({ name: varName, defaultValue });
          }
        }
        operations.push({ operation, name, variables, selections: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName(); // 'on'
        this.expectName(); // type condition
        fragments.set(name, this.parseSelectionSet());
        continue;
      }
      throw new Error(`Unexpected token ${JSON.stringify(token)}`);
    }
    return { operations, fragments };
  }

  private parseType(): void {
    if (this.acceptPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.acceptPunct('!');
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.acceptPunct('}')) {
      selections.push(this.parseSelection());
    }
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.acceptPunct('...')) {
      const token = this.peek();
      if (token.kind === 'name' && token.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'inline', typeCondition, selections: this.parseSelectionSet() };
      }
      if (token.kind === 'name') {
        return { kind: 'spread', name: this.expectName() };
      }
      return { kind: 'inline', typeCondition: null, selections: this.parseSelectionSet() };
    }
    let alias: string | null = null;
    let name = this.expectName();
    if (this.acceptPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    const args: FieldNode['args'] = [];
    if (this.acceptPunct('(')) {
      while (!this.acceptPunct(')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
    }
    let selections: SelectionNode[] | null = null;
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selections };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!this.acceptPunct(']')) values.push(this.parseValue());
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.acceptPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    throw new Error(`Unexpected value token ${JSON.stringify(token)}`);
  }
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

interface Ctx {
  store: Store;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
  fragments: Map<string, SelectionNode[]>;
}

type AnyObject = { __type: string; [key: string]: unknown };

function valueOf(node: ValueNode, ctx: Ctx): unknown {
  switch (node.kind) {
    case 'variable':
      return ctx.variables[node.name] ?? null;
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((child) => valueOf(child, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueOf(field.value, ctx);
      return out;
    }
  }
}

function argsOf(field: FieldNode, ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = valueOf(arg.value, ctx);
  return out;
}

function cursorFor(seq: number): string {
  return Buffer.from(`cursor:${seq}`, 'utf8').toString('base64');
}

function seqAfter(after: unknown): number {
  if (typeof after !== 'string') return 0;
  try {
    const decoded = Buffer.from(after, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(decoded);
    return match === null ? 0 : Number(match[1]);
  } catch {
    return 0;
  }
}

function pageInfoFor(items: Array<{ seq: number }>, first: number | null, remaining: number): Record<string, unknown> {
  const last = items.length > 0 ? items[items.length - 1] : undefined;
  const firstItem = items.length > 0 ? items[0] : undefined;
  return {
    hasNextPage: first !== null && remaining > 0,
    hasPreviousPage: false,
    startCursor: firstItem === undefined ? null : cursorFor(firstItem.seq),
    endCursor: last === undefined ? null : cursorFor(last.seq),
  };
}

const ISSUE_FIELDS = ['id', 'number', 'title', 'state', 'body'];
const PULL_FIELDS = ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'];
const REPO_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'];
const SEARCH_ENUMS = ['ISSUE', 'REPOSITORY', 'USER'];

function viewerObject(): AnyObject {
  return { __type: 'User', login: VIEWER_LOGIN, name: VIEWER_NAME, databaseId: VIEWER_ID, id: globalId('User', VIEWER_LOGIN), email: `${VIEWER_LOGIN}@example.invalid` };
}

function repoObject(store: Store, repo: Repo): AnyObject {
  return { __type: 'Repository', repo, store };
}

function issueObject(store: Store, repo: Repo, issue: Issue): AnyObject {
  return { __type: 'Issue', repo, store, issue };
}

function pullObject(store: Store, repo: Repo, pull: PullRequest): AnyObject {
  return { __type: 'PullRequest', repo, store, pull };
}

function issuesConnection(store: Store, repo: Repo, args: Record<string, unknown>): AnyObject {
  let list = [...repo.issues];
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length > 0) {
    list = list.filter((issue) => states.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  const direction = orderBy?.direction ?? 'DESC';
  list.sort((a, b) => (direction === 'ASC' ? a.seq - b.seq : b.seq - a.seq));
  const afterSeq = seqAfter(args.after);
  const filtered = afterSeq === 0 ? list : direction === 'ASC' ? list.filter((issue) => issue.seq > afterSeq) : list.filter((issue) => issue.seq < afterSeq);
  const first = typeof args.first === 'number' ? args.first : null;
  const page = first === null ? filtered : filtered.slice(0, first);
  return {
    __type: 'IssueConnection',
    nodes: page.map((issue) => issueObject(store, repo, issue)),
    edges: page.map((issue) => ({ __type: 'IssueEdge', node: issueObject(store, repo, issue), cursor: cursorFor(issue.seq) })),
    pageInfo: pageInfoFor(page, first, filtered.length - page.length),
    totalCount: filtered.length,
  };
}

function pullsConnection(store: Store, repo: Repo, args: Record<string, unknown>): AnyObject {
  let list = [...repo.pulls];
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length > 0) {
    list = list.filter((pull) => states.includes(pull.state === 'open' ? 'OPEN' : pull.merged ? 'MERGED' : 'CLOSED'));
  }
  list.sort((a, b) => b.seq - a.seq);
  const afterSeq = seqAfter(args.after);
  const filtered = afterSeq === 0 ? list : list.filter((pull) => pull.seq < afterSeq);
  const first = typeof args.first === 'number' ? args.first : null;
  const page = first === null ? filtered : filtered.slice(0, first);
  return {
    __type: 'PullRequestConnection',
    nodes: page.map((pull) => pullObject(store, repo, pull)),
    edges: page.map((pull) => ({ __type: 'PullRequestEdge', node: pullObject(store, repo, pull), cursor: cursorFor(pull.seq) })),
    pageInfo: pageInfoFor(page, first, filtered.length - page.length),
    totalCount: filtered.length,
  };
}

function decodeGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const decoded = Buffer.from(id, 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon < 0) return null;
    return { kind: decoded.slice(0, colon), key: decoded.slice(colon + 1) };
  } catch {
    return null;
  }
}

function resolveNode(ctx: Ctx, id: string): AnyObject | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  const { store } = ctx;
  if (decoded.kind === 'Repository') {
    const [owner, name] = decoded.key.split('/');
    if (owner !== VIEWER_LOGIN || name === undefined) return null;
    const repo = store.getRepo(name);
    return repo === undefined ? null : repoObject(store, repo);
  }
  if (decoded.kind === 'Issue') {
    const match = /^([^/]+)\/([^#]+)#(\d+)$/.exec(decoded.key);
    if (match === null) return null;
    const repo = store.getRepo(match[2] as string);
    if (repo === undefined) return null;
    const issue = repo.issues.find((entry) => entry.number === Number(match[3]));
    return issue === undefined ? null : issueObject(store, repo, issue);
  }
  if (decoded.kind === 'PullRequest') {
    const match = /^([^/]+)\/([^#]+)#(\d+)$/.exec(decoded.key);
    if (match === null) return null;
    const repo = store.getRepo(match[2] as string);
    if (repo === undefined) return null;
    const pull = repo.pulls.find((entry) => entry.number === Number(match[3]));
    return pull === undefined ? null : pullObject(store, repo, pull);
  }
  if (decoded.kind === 'User') return viewerObject();
  return null;
}

function mergePull(store: Store, repo: Repo, pull: PullRequest): boolean {
  if (pull.state !== 'open') return pull.merged;
  const headTip = store.refTip(repo, pull.headRef);
  const baseTip = store.refTip(repo, pull.baseRef);
  if (headTip === null || baseTip === null) return false;
  const base = store.mergeBase(repo, baseTip, headTip);
  const mergedTree = store.threeWayMerge(repo, baseTip, headTip, base);
  if (mergedTree === null) return false;
  const message = `Merge pull request #${pull.number} from ${pull.headRef}`;
  const mergeSha = repo.store.makeCommit(mergedTree, [baseTip], message, store.epochSec());
  repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = store.now();
  pull.mergeCommitSha = mergeSha;
  pull.updatedAt = store.now();
  repo.updatedAt = store.now();
  return true;
}

type FieldResolver = (obj: AnyObject, args: Record<string, unknown>, ctx: Ctx) => unknown;

const RESOLVERS: Record<string, Record<string, FieldResolver>> = {
  Query: {
    viewer: () => viewerObject(),
    repository: (_obj, args, ctx) => {
      const owner = args.owner as string;
      const name = args.name as string;
      if (owner !== VIEWER_LOGIN) return null;
      const repo = ctx.store.getRepo(name);
      return repo === undefined ? null : repoObject(ctx.store, repo);
    },
    node: (_obj, args, ctx) => resolveNode(ctx, String(args.id ?? '')),
    __type: (_obj, args) => {
      const name = args.name as string;
      if (name === 'Issue') return { __type: '__Type', name, kind: 'OBJECT', fields: ISSUE_FIELDS.map((field) => ({ __type: '__Field', name: field })) };
      if (name === 'PullRequest') return { __type: '__Type', name, kind: 'OBJECT', fields: PULL_FIELDS.map((field) => ({ __type: '__Field', name: field })) };
      if (name === 'Repository') return { __type: '__Type', name, kind: 'OBJECT', fields: REPO_FIELDS.map((field) => ({ __type: '__Field', name: field })) };
      if (name === 'SearchType') return { __type: '__Type', name, kind: 'ENUM', enumValues: SEARCH_ENUMS.map((value) => ({ __type: '__EnumValue', name: value })) };
      return { __type: '__Type', name: null, kind: null, fields: null, enumValues: null };
    },
    __schema: () => ({ __type: '__Schema', types: ['Query', 'Repository', 'Issue', 'PullRequest', 'User'].map((name) => ({ __type: '__Type', name })) }),
  },
  Mutation: {
    createIssue: (_obj, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      if (decoded === null || decoded.kind !== 'Repository') return { __type: 'CreateIssuePayload', issue: null };
      const name = decoded.key.split('/')[1] as string;
      const repo = ctx.store.getRepo(name);
      if (repo === undefined) return { __type: 'CreateIssuePayload', issue: null };
      const issue = ctx.store.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
      return { __type: 'CreateIssuePayload', issue: issueObject(ctx.store, repo, issue) };
    },
    closeIssue: (_obj, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.issueId ?? ''));
      if (decoded === null || decoded.kind !== 'Issue') return { __type: 'CloseIssuePayload', issue: null };
      const match = /^([^/]+)\/([^#]+)#(\d+)$/.exec(decoded.key);
      if (match === null) return { __type: 'CloseIssuePayload', issue: null };
      const repo = ctx.store.getRepo(match[2] as string);
      const issue = repo?.issues.find((entry) => entry.number === Number(match[3]));
      if (issue === undefined || repo === undefined) return { __type: 'CloseIssuePayload', issue: null };
      issue.state = 'closed';
      issue.closedAt = ctx.store.now();
      issue.updatedAt = ctx.store.now();
      return { __type: 'CloseIssuePayload', issue: issueObject(ctx.store, repo, issue) };
    },
    createPullRequest: (_obj, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      if (decoded === null || decoded.kind !== 'Repository') return { __type: 'CreatePullRequestPayload', pullRequest: null };
      const name = decoded.key.split('/')[1] as string;
      const repo = ctx.store.getRepo(name);
      if (repo === undefined) return { __type: 'CreatePullRequestPayload', pullRequest: null };
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? '');
      const headTip = ctx.store.refTip(repo, head);
      const baseTip = ctx.store.refTip(repo, base);
      if (headTip === null || baseTip === null || headTip === baseTip) return { __type: 'CreatePullRequestPayload', pullRequest: null };
      const existing = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
      if (existing !== undefined) return { __type: 'CreatePullRequestPayload', pullRequest: pullObject(ctx.store, repo, existing) };
      const pull = ctx.store.createPull(repo, String(input.title ?? ''), '', head, base);
      return { __type: 'CreatePullRequestPayload', pullRequest: pullObject(ctx.store, repo, pull) };
    },
    mergePullRequest: (_obj, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
      if (decoded === null || decoded.kind !== 'PullRequest') return { __type: 'MergePullRequestPayload', pullRequest: null };
      const match = /^([^/]+)\/([^#]+)#(\d+)$/.exec(decoded.key);
      if (match === null) return { __type: 'MergePullRequestPayload', pullRequest: null };
      const repo = ctx.store.getRepo(match[2] as string);
      const pull = repo?.pulls.find((entry) => entry.number === Number(match[3]));
      if (pull === undefined || repo === undefined) return { __type: 'MergePullRequestPayload', pullRequest: null };
      mergePull(ctx.store, repo, pull);
      return { __type: 'MergePullRequestPayload', pullRequest: pullObject(ctx.store, repo, pull) };
    },
    addComment: (_obj, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.subjectId ?? ''));
      if (decoded === null || decoded.kind !== 'Issue') return { __type: 'AddCommentPayload', commentEdge: null };
      const match = /^([^/]+)\/([^#]+)#(\d+)$/.exec(decoded.key);
      if (match === null) return { __type: 'AddCommentPayload', commentEdge: null };
      const repo = ctx.store.getRepo(match[2] as string);
      const issue = repo?.issues.find((entry) => entry.number === Number(match[3]));
      if (issue === undefined || repo === undefined) return { __type: 'AddCommentPayload', commentEdge: null };
      const comment = ctx.store.createComment(repo, issue, String(input.body ?? ''));
      return {
        __type: 'AddCommentPayload',
        commentEdge: {
          __type: 'IssueCommentEdge',
          node: { __type: 'IssueComment', id: commentGlobalId(repo, issue, comment.id), databaseId: comment.id, body: comment.body },
          cursor: cursorFor(comment.id),
        },
      };
    },
  },
  User: {
    login: (obj) => obj.login,
    name: (obj) => obj.name,
    id: (obj) => obj.id,
    databaseId: (obj) => obj.databaseId,
    email: (obj) => obj.email,
  },
  Repository: {
    id: (_obj, _args, ctx) => repoGlobalId((_obj as AnyObject).repo as Repo),
    databaseId: (obj) => (obj.repo as Repo).id,
    name: (obj) => (obj.repo as Repo).name,
    nameWithOwner: (obj) => `${VIEWER_LOGIN}/${(obj.repo as Repo).name}`,
    owner: () => viewerObject(),
    defaultBranchRef: (obj, _args, ctx) => {
      const repo = obj.repo as Repo;
      const tip = ctx.store.defaultTip(repo);
      return tip === null ? null : { __type: 'Ref', name: repo.defaultBranch };
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    issue: (obj, args, ctx) => {
      const repo = obj.repo as Repo;
      const issue = repo.issues.find((entry) => entry.number === Number(args.number));
      return issue === undefined ? null : issueObject(ctx.store, repo, issue);
    },
    issues: (obj, args, ctx) => issuesConnection(ctx.store, obj.repo as Repo, args),
    pullRequest: (obj, args, ctx) => {
      const repo = obj.repo as Repo;
      const pull = repo.pulls.find((entry) => entry.number === Number(args.number));
      return pull === undefined ? null : pullObject(ctx.store, repo, pull);
    },
    pullRequests: (obj, args, ctx) => pullsConnection(ctx.store, obj.repo as Repo, args),
  },
  Issue: {
    id: (obj, _args, ctx) => issueGlobalId(obj.repo as Repo, obj.issue as Issue),
    databaseId: (obj) => (obj.issue as Issue).id,
    number: (obj) => (obj.issue as Issue).number,
    title: (obj) => (obj.issue as Issue).title,
    body: (obj) => (obj.issue as Issue).body,
    state: (obj) => ((obj.issue as Issue).state === 'open' ? 'OPEN' : 'CLOSED'),
    createdAt: (obj) => (obj.issue as Issue).createdAt,
    updatedAt: (obj) => (obj.issue as Issue).updatedAt,
    closedAt: (obj) => (obj.issue as Issue).closedAt,
    author: () => viewerObject(),
    labels: (obj) => ({
      __type: 'LabelConnection',
      nodes: (obj.issue as Issue).labels.map((label) => ({ __type: 'Label', id: label.id, name: label.name, color: label.color })),
    }),
  },
  PullRequest: {
    id: (obj) => pullGlobalId(obj.repo as Repo, obj.pull as PullRequest),
    databaseId: (obj) => (obj.pull as PullRequest).id,
    number: (obj) => (obj.pull as PullRequest).number,
    title: (obj) => (obj.pull as PullRequest).title,
    body: (obj) => (obj.pull as PullRequest).body,
    state: (obj) => {
      const pull = obj.pull as PullRequest;
      return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
    },
    merged: (obj) => (obj.pull as PullRequest).merged,
    mergeable: (obj, _args, ctx) => {
      const repo = obj.repo as Repo;
      const pull = obj.pull as PullRequest;
      if (pull.state !== 'open') return 'UNKNOWN';
      return ctx.store.prMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
    },
    headRefName: (obj) => (obj.pull as PullRequest).headRef,
    baseRefName: (obj) => (obj.pull as PullRequest).baseRef,
    headRef: (obj) => ({ __type: 'Ref', name: (obj.pull as PullRequest).headRef }),
    baseRef: (obj) => ({ __type: 'Ref', name: (obj.pull as PullRequest).baseRef }),
    createdAt: (obj) => (obj.pull as PullRequest).createdAt,
    updatedAt: (obj) => (obj.pull as PullRequest).updatedAt,
    files: (obj, args, ctx) => {
      const repo = obj.repo as Repo;
      const pull = obj.pull as PullRequest;
      const headTip = ctx.store.refTip(repo, pull.headRef);
      const baseTip = ctx.store.refTip(repo, pull.baseRef);
      const headTree = headTip === null ? null : repo.store.commitTree(headTip);
      const baseTree = baseTip === null ? null : repo.store.commitTree(baseTip);
      const diff = ctx.store.diffTrees(repo, baseTree, headTree);
      const first = typeof args.first === 'number' ? args.first : null;
      const page = first === null ? diff : diff.slice(0, first);
      return {
        __type: 'PullRequestChangedFileConnection',
        nodes: page.map((entry) => ({ __type: 'PullRequestChangedFile', path: entry.filename, additions: entry.additions, deletions: entry.deletions, changeType: entry.status.toUpperCase() })),
        totalCount: diff.length,
      };
    },
  },
  Ref: {
    name: (obj) => obj.name,
  },
  IssueConnection: {
    nodes: (obj) => obj.nodes,
    edges: (obj) => obj.edges,
    pageInfo: (obj) => obj.pageInfo,
    totalCount: (obj) => obj.totalCount,
  },
  PullRequestConnection: {
    nodes: (obj) => obj.nodes,
    edges: (obj) => obj.edges,
    pageInfo: (obj) => obj.pageInfo,
    totalCount: (obj) => obj.totalCount,
  },
  IssueEdge: {
    node: (obj) => obj.node,
    cursor: (obj) => obj.cursor,
  },
  PullRequestEdge: {
    node: (obj) => obj.node,
    cursor: (obj) => obj.cursor,
  },
  PageInfo: {
    hasNextPage: (obj) => obj.hasNextPage,
    hasPreviousPage: (obj) => obj.hasPreviousPage,
    startCursor: (obj) => obj.startCursor,
    endCursor: (obj) => obj.endCursor,
  },
  __Type: {
    name: (obj) => obj.name,
    kind: (obj) => obj.kind,
    fields: (obj) => (obj.fields as unknown[] | null) ?? null,
    enumValues: (obj) => (obj.enumValues as unknown[] | null) ?? null,
  },
  __Field: {
    name: (obj) => obj.name,
  },
  __EnumValue: {
    name: (obj) => obj.name,
  },
  __Schema: {
    types: (obj) => obj.types,
  },
  LabelConnection: {
    nodes: (obj) => obj.nodes,
  },
  Label: {
    id: (obj) => globalId('Label', String(obj.name)),
    name: (obj) => obj.name,
    color: (obj) => obj.color,
  },
  CreateIssuePayload: {
    issue: (obj) => obj.issue,
    clientMutationId: () => null,
  },
  CloseIssuePayload: {
    issue: (obj) => obj.issue,
    clientMutationId: () => null,
  },
  CreatePullRequestPayload: {
    pullRequest: (obj) => obj.pullRequest,
    clientMutationId: () => null,
  },
  MergePullRequestPayload: {
    pullRequest: (obj) => obj.pullRequest,
    clientMutationId: () => null,
  },
  AddCommentPayload: {
    commentEdge: (obj) => obj.commentEdge,
    clientMutationId: () => null,
  },
  IssueCommentEdge: {
    node: (obj) => obj.node,
    cursor: (obj) => obj.cursor,
  },
  IssueComment: {
    id: (obj) => obj.id,
    databaseId: (obj) => obj.databaseId,
    body: (obj) => obj.body,
  },
  PullRequestChangedFileConnection: {
    nodes: (obj) => obj.nodes,
    totalCount: (obj) => obj.totalCount,
  },
  PullRequestChangedFile: {
    path: (obj) => obj.path,
    additions: (obj) => obj.additions,
    deletions: (obj) => obj.deletions,
    changeType: (obj) => obj.changeType,
  },
};

function resolveField(obj: AnyObject, field: FieldNode, ctx: Ctx): unknown {
  const typeName = obj.__type;
  const table = RESOLVERS[typeName];
  const resolver = table?.[field.name];
  if (resolver === undefined) {
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
    return null;
  }
  return resolver(obj, argsOf(field, ctx), ctx);
}

function resolveSelections(obj: AnyObject, selections: SelectionNode[], ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined) Object.assign(out, resolveSelections(obj, fragment, ctx));
      continue;
    }
    if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === obj.__type) {
        Object.assign(out, resolveSelections(obj, selection.selections, ctx));
      }
      continue;
    }
    const responseKey = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[responseKey] = obj.__type;
      continue;
    }
    const value = resolveField(obj, selection, ctx);
    if (value === null || value === undefined) {
      out[responseKey] = null;
      continue;
    }
    if (selection.selections === null) {
      out[responseKey] = value;
      continue;
    }
    if (typeof value === 'object' && '__type' in (value as Record<string, unknown>)) {
      out[responseKey] = resolveSelections(value as AnyObject, selection.selections, ctx);
      continue;
    }
    if (Array.isArray(value)) {
      out[responseKey] = value.map((item) =>
        typeof item === 'object' && item !== null && '__type' in (item as Record<string, unknown>)
          ? resolveSelections(item as AnyObject, selection.selections as SelectionNode[], ctx)
          : item,
      );
      continue;
    }
    out[responseKey] = value;
  }
  return out;
}

export interface GraphqlResult {
  status: number;
  json: unknown;
}

function executeOperation(store: Store, operation: OperationNode, variables: Record<string, unknown>, fragments: Map<string, SelectionNode[]>): Record<string, unknown> {
  const ctx: Ctx = { store, variables, errors: [], fragments };
  for (const variable of operation.variables) {
    if (!(variable.name in ctx.variables) && variable.defaultValue !== null) {
      ctx.variables[variable.name] = valueOf(variable.defaultValue, ctx);
    }
  }
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const root: AnyObject = { __type: rootType };
  const data = resolveSelections(root, operation.selections, ctx);
  const result: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

export function handleGraphql(store: Store, body: unknown): GraphqlResult {
  const run = (payload: unknown): Record<string, unknown> => {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      return { data: null, errors: [{ message: 'Request body must be a JSON object with a query string.' }] };
    }
    const record = payload as Record<string, unknown>;
    if (typeof record.query !== 'string') {
      return { data: null, errors: [{ message: 'Request body must include a query string.' }] };
    }
    let parsed: ReturnType<Parser['parseDocument']>;
    try {
      parsed = new Parser(lex(record.query)).parseDocument();
    } catch (error) {
      return { data: null, errors: [{ message: `GraphQL syntax error: ${error instanceof Error ? error.message : String(error)}` }] };
    }
    const operationName = typeof record.operationName === 'string' ? record.operationName : null;
    let operation = parsed.operations[0];
    if (operationName !== null) {
      operation = parsed.operations.find((candidate) => candidate.name === operationName) ?? parsed.operations[0] as OperationNode;
    }
    if (operation === undefined) return { data: null, errors: [{ message: 'No operation found in document.' }] };
    const variables = (record.variables ?? {}) as Record<string, unknown>;
    return executeOperation(store, operation, variables, parsed.fragments);
  };
  if (Array.isArray(body)) {
    return { status: 200, json: body.map((payload) => run(payload)) };
  }
  return { status: 200, json: run(body) };
}
