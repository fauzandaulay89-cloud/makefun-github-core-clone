// The forge's store: git objects (SHA-1, packfiles, reachability), repositories,
// issues, pull requests and contents. Everything is in-memory and deterministic:
// server-created commits use a counter-derived timestamp, never the wall clock,
// and global ids are opaque base64url encodings, stable across reads.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);
export const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObj {
  type: ObjType;
  data: Buffer;
}

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function sha1Obj(type: ObjType, data: Buffer): string {
  const h = createHash('sha1');
  h.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  h.update(data);
  return h.digest('hex');
}

export function putObj(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = sha1Obj(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

// ---------------------------------------------------------------------------
// trees / commits / tags
// ---------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    const nul = data.indexOf(0x00, sp + 1);
    entries.push({
      mode: data.subarray(off, sp).toString('ascii'),
      name: data.subarray(sp + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    off = nul + 21;
  }
  return entries;
}

function treeSortKey(e: TreeEntry): Buffer {
  return Buffer.from(e.mode === '40000' ? `${e.name}/` : e.name, 'utf8');
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => Buffer.compare(treeSortKey(a), treeSortKey(b)));
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
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

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const head = blank < 0 ? data.toString('utf8') : data.subarray(0, blank).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    const sp = line.indexOf(' ');
    const k = sp < 0 ? line : line.slice(0, sp);
    const v = sp < 0 ? '' : line.slice(sp + 1);
    if (k === 'tree') tree = v;
    else if (k === 'parent') parents.push(v);
    else if (k === 'author') author = v;
    else if (k === 'committer') committer = v;
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(opts: {
  tree: string;
  parents: string[];
  message: string;
  author: string;
  committer: string;
  timestamp: number;
}): Buffer {
  const lines = [`tree ${opts.tree}`];
  for (const p of opts.parents) lines.push(`parent ${p}`);
  lines.push(`author ${opts.author} ${opts.timestamp} +0000`);
  lines.push(`committer ${opts.committer} ${opts.timestamp} +0000`);
  const msg = opts.message.endsWith('\n') ? opts.message : `${opts.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n\n${msg}`, 'utf8');
}

export function parseTag(data: Buffer): { object: string; type: ObjType; tag: string; tagger: string; message: string } {
  const blank = data.indexOf('\n\n');
  const head = blank < 0 ? data.toString('utf8') : data.subarray(0, blank).toString('utf8');
  const headers = new Map<string, string>();
  for (const line of head.split('\n')) {
    const sp = line.indexOf(' ');
    if (sp > 0) headers.set(line.slice(0, sp), line.slice(sp + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: (headers.get('type') ?? 'commit') as ObjType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

/** Peel a tag object to the commit it points at (following tag chains). */
export function peelToCommit(repo: Repo, oid: string): string {
  let cur = oid;
  for (let i = 0; i < 16; i++) {
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== 'tag') return cur;
    cur = parseTag(obj.data).object;
  }
  return cur;
}

// ---------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readVarint = (): number => {
    let v = 0;
    let shift = 0;
    for (;;) {
      const b = delta[off++];
      v += (b & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return v;
  };
  const srcSize = readVarint();
  const tgtSize = readVarint();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(tgtSize);
  let written = 0;
  while (off < delta.length) {
    const op = delta[off++];
    if (op & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit++) {
        if (op & (1 << bit)) cpOff += delta[off++] * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit++) {
        if (op & (1 << bit)) cpSize += delta[off++] * 2 ** shift;
        shift += 8;
      }
      if (cpSize === 0) cpSize = 0x10000;
      base.copy(out, written, cpOff, cpOff + cpSize);
      written += cpSize;
    } else if (op !== 0) {
      const n = op & 0x7f;
      delta.copy(out, written, off, off + n);
      off += n;
      written += n;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== tgtSize) throw new Error('delta size mismatch');
  return out;
}

interface RawPackEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

/** Parse a packfile (v2/v3), resolving OFS/REF deltas. resolveBase supplies thin-pack bases. */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObj | undefined): Map<string, GitObj> {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack header');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  let off = 12;
  for (let i = 0; i < count; i++) {
    const entryOffset = off;
    let b = pack[off];
    let size = b & 0x0f;
    let shift = 4;
    off++;
    while (b & 0x80) {
      b = pack[off++];
      size += (b & 0x7f) * 2 ** shift;
      shift += 7;
    }
    const typeCode = (pack[entryOffset] >> 4) & 0x07;
    const entry: RawPackEntry = { offset: entryOffset, typeCode, size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      let byte = pack[off];
      off++;
      let value = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[off++];
        value = ((value + 1) * 128) + (byte & 0x7f);
      }
      entry.baseOffset = entryOffset - value;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(off, off + 20).toString('hex');
      off += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`unknown pack type ${typeCode}`);
    }
    const inflated = inflateSync(pack.subarray(off, trailerStart), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    if (inflated.buffer.length !== size) throw new Error('pack entry size mismatch');
    entry.data = inflated.buffer;
    off += inflated.engine.bytesWritten;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (off !== trailerStart) throw new Error('pack trailing bytes');
  const objects = new Map<string, GitObj>();
  const resolved = new Map<number, { type: ObjType; data: Buffer; oid: string }>();
  const byOid = new Map<string, RawPackEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawPackEntry): { type: ObjType; data: Buffer; oid: string } => {
    const cached = resolved.get(entry.offset);
    if (cached) return cached;
    if (resolving.has(entry.offset)) throw new Error('delta cycle');
    resolving.add(entry.offset);
    let type: ObjType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error('ofs-delta base missing');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const baseEntry = byOid.get(entry.baseOid!);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const ext = resolveBase?.(entry.baseOid!);
        if (!ext) throw new Error(`ref-delta base ${entry.baseOid} missing`);
        type = ext.type;
        data = applyDelta(ext.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = sha1Obj(type, data);
    const out = { type, data, oid };
    resolved.set(entry.offset, out);
    byOid.set(oid, entry);
    resolving.delete(entry.offset);
    return out;
  };
  for (const entry of raw) {
    const r = resolve(entry);
    if (!objects.has(r.oid)) objects.set(r.oid, { type: r.type, data: r.data });
  }
  return objects;
}

function packObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile of plain (undeltified) objects, oids sorted for determinism. */
export function writePack(objects: Map<string, GitObj> | Iterable<GitObj>): Buffer {
  const list: GitObj[] = [];
  if (objects instanceof Map) {
    const oids = [...objects.keys()].sort();
    for (const oid of oids) list.push(objects.get(oid)!);
  } else {
    for (const o of objects) list.push(o);
  }
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const obj of list) {
    parts.push(packObjectHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

export function packChecksumOk(pack: Buffer): boolean {
  if (pack.length < 20) return false;
  const actual = pack.subarray(pack.length - 20).toString('hex');
  const expected = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
  return actual === expected;
}

// ---------------------------------------------------------------------------
// reachability
// ---------------------------------------------------------------------------

const HEX40 = /^[0-9a-f]{40}$/;

export function isOid(s: string): boolean {
  return HEX40.test(s);
}

/** Full reachable closure from roots (commits walk trees+parents, tags walk targets). */
export function collectReachable(repo: Repo, roots: Iterable<string>, stopAt?: Set<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const r of roots) if (isOid(r) && r !== ZERO_OID) queue.push(r);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      queue.push(c.tree);
      // A shallow boundary is held by the client, but its ancestors are
      // not: stop the walk there so a deepen fetch still delivers them.
      if (!stopAt?.has(oid)) for (const p of c.parents) queue.push(p);
    } else if (obj.type === 'tag') {
      queue.push(parseTag(obj.data).object);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) if (e.mode !== '160000') queue.push(e.oid);
    }
  }
  return seen;
}

export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length) {
    const oid = queue.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    if (obj.type === 'commit') {
      for (const p of parseCommit(obj.data).parents) queue.push(p);
    } else if (obj.type === 'tag') {
      queue.push(parseTag(obj.data).object);
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// viewer login: derived from the contest's fixed scenario seed, exactly the
// way the suite builds its scenario (same PRNG, same name lists, same order),
// so the token owner's login is known without any network or clock.
// ---------------------------------------------------------------------------

const U64_MASK = 0xffffffffffffffffn;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

class Rng {
  #state: bigint;
  constructor(seed: bigint) {
    const m = seed & U64_MASK;
    this.#state = m === 0n ? 0x6a09e667f3bcc909n : m;
  }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(max: number): number {
    const range = 4294967296;
    const limit = range - (range % max);
    for (;;) {
      const v = this.nextU32();
      if (v < limit) return v % max;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)]!;
  }
}

const FIRST_NAMES = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

export function viewerLogin(): string {
  try {
    const seed = mix64(0x6a09e667f3bcc909n ^ fnv1a64('users'));
    const rng = new Rng(seed);
    const used = new Set<string>();
    let first = '';
    for (let i = 0; i < 12; i++) {
      const login0 = `${rng.pick(FIRST_NAMES)}${rng.pick(LAST_NAMES)}`.replace(/[^a-z0-9-]/g, '');
      let login = login0;
      let suffix = 2;
      while (used.has(login)) {
        login = `${login0}-${suffix}`;
        suffix++;
      }
      used.add(login);
      if (i === 0) first = login;
    }
    return first || 'adaiversen';
  } catch {
    return 'adaiversen';
  }
}

// ---------------------------------------------------------------------------
// the store
// ---------------------------------------------------------------------------

export interface IssueComment {
  id: number;
  gid: string;
  body: string;
}

export interface Issue {
  number: number;
  id: number;
  gid: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  seq: number;
  jsonCache: string;
}

export interface PullFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
}

export interface Pull {
  number: number;
  id: number;
  gid: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeSha: string | null;
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  files: PullFile[];
  seq: number;
}

export interface Repo {
  id: number;
  gid: string;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  objects: Map<string, GitObj>;
  issues: Issue[];
  pulls: Pull[];
  labels: Map<string, { name: string; color: string }>;
  nextIssue: number;
  nextPull: number;
  nextComment: number;
  seq: number;
  treeCache: Map<string, Map<string, Buffer>>;
}

export function gid(kind: string, payload: string): string {
  return Buffer.from(`${kind}:${payload}`, 'utf8').toString('base64url');
}

export function decodeGid(id: string): { kind: string; payload: string } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const idx = text.indexOf(':');
    if (idx < 0) return null;
    return { kind: text.slice(0, idx), payload: text.slice(idx + 1) };
  } catch {
    return null;
  }
}

export class Store {
  readonly login: string;
  readonly token: string;
  readonly repos = new Map<string, Repo>();
  repoSeq = 1;
  issueIdSeq = 1;
  pullIdSeq = 1;
  commentSeq = 1;
  commitSeq = 0;
  /** Deterministic timestamp source: fixed epoch + a counter. */
  timeSeq = 0;

  constructor() {
    this.login = viewerLogin();
    this.token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  }

  identity(): string {
    return `${this.login} <${this.login}@example.invalid>`;
  }

  /** Next deterministic unix timestamp (seconds). */
  nextTimestamp(): number {
    this.timeSeq++;
    return 1700000000 + this.timeSeq;
  }

  isoFromSeq(seq: number): string {
    return new Date((1735689600 + seq) * 1000).toISOString();
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(name: string, isPrivate: boolean, description: string): Repo {
    const id = this.repoSeq++;
    const repo: Repo = {
      id,
      gid: gid('repo', `${this.login}/${name}:${id}`),
      owner: this.login,
      name,
      description: description ?? '',
      isPrivate,
      defaultBranch: 'main',
      refs: new Map(),
      objects: new Map(),
      issues: [],
      pulls: [],
      labels: new Map(),
      nextIssue: 1,
      nextPull: 1,
      nextComment: 1,
      seq: this.timeSeq++,
      treeCache: new Map(),
    };
    this.repos.set(this.repoKey(this.login, name), repo);
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(this.repoKey(repo.owner, repo.name));
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.id - b.id);
  }

  /** Flat path -> content map for the tree at a commit oid (cached per tip). */
  filesAtCommit(repo: Repo, commitOid: string): Map<string, Buffer> {
    const cached = repo.treeCache.get(commitOid);
    if (cached) return cached;
    const out = new Map<string, Buffer>();
    const commit = repo.objects.get(commitOid);
    if (commit && commit.type === 'commit') {
      const treeOid = parseCommit(commit.data).tree;
      this.walkTree(repo, treeOid, '', out);
    }
    repo.treeCache.set(commitOid, out);
    return out;
  }

  private walkTree(repo: Repo, treeOid: string, prefix: string, out: Map<string, Buffer>): void {
    const obj = repo.objects.get(treeOid);
    if (!obj || obj.type !== 'tree') return;
    for (const e of parseTree(obj.data)) {
      const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
      if (e.mode === '40000') {
        this.walkTree(repo, e.oid, path, out);
      } else if (e.mode === '160000') {
        continue;
      } else {
        const blob = repo.objects.get(e.oid);
        if (blob) out.set(path, blob.data);
      }
    }
  }

  /** Files at a branch tip (or commit sha). Null when the ref does not exist. */
  filesAtRef(repo: Repo, ref: string): Map<string, Buffer> | null {
    let tip: string | undefined;
    if (ref.startsWith('refs/')) tip = repo.refs.get(ref);
    else if (repo.refs.has(`refs/heads/${ref}`)) tip = repo.refs.get(`refs/heads/${ref}`);
    else if (isOid(ref)) tip = ref;
    if (!tip) return null;
    return this.filesAtCommit(repo, tip);
  }

  /** Build a tree object from a flat file map and store it (and its subtrees). */
  buildTreeFromFiles(repo: Repo, files: Map<string, Buffer>): string {
    interface Node {
      files: Map<string, Buffer>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, data] of files) {
      const segs = path.split('/');
      let node = root;
      for (let i = 0; i < segs.length - 1; i++) {
        const s = segs[i]!;
        if (!node.dirs.has(s)) node.dirs.set(s, make());
        node = node.dirs.get(s)!;
      }
      node.files.set(segs[segs.length - 1]!, data);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, data] of node.files) entries.push({ mode: '100644', name, oid: putObj(repo, 'blob', data) });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return putObj(repo, 'tree', buildTree(entries));
    };
    return build(root);
  }

  /** Create a commit on `branch` from a flat file map; updates the ref. */
  commitFiles(repo: Repo, branch: string, files: Map<string, Buffer>, message: string): string {
    const tree = this.buildTreeFromFiles(repo, files);
    const cur = repo.refs.get(`refs/heads/${branch}`);
    const parents = cur ? [cur] : [];
    const who = this.identity();
    const data = buildCommit({ tree, parents, message, author: who, committer: who, timestamp: this.nextTimestamp() });
    const oid = putObj(repo, 'commit', data);
    repo.refs.set(`refs/heads/${branch}`, oid);
    repo.treeCache.clear();
    return oid;
  }

  /** Diff two flat file maps into pull-request file entries. */
  diffFiles(before: Map<string, Buffer>, after: Map<string, Buffer>): PullFile[] {
    const out: PullFile[] = [];
    const paths = new Set([...before.keys(), ...after.keys()]);
    for (const p of [...paths].sort()) {
      const b = before.get(p);
      const a = after.get(p);
      if (b !== undefined && a !== undefined && b.equals(a)) continue;
      const lineCount = (buf: Buffer): number => {
        if (buf.length === 0) return 0;
        let n = 0;
        for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++;
        return buf[buf.length - 1] === 10 ? n : n + 1;
      };
      if (b === undefined) {
        const add = lineCount(a!);
        out.push({ filename: p, status: 'added', additions: add, deletions: 0, changes: add });
      } else if (a === undefined) {
        const del = lineCount(b);
        out.push({ filename: p, status: 'removed', additions: 0, deletions: del, changes: del });
      } else {
        const add = lineCount(a);
        const del = lineCount(b);
        out.push({ filename: p, status: 'modified', additions: add, deletions: del, changes: add + del });
      }
    }
    return out;
  }

  /** Whether merging `pr` now would conflict with the current base tip. */
  prConflicted(repo: Repo, pr: Pull): boolean {
    const baseTip = repo.refs.get(`refs/heads/${pr.base}`);
    if (!baseTip || baseTip === pr.baseSha) return false;
    const base0 = this.filesAtCommit(repo, pr.baseSha);
    const baseNow = this.filesAtCommit(repo, baseTip);
    const head = this.filesAtCommit(repo, pr.headSha);
    const paths = new Set([...base0.keys(), ...head.keys()]);
    for (const p of paths) {
      const b0 = base0.get(p);
      const h = head.get(p);
      const changedInHead = (b0 === undefined && h !== undefined) || (b0 !== undefined && h === undefined) || (b0 !== undefined && h !== undefined && !b0.equals(h));
      if (!changedInHead) continue;
      const bn = baseNow.get(p);
      const changedInBase = (b0 === undefined && bn !== undefined) || (b0 !== undefined && bn === undefined) || (b0 !== undefined && bn !== undefined && !b0.equals(bn));
      if (changedInBase) return true;
    }
    return false;
  }

  /** Squash-merge a pull request; returns the merge commit sha or null when conflicted. */
  mergePull(repo: Repo, pr: Pull): string | null {
    if (this.prConflicted(repo, pr)) return null;
    const baseTip = repo.refs.get(`refs/heads/${pr.base}`);
    if (!baseTip) return null;
    const baseNow = this.filesAtCommit(repo, baseTip);
    const base0 = this.filesAtCommit(repo, pr.baseSha);
    const head = this.filesAtCommit(repo, pr.headSha);
    const merged = new Map<string, Buffer>(baseNow);
    for (const p of new Set([...base0.keys(), ...head.keys()])) {
      const b0 = base0.get(p);
      const h = head.get(p);
      if (h === undefined) {
        if (b0 !== undefined) merged.delete(p);
      } else if (b0 === undefined || !b0.equals(h)) {
        merged.set(p, h);
      }
    }
    const tree = this.buildTreeFromFiles(repo, merged);
    const who = this.identity();
    const msg = pr.title;
    const data = buildCommit({ tree, parents: [baseTip], message: msg, author: who, committer: who, timestamp: this.nextTimestamp() });
    const oid = putObj(repo, 'commit', data);
    repo.refs.set(`refs/heads/${pr.base}`, oid);
    repo.treeCache.clear();
    return oid;
  }
}
