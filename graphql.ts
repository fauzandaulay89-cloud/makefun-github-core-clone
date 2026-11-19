// GraphQL at /api/graphql: a small self-contained parser + executor over the
// shared store. Supports operations, aliases, variables, inline arguments,
// lists/objects, inline fragments, fragment spreads, batched arrays and
// introspection (__type / __schema). Unknown fields produce HTTP 200 with an
// errors array; unknown repositories produce data.repository null.

import {
  gid,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import { createIssueInRepo, createPullInRepo } from './rest.ts';

// ---------------------------------------------------------------------------
// Lexer / parser
// ---------------------------------------------------------------------------

type Tok =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'var'; value: string };

function lex(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      i++;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '"') {
      // block string """...""" or quoted string
      if (src.startsWith('"""', i)) {
        const end = src.indexOf('"""', i + 3);
        const text = end === -1 ? src.slice(i + 3) : src.slice(i + 3, end);
        toks.push({ kind: 'string', value: text.replace(/\\"""/g, '"""') });
        i = end === -1 ? src.length : end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1]!;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += src[j]!;
          j++;
        }
      }
      toks.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (c === '$') {
      let j = i + 1;
      while (j < src.length && /[_A-Za-z0-9]/.test(src[j]!)) j++;
      toks.push({ kind: 'var', value: src.slice(i + 1, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(c)) {
      let j = i;
      while (j < src.length && /[_A-Za-z0-9]/.test(src[j]!)) j++;
      toks.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      if (src[j] === '-') j++;
      while (j < src.length && /[0-9]/.test(src[j]!)) j++;
      let isFloat = false;
      if (src[j] === '.') {
        isFloat = true;
        j++;
        while (j < src.length && /[0-9]/.test(src[j]!)) j++;
      }
      if (src[j] === 'e' || src[j] === 'E') {
        isFloat = true;
        j++;
        if (src[j] === '+' || src[j] === '-') j++;
        while (j < src.length && /[0-9]/.test(src[j]!)) j++;
      }
      toks.push({ kind: isFloat ? 'float' : 'int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if ('{}()[]:!@=&|'.includes(c) || c === '.') {
      if (c === '.' && src.startsWith('...', i)) {
        toks.push({ kind: 'punct', value: '...' });
        i += 3;
        continue;
      }
      toks.push({ kind: 'punct', value: c });
      i++;
      continue;
    }
    i++;
  }
  return toks;
}

export interface ValueNode {
  kind: 'string' | 'int' | 'float' | 'bool' | 'null' | 'enum' | 'var' | 'list' | 'object';
  value?: unknown;
  items?: ValueNode[];
  fields?: { name: string; value: ValueNode }[];
}

export interface Selection {
  kind: 'field' | 'fragmentSpread' | 'inlineFragment';
  name?: string;
  alias?: string;
  args?: { name: string; value: ValueNode }[];
  selections?: Selection[];
  typeCondition?: string;
  fragmentName?: string;
}

export interface Operation {
  type: 'query' | 'mutation' | 'subscription';
  name?: string;
  variableDefs?: { name: string; defaultValue?: ValueNode }[];
  selections: Selection[];
}

export interface Document {
  operations: Operation[];
  fragments: Map<string, { typeCondition: string; selections: Selection[] }>;
}

class Parser {
  private pos = 0;
  private toks: Tok[];
  constructor(toks: Tok[]) {
    this.toks = toks;
  }

  private peek(): Tok | undefined {
    return this.toks[this.pos];
  }
  private next(): Tok | undefined {
    return this.toks[this.pos++];
  }
  private expectPunct(v: string): void {
    const t = this.next();
    if (t?.kind !== 'punct' || t.value !== v) throw new Error(`expected ${v}`);
  }
  private expectName(v?: string): string {
    const t = this.next();
    if (t?.kind !== 'name') throw new Error('expected name');
    if (v && t.value !== v) throw new Error(`expected ${v}`);
    return t.value;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, { typeCondition: string; selections: Selection[] }>();
    while (this.peek()) {
      const t = this.peek()!;
      if (t.kind === 'punct' && t.value === '{') {
        operations.push({ type: 'query', selections: this.parseSelectionSet() });
        continue;
      }
      if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation' || t.value === 'subscription')) {
        const type = this.next()!.value as 'query' | 'mutation' | 'subscription';
        let name: string | undefined;
        const nt = this.peek();
        if (nt?.kind === 'name') name = this.next()!.value;
        const variableDefs = this.parseVariableDefs();
        operations.push({ type, name, variableDefs, selections: this.parseSelectionSet() });
        continue;
      }
      if (t.kind === 'name' && t.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        const selections = this.parseSelectionSet();
        fragments.set(name, { typeCondition, selections });
        continue;
      }
      this.next();
    }
    return { operations, fragments };
  }

  private parseVariableDefs(): { name: string; defaultValue?: ValueNode }[] | undefined {
    const t = this.peek();
    if (!t || t.kind !== 'punct' || t.value !== '(') return undefined;
    this.next();
    const defs: { name: string; defaultValue?: ValueNode }[] = [];
    while (this.peek() && !(this.peek()!.kind === 'punct' && this.peek()!.value === ')')) {
      const v = this.next();
      if (!v || v.kind !== 'var') break;
      // skip type tokens until ':' default or ',' or ')'
      let depth = 0;
      let defaultValue: ValueNode | undefined;
      while (this.peek()) {
        const tk = this.peek()!;
        if (tk.kind === 'punct' && tk.value === '[') depth++;
        if (tk.kind === 'punct' && tk.value === ']') depth--;
        if (depth === 0 && tk.kind === 'punct' && tk.value === '=') {
          this.next();
          defaultValue = this.parseValue();
          break;
        }
        if (depth === 0 && tk.kind === 'punct' && (tk.value === ',' || tk.value === ')')) break;
        this.next();
      }
      defs.push({ name: v.value, defaultValue });
      const sep = this.peek();
      if (sep?.kind === 'punct' && sep.value === ',') this.next();
    }
    this.expectPunct(')');
    return defs;
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const sels: Selection[] = [];
    while (this.peek() && !(this.peek()!.kind === 'punct' && this.peek()!.value === '}')) {
      sels.push(this.parseSelection());
    }
    this.expectPunct('}');
    return sels;
  }

  private parseSelection(): Selection {
    const t = this.peek()!;
    if (t.kind === 'punct' && t.value === '...') {
      this.next();
      const nt = this.peek()!;
      if (nt.kind === 'name' && nt.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inlineFragment', typeCondition, selections: this.parseSelectionSet() };
      }
      if (nt.kind === 'name') {
        const fragmentName = this.next()!.value;
        this.skipDirectives();
        return { kind: 'fragmentSpread', fragmentName };
      }
      this.skipDirectives();
      return { kind: 'inlineFragment', selections: this.parseSelectionSet() };
    }
    let name = this.expectName();
    let alias: string | undefined;
    const colon = this.peek();
    if (colon?.kind === 'punct' && colon.value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args = this.parseArguments();
    this.skipDirectives();
    let selections: Selection[] | undefined;
    const brace = this.peek();
    if (brace?.kind === 'punct' && brace.value === '{') selections = this.parseSelectionSet();
    return { kind: 'field', name, alias, args, selections };
  }

  private skipDirectives(): void {
    while (this.peek()?.kind === 'punct' && this.peek()!.value === '@') {
      this.next();
      this.expectName();
      if (this.peek()?.kind === 'punct' && this.peek()!.value === '(') this.parseArguments();
    }
  }

  private parseArguments(): { name: string; value: ValueNode }[] | undefined {
    const t = this.peek();
    if (!t || t.kind !== 'punct' || t.value !== '(') return undefined;
    this.next();
    const args: { name: string; value: ValueNode }[] = [];
    while (this.peek() && !(this.peek()!.kind === 'punct' && this.peek()!.value === ')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
      const sep = this.peek();
      if (sep?.kind === 'punct' && sep.value === ',') this.next();
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): ValueNode {
    const t = this.next()!;
    switch (t.kind) {
      case 'string':
        return { kind: 'string', value: t.value };
      case 'int':
        return { kind: 'int', value: parseInt(t.value, 10) };
      case 'float':
        return { kind: 'float', value: parseFloat(t.value) };
      case 'var':
        return { kind: 'var', value: t.value };
      case 'name':
        if (t.value === 'true') return { kind: 'bool', value: true };
        if (t.value === 'false') return { kind: 'bool', value: false };
        if (t.value === 'null') return { kind: 'null', value: null };
        return { kind: 'enum', value: t.value };
      case 'punct':
        if (t.value === '[') {
          const items: ValueNode[] = [];
          while (this.peek() && !(this.peek()!.kind === 'punct' && this.peek()!.value === ']')) {
            items.push(this.parseValue());
            const sep = this.peek();
            if (sep?.kind === 'punct' && sep.value === ',') this.next();
          }
          this.expectPunct(']');
          return { kind: 'list', items };
        }
        if (t.value === '{') {
          const fields: { name: string; value: ValueNode }[] = [];
          while (this.peek() && !(this.peek()!.kind === 'punct' && this.peek()!.value === '}')) {
            const name = this.expectName();
            this.expectPunct(':');
            fields.push({ name, value: this.parseValue() });
            const sep = this.peek();
            if (sep?.kind === 'punct' && sep.value === ',') this.next();
          }
          this.expectPunct('}');
          return { kind: 'object', fields };
        }
        throw new Error(`unexpected punct ${t.value}`);
      default:
        throw new Error('unexpected token');
    }
  }
}

export function parseGraphQL(src: string): Document {
  return new Parser(lex(src)).parseDocument();
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

export function valueFromAst(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'string':
    case 'int':
    case 'float':
    case 'bool':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'var': {
      const name = node.value as string;
      return variables[name];
    }
    case 'list':
      return (node.items ?? []).map((i) => valueFromAst(i, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields ?? []) out[f.name] = valueFromAst(f.value, variables);
      return out;
    }
    default:
      return null;
  }
}

function argsMap(sel: Selection, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of sel.args ?? []) out[a.name] = valueFromAst(a.value, variables);
  return out;
}

// ---------------------------------------------------------------------------
// Domain wrappers
// ---------------------------------------------------------------------------

type Obj =
  | { __typename: 'Query' }
  | { __typename: 'Mutation' }
  | { __typename: 'User'; login: string }
  | { __typename: 'Repository'; repo: Repo }
  | { __typename: 'Issue'; repo: Repo; issue: Issue }
  | { __typename: 'PullRequest'; repo: Repo; pr: Pull }
  | { __typename: 'Ref'; name: string }
  | { __typename: 'IssueConnection'; repo: Repo; issues: Issue[]; totalCount: number; pageInfo: PageInfo }
  | { __typename: 'PullRequestConnection'; repo: Repo; prs: Pull[]; totalCount: number; pageInfo: PageInfo }
  | { __typename: 'IssueComment'; repo: Repo; issue: Issue; comment: { id: number; gid: string; body: string } }
  | { __typename: 'IssueCommentConnection'; repo: Repo; issue: Issue }
  | { __typename: 'LabelConnection'; repo: Repo; issue: Issue }
  | { __typename: 'PullRequestChangedFileConnection'; pr: Pull }
  | { __typename: 'SearchResultItemConnection'; items: Obj[]; totalCount: number; pageInfo: PageInfo }
  | { __typename: 'PageInfo'; info: PageInfo }
  | { __typename: 'Type'; typeName: string }
  | { __typename: 'Schema' }
  | { __typename: 'RateLimit'; cost: number }
  | { __typename: 'CommentEdge'; node: Obj }
  | { __typename: 'IssueEdge'; node: Obj; cursor: string }
  | { __typename: 'PullRequestEdge'; node: Obj; cursor: string };

interface PageInfo {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
}

function cursorFor(n: number): string {
  return Buffer.from(`c:${n}`, 'utf8').toString('base64');
}

function cursorNum(cursor: string | null | undefined): number | null {
  if (!cursor) return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^c:(\d+)$/.exec(text);
    return m ? parseInt(m[1]!, 10) : null;
  } catch {
    return null;
  }
}

function paginateConnection<T extends { number: number }>(
  items: T[],
  args: Record<string, unknown>,
  descDefault = true,
): { page: T[]; pageInfo: PageInfo } {
  const first = typeof args.first === 'number' ? args.first : undefined;
  const afterNum = cursorNum(typeof args.after === 'string' ? args.after : null);
  let idx = 0;
  if (afterNum !== null) {
    const found = items.findIndex((i) => i.number === afterNum);
    idx = found === -1 ? items.length : found + 1;
  }
  void descDefault;
  const rest = items.slice(idx);
  const page = first !== undefined ? rest.slice(0, first) : rest;
  return {
    page,
    pageInfo: {
      hasNextPage: first !== undefined ? rest.length > first : false,
      hasPreviousPage: idx > 0,
      startCursor: page.length > 0 ? cursorFor(page[0]!.number) : null,
      endCursor: page.length > 0 ? cursorFor(page[page.length - 1]!.number) : null,
    },
  };
}

function sortIssues(issues: Issue[], args: Record<string, unknown>): Issue[] {
  const list = [...issues];
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const field = typeof orderBy.field === 'string' ? orderBy.field : 'CREATED_AT';
  const direction = typeof orderBy.direction === 'string' ? orderBy.direction : 'DESC';
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  let filtered = list;
  if (states) {
    const wanted = new Set(states.map((s) => s.toLowerCase()));
    filtered = list.filter((i) => wanted.has(i.state));
  }
  void field;
  if (direction === 'ASC') filtered.sort((a, b) => a.number - b.number);
  else filtered.sort((a, b) => b.number - a.number);
  return filtered;
}

// ---------------------------------------------------------------------------
// Introspection type table
// ---------------------------------------------------------------------------

interface FieldDef {
  name: string;
  typeKind: 'SCALAR' | 'OBJECT' | 'ENUM' | 'LIST' | 'NON_NULL';
  typeName: string;
  ofType?: { kind: string; name?: string; ofType?: { kind: string; name?: string } };
}

const TYPE_DEFS: Record<string, { kind: 'OBJECT' | 'ENUM'; fields?: FieldDef[]; enumValues?: string[] }> = {
  Query: {
    kind: 'OBJECT',
    fields: [
      { name: 'viewer', typeKind: 'OBJECT', typeName: 'User' },
      { name: 'repository', typeKind: 'OBJECT', typeName: 'Repository' },
      { name: 'node', typeKind: 'OBJECT', typeName: 'Node' },
      { name: 'search', typeKind: 'OBJECT', typeName: 'SearchResultItemConnection' },
      { name: 'rateLimit', typeKind: 'OBJECT', typeName: 'RateLimit' },
    ],
  },
  Mutation: {
    kind: 'OBJECT',
    fields: [
      { name: 'createIssue', typeKind: 'OBJECT', typeName: 'CreateIssuePayload' },
      { name: 'closeIssue', typeKind: 'OBJECT', typeName: 'CloseIssuePayload' },
      { name: 'createPullRequest', typeKind: 'OBJECT', typeName: 'CreatePullRequestPayload' },
      { name: 'mergePullRequest', typeKind: 'OBJECT', typeName: 'MergePullRequestPayload' },
      { name: 'addComment', typeKind: 'OBJECT', typeName: 'AddCommentPayload' },
    ],
  },
  Repository: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', typeKind: 'SCALAR', typeName: 'ID' },
      { name: 'databaseId', typeKind: 'SCALAR', typeName: 'Int' },
      { name: 'name', typeKind: 'SCALAR', typeName: 'String' },
      { name: 'nameWithOwner', typeKind: 'SCALAR', typeName: 'String' },
      { name: 'owner', typeKind: 'OBJECT', typeName: 'RepositoryOwner' },
      { name: 'defaultBranchRef', typeKind: 'OBJECT', typeName: 'Ref' },
      { name: 'viewerPermission', typeKind: 'ENUM', typeName: 'RepositoryPermission' },
      { name: 'hasIssuesEnabled', typeKind: 'SCALAR', typeName: 'Boolean' },
      { name: 'url', typeKind: 'SCALAR', typeName: 'String' },
      { name: 'description', typeKind: 'SCALAR', typeName: 'String' },
      { name: 'issue', typeKind: 'OBJECT', typeName: 'Issue' },
      { name: 'issues', typeKind: 'OBJECT', typeName: 'IssueConnection' },
      { name: 'pullRequest', typeKind: 'OBJECT', typeName: 'PullRequest' },
      { name: 'pullRequests', typeKind: 'OBJECT', typeName: 'PullRequestConnection' },
      { name: 'createdAt', typeKind: 'SCALAR', typeName: 'String' },
    ],
  },
  Issue: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', typeKind: 'SCALAR', typeName: 'ID' },
      { name: 'databaseId', typeKind: 'SCALAR', typeName: 'Int' },
      { name: 'number', typeKind: 'SCALAR', typeName: 'Int' },
      { name: 'title', typeKind: 'SCALAR', typeName: 'String' },
      { name: 'body', typeKind: 'SCALAR', typeName: 'String' },
      { name: 'state', typeKind: 'ENUM', typeName: 'IssueState' },
      { name: 'url', typeKind: 'SCALAR', typeName: 'String' },
      { name: 'createdAt', typeKind: 'SCALAR', typeName: 'String' },
      { name: 'author', typeKind: 'OBJECT', typeName: 'User' },
      { name: 'labels', typeKind: 'OBJECT', typeName: 'LabelConnection' },
      { name: 'comments', typeKind: 'OBJECT', typeName: 'IssueCommentConnection' },
    ],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', typeKind: 'SCALAR', typeName: 'ID' },
      { name: 'databaseId', typeKind: 'SCALAR', typeName: 'Int' },
      { name: 'number', typeKind: 'SCALAR', typeName: 'Int' },
      { name: 'title', typeKind: 'SCALAR', typeName: 'String' },
      { name: 'body', typeKind: 'SCALAR', typeName: 'String' },
      { name: 'state', typeKind: 'ENUM', typeName: 'PullRequestState' },
      { name: 'merged', typeKind: 'SCALAR', typeName: 'Boolean' },
      { name: 'mergeable', typeKind: 'ENUM', typeName: 'MergeableState' },
      { name: 'headRefName', typeKind: 'SCALAR', typeName: 'String' },
      { name: 'baseRefName', typeKind: 'SCALAR', typeName: 'String' },
      { name: 'headRefOid', typeKind: 'SCALAR', typeName: 'String' },
      { name: 'baseRefOid', typeKind: 'SCALAR', typeName: 'String' },
      { name: 'files', typeKind: 'OBJECT', typeName: 'PullRequestChangedFileConnection' },
      { name: 'author', typeKind: 'OBJECT', typeName: 'User' },
      { name: 'createdAt', typeKind: 'SCALAR', typeName: 'String' },
    ],
  },
  User: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', typeKind: 'SCALAR', typeName: 'ID' },
      { name: 'login', typeKind: 'SCALAR', typeName: 'String' },
      { name: 'name', typeKind: 'SCALAR', typeName: 'String' },
    ],
  },
  Ref: {
    kind: 'OBJECT',
    fields: [
      { name: 'name', typeKind: 'SCALAR', typeName: 'String' },
      { name: 'target', typeKind: 'OBJECT', typeName: 'GitObject' },
    ],
  },
  IssueConnection: {
    kind: 'OBJECT',
    fields: [
      { name: 'nodes', typeKind: 'LIST', typeName: 'Issue' },
      { name: 'edges', typeKind: 'LIST', typeName: 'IssueEdge' },
      { name: 'totalCount', typeKind: 'SCALAR', typeName: 'Int' },
      { name: 'pageInfo', typeKind: 'OBJECT', typeName: 'PageInfo' },
    ],
  },
  PullRequestConnection: {
    kind: 'OBJECT',
    fields: [
      { name: 'nodes', typeKind: 'LIST', typeName: 'PullRequest' },
      { name: 'edges', typeKind: 'LIST', typeName: 'PullRequestEdge' },
      { name: 'totalCount', typeKind: 'SCALAR', typeName: 'Int' },
      { name: 'pageInfo', typeKind: 'OBJECT', typeName: 'PageInfo' },
    ],
  },
  PageInfo: {
    kind: 'OBJECT',
    fields: [
      { name: 'hasNextPage', typeKind: 'SCALAR', typeName: 'Boolean' },
      { name: 'hasPreviousPage', typeKind: 'SCALAR', typeName: 'Boolean' },
      { name: 'startCursor', typeKind: 'SCALAR', typeName: 'String' },
      { name: 'endCursor', typeKind: 'SCALAR', typeName: 'String' },
    ],
  },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
};

function typeJson(def: FieldDef): Record<string, unknown> {
  const base = { kind: def.typeKind === 'NON_NULL' ? 'NON_NULL' : def.typeKind, name: def.typeName, ofType: def.ofType ?? null };
  return base;
}

function introspectType(name: string): Record<string, unknown> | null {
  const def = TYPE_DEFS[name];
  if (!def) return null;
  return {
    kind: def.kind,
    name,
    description: null,
    fields: def.fields
      ? def.fields.map((f) => ({ name: f.name, description: null, args: [], type: typeJson(f), isDeprecated: false, deprecationReason: null }))
      : null,
    inputFields: null,
    interfaces: [],
    enumValues: def.enumValues
      ? def.enumValues.map((v) => ({ name: v, description: null, isDeprecated: false, deprecationReason: null }))
      : null,
    possibleTypes: null,
  };
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

class GqlError extends Error {}

interface ExecCtx {
  store: Store;
  doc: Document;
  variables: Record<string, unknown>;
  errors: { message: string; path?: (string | number)[] }[];
}

function findRepoByGid(store: Store, gidValue: string): Repo | undefined {
  for (const r of store.repos.values()) if (r.gid === gidValue) return r;
  return undefined;
}

function decodeGid(gidValue: string): { kind: string; rest: string } | null {
  try {
    const text = Buffer.from(gidValue, 'base64url').toString('utf8');
    const idx = text.indexOf(':');
    if (idx === -1) return null;
    return { kind: text.slice(0, idx), rest: text.slice(idx + 1) };
  } catch {
    return null;
  }
}

function findIssueByGid(store: Store, gidValue: string): { repo: Repo; issue: Issue } | null {
  const d = decodeGid(gidValue);
  if (!d || d.kind !== 'issue') return null;
  const parts = d.rest.split(':');
  const repoId = parseInt(parts[0]!, 10);
  const number = parseInt(parts[1]!, 10);
  for (const r of store.repos.values()) {
    if (r.id !== repoId) continue;
    const issue = r.issues.find((i) => i.number === number);
    if (issue) return { repo: r, issue };
  }
  return null;
}

function findPullByGid(store: Store, gidValue: string): { repo: Repo; pr: Pull } | null {
  const d = decodeGid(gidValue);
  if (!d || d.kind !== 'pull') return null;
  const parts = d.rest.split(':');
  const repoId = parseInt(parts[0]!, 10);
  const number = parseInt(parts[1]!, 10);
  for (const r of store.repos.values()) {
    if (r.id !== repoId) continue;
    const pr = r.pulls.find((p) => p.number === number);
    if (pr) return { repo: r, pr };
  }
  return null;
}

function resolveField(ctx: ExecCtx, obj: Obj, sel: Selection): unknown {
  const name = sel.name!;
  const args = argsMap(sel, ctx.variables);
  const store = ctx.store;
  switch (obj.__typename) {
    case 'Query': {
      if (name === 'viewer') return { __typename: 'User', login: store.login } satisfies Obj;
      if (name === 'repository') {
        const owner = args.owner as string | undefined;
        const repoName = args.name as string | undefined;
        if (owner !== store.login) return null;
        const repo = store.getRepo(owner ?? '', repoName ?? '');
        return repo ? ({ __typename: 'Repository', repo } satisfies Obj) : null;
      }
      if (name === 'node') {
        const id = args.id as string | undefined;
        if (!id) return null;
        const d = decodeGid(id);
        if (!d) return null;
        if (d.kind === 'repo') {
          const repo = findRepoByGid(store, id);
          return repo ? ({ __typename: 'Repository', repo } satisfies Obj) : null;
        }
        if (d.kind === 'issue') {
          const found = findIssueByGid(store, id);
          return found ? ({ __typename: 'Issue', repo: found.repo, issue: found.issue } satisfies Obj) : null;
        }
        if (d.kind === 'pull') {
          const found = findPullByGid(store, id);
          return found ? ({ __typename: 'PullRequest', repo: found.repo, pr: found.pr } satisfies Obj) : null;
        }
        return null;
      }
      if (name === 'search') {
        const type = args.type as string | undefined;
        const first = typeof args.first === 'number' ? args.first : 10;
        let items: Obj[] = [];
        if (!type || type === 'ISSUE') {
          const all: Issue[] = [];
          const repos: Repo[] = [];
          for (const r of store.repos.values()) for (const i of r.issues) { all.push(i); repos.push(r); }
          items = all.map((issue, idx) => ({ __typename: 'Issue', repo: repos[idx]!, issue } satisfies Obj));
        }
        const page = items.slice(0, first);
        return {
          __typename: 'SearchResultItemConnection',
          items: page,
          totalCount: items.length,
          pageInfo: { hasNextPage: items.length > first, hasPreviousPage: false, startCursor: null, endCursor: null },
        } satisfies Obj;
      }
      if (name === 'rateLimit') return { __typename: 'RateLimit', cost: 1 } satisfies Obj;
      break;
    }
    case 'Mutation': {
      if (name === 'createIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = findRepoByGid(store, String(input.repositoryId ?? ''));
        if (!repo) throw new GqlError('Repository not found');
        const iss = createIssueInRepo(store, repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '');
        return { __typename: 'CreateIssuePayload', repo, issue: iss, _payload: 'createIssue' } as unknown as Obj;
      }
      if (name === 'closeIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = findIssueByGid(store, String(input.issueId ?? ''));
        if (!found) throw new GqlError('Issue not found');
        found.issue.state = 'closed';
        found.issue.jsonCache = '';
        return { __typename: 'CloseIssuePayload', repo: found.repo, issue: found.issue, _payload: 'closeIssue' } as unknown as Obj;
      }
      if (name === 'createPullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = findRepoByGid(store, String(input.repositoryId ?? ''));
        if (!repo) throw new GqlError('Repository not found');
        const pr = createPullInRepo(
          store,
          repo,
          String(input.title ?? ''),
          typeof input.body === 'string' ? input.body : '',
          String(input.headRefName ?? ''),
          String(input.baseRefName ?? repo.defaultBranch),
        );
        if (!pr) throw new GqlError('Head or base branch not found');
        return { __typename: 'CreatePullRequestPayload', repo, pr, _payload: 'createPullRequest' } as unknown as Obj;
      }
      if (name === 'mergePullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = findPullByGid(store, String(input.pullRequestId ?? ''));
        if (!found) throw new GqlError('Pull request not found');
        if (found.pr.merged && found.pr.mergeSha) {
          return { __typename: 'MergePullRequestPayload', repo: found.repo, pr: found.pr, _payload: 'mergePullRequest' } as unknown as Obj;
        }
        if (store.prConflicted(found.repo, found.pr)) throw new GqlError('Merge conflict');
        const sha = store.mergePull(found.repo, found.pr);
        if (!sha) throw new GqlError('Merge conflict');
        found.pr.state = 'closed';
        found.pr.merged = true;
        found.pr.mergeSha = sha;
        found.pr.mergedAt = store.isoFromSeq(store.timeSeq);
        return { __typename: 'MergePullRequestPayload', repo: found.repo, pr: found.pr, _payload: 'mergePullRequest' } as unknown as Obj;
      }
      if (name === 'addComment') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = findIssueByGid(store, String(input.subjectId ?? ''));
        if (!found) throw new GqlError('Subject not found');
        const id = store.commentSeq++;
        const comment = { id, gid: gid('comment', `${found.repo.id}:${found.issue.number}:${id}`), body: String(input.body ?? '') };
        found.issue.comments.push(comment);
        found.issue.jsonCache = '';
        return {
          __typename: 'AddCommentPayload',
          _payload: 'addComment',
          _edge: {
            __typename: 'CommentEdge',
            node: { __typename: 'IssueComment', repo: found.repo, issue: found.issue, comment } satisfies Obj,
          } satisfies Obj,
        } as unknown as Obj;
      }
      break;
    }
    case 'User': {
      if (name === 'login') return obj.login;
      if (name === 'id') return gid('user', obj.login);
      if (name === 'name') return obj.login;
      break;
    }
    case 'Repository': {
      const repo = obj.repo;
      if (name === 'id') return repo.gid;
      if (name === 'databaseId') return repo.id;
      if (name === 'name') return repo.name;
      if (name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
      if (name === 'owner') return { __typename: 'User', login: repo.owner } satisfies Obj;
      if (name === 'defaultBranchRef') return { __typename: 'Ref', name: repo.defaultBranch } satisfies Obj;
      if (name === 'viewerPermission') return 'ADMIN';
      if (name === 'hasIssuesEnabled') return true;
      if (name === 'url') return `https://github.example/${repo.owner}/${repo.name}`;
      if (name === 'description') return repo.description;
      if (name === 'createdAt') return store.isoFromSeq(repo.seq);
      if (name === 'issue') {
        const num = args.number as number | undefined;
        const iss = repo.issues.find((i) => i.number === num);
        return iss ? ({ __typename: 'Issue', repo, issue: iss } satisfies Obj) : null;
      }
      if (name === 'issues') {
        const sorted = sortIssues(repo.issues, args);
        const { page, pageInfo } = paginateConnection(sorted, args);
        return { __typename: 'IssueConnection', repo, issues: page, totalCount: sorted.length, pageInfo } satisfies Obj;
      }
      if (name === 'pullRequest') {
        const num = args.number as number | undefined;
        const pr = repo.pulls.find((p) => p.number === num);
        return pr ? ({ __typename: 'PullRequest', repo, pr } satisfies Obj) : null;
      }
      if (name === 'pullRequests') {
        const list = [...repo.pulls];
        const states = Array.isArray(args.states) ? (args.states as string[]) : null;
        let filtered = list;
        if (states) {
          const wanted = new Set(states.map((s) => s.toLowerCase()));
          filtered = list.filter((p) => wanted.has(p.state) || (wanted.has('merged') && p.merged));
        }
        filtered.sort((a, b) => b.number - a.number);
        const { page, pageInfo } = paginateConnection(filtered, args);
        return { __typename: 'PullRequestConnection', repo, prs: page, totalCount: filtered.length, pageInfo } satisfies Obj;
      }
      break;
    }
    case 'Issue': {
      const iss = obj.issue;
      const repo = obj.repo;
      if (name === 'id') return iss.gid;
      if (name === 'databaseId') return iss.id;
      if (name === 'number') return iss.number;
      if (name === 'title') return iss.title;
      if (name === 'body') return iss.body;
      if (name === 'state') return iss.state.toUpperCase();
      if (name === 'url') return `https://github.example/${repo.owner}/${repo.name}/issues/${iss.number}`;
      if (name === 'createdAt') return store.isoFromSeq(iss.seq);
      if (name === 'author') return { __typename: 'User', login: store.login } satisfies Obj;
      if (name === 'labels') return { __typename: 'LabelConnection', repo, issue: iss } satisfies Obj;
      if (name === 'comments') return { __typename: 'IssueCommentConnection', repo, issue: iss } satisfies Obj;
      break;
    }
    case 'PullRequest': {
      const pr = obj.pr;
      const repo = obj.repo;
      if (name === 'id') return pr.gid;
      if (name === 'databaseId') return pr.id;
      if (name === 'number') return pr.number;
      if (name === 'title') return pr.title;
      if (name === 'body') return pr.body;
      if (name === 'state') return pr.merged ? 'MERGED' : pr.state.toUpperCase();
      if (name === 'merged') return pr.merged;
      if (name === 'mergeable') return store.prConflicted(repo, pr) ? 'CONFLICTING' : 'MERGEABLE';
      if (name === 'headRefName') return pr.head;
      if (name === 'baseRefName') return pr.base;
      if (name === 'headRefOid') return pr.headSha;
      if (name === 'baseRefOid') return pr.baseSha;
      if (name === 'createdAt') return store.isoFromSeq(pr.seq);
      if (name === 'author') return { __typename: 'User', login: store.login } satisfies Obj;
      if (name === 'files') {
        const first = typeof args.first === 'number' ? args.first : 10;
        const files = pr.files.slice(0, first);
        return {
          __typename: 'PullRequestChangedFileConnection',
          pr: { ...pr, files },
        } satisfies Obj;
      }
      break;
    }
    case 'Ref': {
      if (name === 'name') return obj.name;
      if (name === 'target') return null;
      break;
    }
    case 'IssueConnection': {
      if (name === 'nodes') return obj.issues.map((i) => ({ __typename: 'Issue', repo: obj.repo, issue: i } satisfies Obj));
      if (name === 'edges') {
        return obj.issues.map((i) => ({ __typename: 'IssueEdge', node: { __typename: 'Issue', repo: obj.repo, issue: i } satisfies Obj, cursor: cursorFor(i.number) } satisfies Obj));
      }
      if (name === 'totalCount') return obj.totalCount;
      if (name === 'pageInfo') return { __typename: 'PageInfo', info: obj.pageInfo } satisfies Obj;
      break;
    }
    case 'PullRequestConnection': {
      if (name === 'nodes') return obj.prs.map((p) => ({ __typename: 'PullRequest', repo: obj.repo, pr: p } satisfies Obj));
      if (name === 'edges') {
        return obj.prs.map((p) => ({ __typename: 'PullRequestEdge', node: { __typename: 'PullRequest', repo: obj.repo, pr: p } satisfies Obj, cursor: cursorFor(p.number) } satisfies Obj));
      }
      if (name === 'totalCount') return obj.totalCount;
      if (name === 'pageInfo') return { __typename: 'PageInfo', info: obj.pageInfo } satisfies Obj;
      break;
    }
    case 'IssueCommentConnection': {
      if (name === 'nodes') {
        return obj.issue.comments.map((c) => ({ __typename: 'IssueComment', repo: obj.repo, issue: obj.issue, comment: c } satisfies Obj));
      }
      if (name === 'totalCount') return obj.issue.comments.length;
      if (name === 'pageInfo') {
        return { __typename: 'PageInfo', info: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null } } satisfies Obj;
      }
      break;
    }
    case 'LabelConnection': {
      if (name === 'nodes') {
        return obj.issue.labels.map((l) => ({ __typename: 'Label' as never, name: l } as unknown as Obj));
      }
      if (name === 'totalCount') return obj.issue.labels.length;
      break;
    }
    case 'PullRequestChangedFileConnection': {
      if (name === 'nodes') {
        return obj.pr.files.map(
          (f) =>
            ({
              __typename: 'ChangedFile',
              path: f.filename,
              additions: f.additions,
              deletions: f.deletions,
              changeStatus: f.status === 'added' ? 'ADDED' : f.status === 'removed' ? 'REMOVED' : 'MODIFIED',
            }) as unknown as Obj,
        );
      }
      if (name === 'totalCount') return obj.pr.files.length;
      if (name === 'pageInfo') {
        return { __typename: 'PageInfo', info: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null } } satisfies Obj;
      }
      break;
    }
    case 'SearchResultItemConnection': {
      if (name === 'nodes') return obj.items;
      if (name === 'edges') {
        return obj.items.map((it) => ({ __typename: 'IssueEdge', node: it, cursor: '' } satisfies Obj));
      }
      if (name === 'totalCount') return obj.totalCount;
      if (name === 'issueCount') return obj.totalCount;
      if (name === 'pageInfo') return { __typename: 'PageInfo', info: obj.pageInfo } satisfies Obj;
      break;
    }
    case 'PageInfo': {
      if (name === 'hasNextPage') return obj.info.hasNextPage;
      if (name === 'hasPreviousPage') return obj.info.hasPreviousPage;
      if (name === 'startCursor') return obj.info.startCursor;
      if (name === 'endCursor') return obj.info.endCursor;
      break;
    }
    case 'IssueEdge':
    case 'PullRequestEdge': {
      if (name === 'node') return obj.node;
      if (name === 'cursor') return obj.cursor;
      break;
    }
    case 'CommentEdge': {
      if (name === 'node') return obj.node;
      if (name === 'cursor') return '';
      break;
    }
    case 'IssueComment': {
      if (name === 'id') return obj.comment.gid;
      if (name === 'body') return obj.comment.body;
      if (name === 'author') return { __typename: 'User', login: store.login } satisfies Obj;
      if (name === 'createdAt') return store.isoFromSeq(obj.issue.seq);
      break;
    }
    case 'RateLimit': {
      if (name === 'limit') return 5000;
      if (name === 'remaining') return 4999;
      if (name === 'cost') return obj.cost;
      if (name === 'resetAt') return '2026-11-19T00:00:00.000Z';
      break;
    }
    case 'Type': {
      break;
    }
    case 'Schema': {
      break;
    }
    default:
      break;
  }
  // Payload wrappers (mutation results carry the created object under a field).
  const payload = (obj as unknown as Record<string, unknown>)._payload as string | undefined;
  if (payload) {
    if (payload === 'createIssue' || payload === 'closeIssue') {
      const o = obj as unknown as { repo: Repo; issue: Issue };
      if (name === 'issue') return { __typename: 'Issue', repo: o.repo, issue: o.issue } satisfies Obj;
      if (name === 'clientMutationId') return null;
    }
    if (payload === 'createPullRequest' || payload === 'mergePullRequest') {
      const o = obj as unknown as { repo: Repo; pr: Pull };
      if (name === 'pullRequest') return { __typename: 'PullRequest', repo: o.repo, pr: o.pr } satisfies Obj;
      if (name === 'clientMutationId') return null;
    }
    if (payload === 'addComment') {
      const o = obj as unknown as { _edge: Obj };
      if (name === 'commentEdge') return o._edge;
      if (name === 'clientMutationId') return null;
    }
  }
  // Generic pseudo-types for changed files / labels (plain records).
  const rec = obj as unknown as Record<string, unknown>;
  if (name === 'path' && typeof rec.path === 'string') return rec.path;
  if (name === 'additions' && typeof rec.additions === 'number') return rec.additions;
  if (name === 'deletions' && typeof rec.deletions === 'number') return rec.deletions;
  if (name === 'changeStatus' && typeof rec.changeStatus === 'string') return rec.changeStatus;
  if (name === 'name' && typeof rec.name === 'string') return rec.name;
  throw new GqlError(`Cannot query field "${name}" on type "${obj.__typename}".`);
}

function executeSelectionSet(
  ctx: ExecCtx,
  obj: Obj | Record<string, unknown>,
  selections: Selection[],
  path: (string | number)[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'fragmentSpread') {
      const frag = ctx.doc.fragments.get(sel.fragmentName ?? '');
      if (frag) {
        const sub = executeSelectionSet(ctx, obj, frag.selections, path);
        Object.assign(out, sub);
      }
      continue;
    }
    if (sel.kind === 'inlineFragment') {
      const typeName = (obj as Obj).__typename;
      if (!sel.typeCondition || sel.typeCondition === typeName) {
        const sub = executeSelectionSet(ctx, obj, sel.selections ?? [], path);
        Object.assign(out, sub);
      }
      continue;
    }
    const fieldName = sel.name!;
    const responseKey = sel.alias ?? fieldName;
    const fieldPath = [...path, responseKey];
    if (fieldName === '__typename') {
      out[responseKey] = (obj as Obj).__typename ?? 'Unknown';
      continue;
    }
    // Introspection fields on any object.
    if (fieldName === '__type') {
      const args = argsMap(sel, ctx.variables);
      out[responseKey] = introspectType(String(args.name ?? ''));
      continue;
    }
    if (fieldName === '__schema') {
      out[responseKey] = {
        queryType: { name: 'Query' },
        mutationType: { name: 'Mutation' },
        types: Object.keys(TYPE_DEFS).map((n) => introspectType(n)),
      };
      continue;
    }
    let value: unknown;
    try {
      value = resolveField(ctx, obj as Obj, sel);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      ctx.errors.push({ message, path: fieldPath });
      out[responseKey] = null;
      continue;
    }
    out[responseKey] = completeValue(ctx, value, sel, fieldPath);
  }
  return out;
}

function completeValue(ctx: ExecCtx, value: unknown, sel: Selection, path: (string | number)[]): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((v, i) => completeValue(ctx, v, sel, [...path, i]));
  }
  if (typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    if ('__typename' in rec) {
      if (!sel.selections || sel.selections.length === 0) return {};
      return executeSelectionSet(ctx, value as Obj, sel.selections, path);
    }
    // Plain introspection records: apply selections if any, else return as-is.
    if (sel.selections && sel.selections.length > 0) {
      const out: Record<string, unknown> = {};
      for (const sub of sel.selections) {
        if (sub.kind !== 'field') continue;
        const key = sub.alias ?? sub.name!;
        const v = rec[sub.name!];
        if (v === undefined) {
          ctx.errors.push({ message: `Cannot query field "${sub.name}" on type "Type".`, path: [...path, key] });
          out[key] = null;
          continue;
        }
        if (Array.isArray(v)) {
          out[key] = v.map((item) => {
            if (item && typeof item === 'object' && sub.selections) {
              const subOut: Record<string, unknown> = {};
              for (const s2 of sub.selections) {
                if (s2.kind !== 'field') continue;
                subOut[s2.alias ?? s2.name!] = (item as Record<string, unknown>)[s2.name!];
              }
              return subOut;
            }
            return item;
          });
        } else if (v && typeof v === 'object' && sub.selections) {
          const subOut: Record<string, unknown> = {};
          for (const s2 of sub.selections) {
            if (s2.kind !== 'field') continue;
            subOut[s2.alias ?? s2.name!] = (v as Record<string, unknown>)[s2.name!];
          }
          out[key] = subOut;
        } else {
          out[key] = v;
        }
      }
      return out;
    }
    return rec;
  }
  return value;
}

export interface GqlResult {
  data: Record<string, unknown> | null;
  errors?: { message: string; path?: (string | number)[] }[];
}

export function executeGraphQL(store: Store, query: string, variables: Record<string, unknown>, operationName?: string): GqlResult {
  let doc: Document;
  try {
    doc = parseGraphQL(query);
  } catch (e) {
    return { data: null, errors: [{ message: e instanceof Error ? e.message : 'Syntax Error' }] };
  }
  const op = operationName
    ? doc.operations.find((o) => o.name === operationName) ?? doc.operations[0]
    : doc.operations[0];
  if (!op) return { data: null, errors: [{ message: 'No operation provided' }] };
  const vars: Record<string, unknown> = { ...variables };
  for (const def of op.variableDefs ?? []) {
    if (!(def.name in vars) && def.defaultValue) vars[def.name] = valueFromAst(def.defaultValue, vars);
  }
  const ctx: ExecCtx = { store, doc, variables: vars, errors: [] };
  const root: Obj = op.type === 'mutation' ? { __typename: 'Mutation' } : { __typename: 'Query' };
  const data = executeSelectionSet(ctx, root, op.selections, []);
  const result: GqlResult = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

/** Handle a parsed GraphQL request body (single object or batched array). */
export function handleGraphQL(
  store: Store,
  body: unknown,
): { status: number; body: string } {
  const run = (item: Record<string, unknown>): GqlResult => {
    const query = typeof item.query === 'string' ? item.query : '';
    const variables = (item.variables ?? {}) as Record<string, unknown>;
    const operationName = typeof item.operationName === 'string' ? item.operationName : undefined;
    return executeGraphQL(store, query, variables, operationName);
  };
  if (Array.isArray(body)) {
    const results = body.map((item) => (item && typeof item === 'object' ? run(item as Record<string, unknown>) : { data: null, errors: [{ message: 'Invalid request' }] }));
    return { status: 200, body: JSON.stringify(results) };
  }
  if (body && typeof body === 'object') {
    return { status: 200, body: JSON.stringify(run(body as Record<string, unknown>)) };
  }
  return { status: 400, body: JSON.stringify({ errors: [{ message: 'Request body must be a JSON object' }] }) };
}
