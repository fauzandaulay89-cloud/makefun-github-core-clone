// The forge's store: every repository, its git objects and refs, and its REST
// resources (issues, pull requests, labels, comments). Everything lives in
// memory: a trial is one process, the suite is its only client, and the store
// dies with the process. No clock is read here: every timestamp derives from
// MAKEFUN_TRIAL_NOW, the trial's only now, so a live pass and its replay
// agree byte for byte.

import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const VIEWER_ID = 1000;
export const ZERO_OID = '0'.repeat(40);

/** The trial's now, as epoch seconds; the env's MAKEFUN_TRIAL_NOW, else the competition's opening. */
export function trialEpochSec(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW ?? '';
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  return Math.floor(Date.parse('2026-11-14T06:30:00Z') / 1000);
}

/** The trial's now, as an ISO-8601 UTC string. */
export function trialNowIso(): string {
  return new Date(trialEpochSec() * 1000).toISOString().replace('.000Z', 'Z');
}

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) break;
    const mode = data.subarray(offset, space).toString('utf8');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Build a tree object's bytes from entries, in git's order (names sorted, dirs as name + '/'). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object's headers and message. */
export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** Build a commit object's bytes. */
export function buildCommit(fields: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  let out = `tree ${fields.tree}\n`;
  for (const parent of fields.parents) out += `parent ${parent}\n`;
  out += `author ${fields.author}\ncommitter ${fields.committer}\n\n${fields.message}`;
  return Buffer.from(out, 'utf8');
}

/** Parse a tag object's headers and message. */
export function parseTag(data: Buffer): { object: string; type: string; tag: string; tagger: string; message: string } {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

/** The identity line git writes for the viewer, at the trial's now. */
export function viewerIdentity(epochSec: number): string {
  return `${VIEWER_NAME} <${VIEWER_EMAIL}> ${epochSec} +0000`;
}

// ---------------------------------------------------------------------------
// The object store of one repository
// ---------------------------------------------------------------------------

export class ObjectStore {
  readonly objects = new Map<string, GitObject>();

  put(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  get(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  has(oid: string): boolean {
    return this.objects.has(oid);
  }

  /** All objects reachable from `roots` (commits, their trees and blobs, tag targets). */
  reachable(roots: Iterable<string>): Set<string> {
    const seen = new Set<string>();
    const stack = [...roots];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      const object = this.objects.get(oid);
      if (object === undefined) continue;
      seen.add(oid);
      if (object.type === 'commit') {
        const view = parseCommit(object.data);
        stack.push(view.tree);
        for (const parent of view.parents) stack.push(parent);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) stack.push(entry.oid);
      } else if (object.type === 'tag') {
        stack.push(parseTag(object.data).object);
      }
    }
    return seen;
  }

  /** True when `ancestor` is reachable from `oid` (or equal to it). */
  isAncestor(ancestor: string, oid: string): boolean {
    if (ancestor === oid) return true;
    const seen = new Set<string>();
    const stack = [oid];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (current === ancestor) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      const object = this.objects.get(current);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) stack.push(parent);
    }
    return false;
  }

  /** The flat path -> {oid, mode} map of the tree at `treeOid`, recursively. */
  flattenTree(treeOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string): void => {
      const object = this.objects.get(oid);
      if (object === undefined || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** A new tree oid equal to `baseTreeOid` with `path` set to `blobOid` (or removed when null). */
  setPath(baseTreeOid: string | null, path: string, blobOid: string | null): string {
    const segments = path.split('/').filter((part) => part !== '');
    const build = (treeOid: string | null, depth: number): string => {
      const entries = new Map<string, TreeEntry>();
      if (treeOid !== null) {
        const object = this.objects.get(treeOid);
        if (object !== undefined && object.type === 'tree') {
          for (const entry of parseTree(object.data)) entries.set(entry.name, entry);
        }
      }
      const name = segments[depth] as string;
      if (depth === segments.length - 1) {
        if (blobOid === null) entries.delete(name);
        else entries.set(name, { mode: '100644', name, oid: blobOid });
      } else {
        const child = entries.get(name);
        const childOid = child !== undefined && child.mode === '40000' ? child.oid : null;
        const next = build(childOid, depth + 1);
        const childObject = this.objects.get(next);
        const isEmpty = childObject !== undefined && childObject.type === 'tree' && parseTree(childObject.data).length === 0;
        if (isEmpty) entries.delete(name);
        else entries.set(name, { mode: '40000', name, oid: next });
      }
      return this.put('tree', buildTree([...entries.values()]));
    };
    return build(baseTreeOid, 0);
  }

  /** The tree oid of a commit, or null when the commit is unknown. */
  commitTree(oid: string): string | null {
    const object = this.objects.get(oid);
    if (object === undefined || object.type !== 'commit') return null;
    return parseCommit(object.data).tree;
  }

  /** Create a commit object on top of `parents` with `treeOid` and `message`; returns its oid. */
  makeCommit(treeOid: string, parents: readonly string[], message: string, epochSec: number): string {
    const text = message.endsWith('\n') ? message : `${message}\n`;
    const identity = viewerIdentity(epochSec);
    return this.put('commit', buildCommit({ tree: treeOid, parents, author: identity, committer: identity, message: text }));
  }
}

// ---------------------------------------------------------------------------
// REST resources
// ---------------------------------------------------------------------------

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface IssueComment {
  id: number;
  body: string;
  seq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: IssueComment[];
  seq: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  seq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  seq: number;
  createdAt: string;
  updatedAt: string;
  store: ObjectStore;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: PullRequest[];
  issueSeq: number;
  pullSeq: number;
  commentSeq: number;
  labelSeq: number;
}

export class Store {
  readonly repos = new Map<string, Repo>();
  private repoSeq = 0;
  private issueIdSeq = 0;
  private pullIdSeq = 0;
  private commentIdSeq = 0;
  private labelIdSeq = 0;
  private nowSec: number;
  private nowIsoStr: string;

  constructor() {
    this.nowSec = trialEpochSec();
    this.nowIsoStr = trialNowIso();
  }

  now(): string {
    return this.nowIsoStr;
  }

  epochSec(): number {
    return this.nowSec;
  }

  createRepo(name: string, isPrivate: boolean, description: string): Repo {
    this.repoSeq += 1;
    const repo: Repo = {
      id: this.repoSeq,
      name,
      description,
      isPrivate,
      defaultBranch: 'main',
      seq: this.repoSeq,
      createdAt: this.nowIsoStr,
      updatedAt: this.nowIsoStr,
      store: new ObjectStore(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      issueSeq: 0,
      pullSeq: 0,
      commentSeq: 0,
      labelSeq: 0,
    };
    this.repos.set(name, repo);
    return repo;
  }

  getRepo(name: string): Repo | undefined {
    return this.repos.get(name);
  }

  deleteRepo(name: string): boolean {
    return this.repos.delete(name);
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.seq - b.seq);
  }

  /** The tip of a branch ref, or null when the ref does not exist. */
  refTip(repo: Repo, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  /** The tip of the repository's default branch, or null when unborn. */
  defaultTip(repo: Repo): string | null {
    return this.refTip(repo, repo.defaultBranch);
  }

  /** Resolve a ref-ish (branch name, full ref, or commit oid) to a commit oid, or null. */
  resolveRef(repo: Repo, ref: string): string | null {
    if (repo.refs.has(ref)) return repo.refs.get(ref) as string;
    const head = repo.refs.get(`refs/heads/${ref}`);
    if (head !== undefined) return head;
    if (repo.refs.has(`refs/tags/${ref}`)) {
      const oid = repo.refs.get(`refs/tags/${ref}`) as string;
      return this.peelToCommit(repo, oid);
    }
    if (/^[0-9a-f]{40}$/i.test(ref) && repo.store.has(ref.toLowerCase())) {
      const object = repo.store.get(ref.toLowerCase());
      if (object !== undefined && object.type === 'commit') return ref.toLowerCase();
      if (object !== undefined && object.type === 'tag') return this.peelToCommit(repo, ref.toLowerCase());
    }
    if (ref === 'HEAD') return this.defaultTip(repo);
    return null;
  }

  /** Follow an annotated tag to its commit, else return the oid itself. */
  peelToCommit(repo: Repo, oid: string): string | null {
    let current = oid;
    for (let depth = 0; depth < 10; depth += 1) {
      const object = repo.store.get(current);
      if (object === undefined) return null;
      if (object.type === 'commit') return current;
      if (object.type === 'tag') {
        current = parseTag(object.data).object;
        continue;
      }
      return null;
    }
    return null;
  }

  /** The merge-base of two commits (the first common ancestor found by generation order), or null. */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const ancestorsA = new Set<string>();
    const queueA: Array<{ oid: string; depth: number }> = [{ oid: a, depth: 0 }];
    while (queueA.length > 0) {
      const item = queueA.shift() as { oid: string; depth: number };
      if (ancestorsA.has(item.oid)) continue;
      ancestorsA.add(item.oid);
      const object = repo.store.get(item.oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queueA.push({ oid: parent, depth: item.depth + 1 });
    }
    const queueB: string[] = [b];
    const seenB = new Set<string>();
    while (queueB.length > 0) {
      const oid = queueB.shift() as string;
      if (ancestorsA.has(oid)) return oid;
      if (seenB.has(oid)) continue;
      seenB.add(oid);
      const object = repo.store.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queueB.push(parent);
    }
    return null;
  }

  /**
   * Three-way merge of `headTip` onto `baseTip` with `mergeBaseOid` as the base.
   * Returns the merged tree oid, or null when the same path changed both ways with different bytes.
   */
  threeWayMerge(repo: Repo, baseTip: string, headTip: string, mergeBaseOid: string | null): string | null {
    const baseTree = repo.store.commitTree(baseTip);
    const headTree = repo.store.commitTree(headTip);
    if (baseTree === null || headTree === null) return null;
    const baseFiles = repo.store.flattenTree(baseTree);
    const headFiles = repo.store.flattenTree(headTree);
    const mergeFiles = mergeBaseOid === null ? new Map<string, { oid: string; mode: string }>() : repo.store.flattenTree(repo.store.commitTree(mergeBaseOid) ?? '');
    const result = new Map<string, { oid: string; mode: string }>();
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...mergeFiles.keys()]);
    for (const path of paths) {
      const base = baseFiles.get(path);
      const head = headFiles.get(path);
      const merge = mergeFiles.get(path);
      const baseOid = base?.oid ?? null;
      const headOid = head?.oid ?? null;
      const mergeOid = merge?.oid ?? null;
      if (headOid === mergeOid) {
        if (baseOid !== null && base !== undefined) result.set(path, base);
      } else if (baseOid === mergeOid) {
        if (headOid !== null && head !== undefined) result.set(path, head);
      } else if (baseOid === headOid) {
        if (baseOid !== null && base !== undefined) result.set(path, base);
      } else {
        return null;
      }
    }
    let treeOid: string | null = null;
    const empty = repo.store.put('tree', buildTree([]));
    treeOid = empty;
    for (const [path, entry] of [...result.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      treeOid = repo.store.setPath(treeOid, path, entry.oid);
    }
    return treeOid;
  }

  /** Whether a pull request merges cleanly (its three-way merge has no conflict). */
  prMergeable(repo: Repo, pull: PullRequest): boolean {
    const headTip = this.refTip(repo, pull.headRef);
    const baseTip = this.refTip(repo, pull.baseRef);
    if (headTip === null || baseTip === null) return false;
    if (headTip === baseTip) return true;
    const base = this.mergeBase(repo, baseTip, headTip);
    return this.threeWayMerge(repo, baseTip, headTip, base) !== null;
  }

  /** The changed files between two trees: path, status, additions, deletions, changes. */
  diffTrees(repo: Repo, baseTreeOid: string | null, headTreeOid: string | null): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
    const baseFiles = baseTreeOid === null ? new Map() : repo.store.flattenTree(baseTreeOid);
    const headFiles = headTreeOid === null ? new Map() : repo.store.flattenTree(headTreeOid);
    const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
    for (const path of [...paths].sort()) {
      const base = baseFiles.get(path);
      const head = headFiles.get(path);
      if (base !== undefined && head !== undefined && base.oid === head.oid) continue;
      if (base === undefined && head !== undefined) {
        const lines = countLines(repo.store.get(head.oid)?.data ?? Buffer.alloc(0));
        out.push({ filename: path, status: 'added', additions: lines, deletions: 0, changes: lines });
      } else if (base !== undefined && head === undefined) {
        const lines = countLines(repo.store.get(base.oid)?.data ?? Buffer.alloc(0));
        out.push({ filename: path, status: 'removed', additions: 0, deletions: lines, changes: lines });
      } else if (base !== undefined && head !== undefined) {
        const [additions, deletions] = diffLines(
          repo.store.get(base.oid)?.data ?? Buffer.alloc(0),
          repo.store.get(head.oid)?.data ?? Buffer.alloc(0),
        );
        out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return out;
  }

  createIssue(repo: Repo, title: string, body: string, labels: Label[]): Issue {
    repo.issueSeq += 1;
    this.issueIdSeq += 1;
    const issue: Issue = {
      id: this.issueIdSeq,
      number: repo.issueSeq,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      seq: repo.issueSeq,
      createdAt: this.nowIsoStr,
      updatedAt: this.nowIsoStr,
      closedAt: null,
    };
    repo.issues.push(issue);
    return issue;
  }

  createComment(repo: Repo, issue: Issue, body: string): IssueComment {
    repo.commentSeq += 1;
    this.commentIdSeq += 1;
    const comment: IssueComment = {
      id: this.commentIdSeq,
      body,
      seq: repo.commentSeq,
      createdAt: this.nowIsoStr,
      updatedAt: this.nowIsoStr,
    };
    issue.comments.push(comment);
    return comment;
  }

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): PullRequest {
    repo.pullSeq += 1;
    this.pullIdSeq += 1;
    const pull: PullRequest = {
      id: this.pullIdSeq,
      number: repo.pullSeq,
      title,
      body,
      state: 'open',
      headRef,
      baseRef,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      seq: repo.pullSeq,
      createdAt: this.nowIsoStr,
      updatedAt: this.nowIsoStr,
    };
    repo.pulls.push(pull);
    return pull;
  }

  createLabel(repo: Repo, name: string, color: string, description: string): Label {
    repo.labelSeq += 1;
    this.labelIdSeq += 1;
    const label: Label = { id: this.labelIdSeq, name, color, description };
    repo.labels.set(name, label);
    return label;
  }
}

/** The number of lines in a blob (a trailing newline does not add one). */
export function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  const text = data.toString('utf8');
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

/** A small LCS line diff: [added, removed] counts between two blobs. */
export function diffLines(oldData: Buffer, newData: Buffer): [number, number] {
  const oldLines = oldData.length === 0 ? [] : oldData.toString('utf8').split('\n');
  const newLines = newData.length === 0 ? [] : newData.toString('utf8').split('\n');
  if (oldLines.length > 0 && oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines.length > 0 && newLines[newLines.length - 1] === '') newLines.pop();
  const m = oldLines.length;
  const n = newLines.length;
  if (m === 0) return [n, 0];
  if (n === 0) return [0, m];
  if (m * n > 400_000) {
    let added = 0;
    let removed = 0;
    const oldSet = new Set(oldLines);
    const newSet = new Set(newLines);
    for (const line of newLines) if (!oldSet.has(line)) added += 1;
    for (const line of oldLines) if (!newSet.has(line)) removed += 1;
    return [added, removed];
  }
  const dp: number[][] = [];
  for (let i = 0; i <= m; i += 1) dp.push(new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i]![j] = oldLines[i] === newLines[j] ? (dp[i + 1]![j + 1] as number) + 1 : Math.max(dp[i + 1]![j] as number, dp[i]![j + 1] as number);
    }
  }
  return [n - (dp[0]![0] as number), m - (dp[0]![0] as number)];
}

/** Write a packfile of plain (undeltified) objects, version 2, with a SHA-1 trailer. */
export function writePack(objects: Iterable<{ type: GitObjectType; data: Buffer }>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  const typeCode: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
  for (const object of list) {
    let size = object.data.length;
    const first = (typeCode[object.type] << 4) | (size & 0x0f);
    size >>= 4;
    const bytes: number[] = [size === 0 ? first : first | 0x80];
    while (size > 0) {
      const next = size & 0x7f;
      size >>= 7;
      bytes.push(size === 0 ? next : next | 0x80);
    }
    parts.push(Buffer.from(bytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}
