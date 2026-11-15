// git smart HTTP: the pkt-line codec, packfile reading, and the three services
// (info/refs, git-upload-pack, git-receive-pack) in protocol v2 and v0.
// Deltas are never sent: every pack is plain objects, which the suite's
// client resolves without a base. Packets are capped at git's LARGE_PACKET_MAX.

import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import {
  ZERO_OID,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  writePack,
  type GitObject,
  type GitObjectType,
  type Repo,
  type Store,
} from './store.ts';

export const PKT_LINE_MAX = 65520;

export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.alloc(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/** Decode a whole buffer of pkt-lines into data payloads plus control markers. */
export function decodePktLines(buffer: Buffer): Array<{ kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' }> {
  const out: Array<{ kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' }> = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      out.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      out.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      out.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buffer.length) break;
    out.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return out;
}

/** The data payloads of a pkt-line buffer, as UTF-8 lines without their trailing newline. */
export function pktLinesText(buffer: Buffer): string[] {
  const lines: string[] = [];
  for (const packet of decodePktLines(buffer)) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// packfile reading
// ---------------------------------------------------------------------------

const PACK_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function readPackEntryHeader(buffer: Buffer, start: number): { type: GitObjectType; size: number; next: number; first: number } {
  let byte = buffer[start] as number;
  const first = byte;
  const typeCode = (byte >> 4) & 0x7;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset] as number;
    offset += 1;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  const type = PACK_TYPE[typeCode];
  if (type === undefined) throw new Error(`unknown pack object type ${typeCode}`);
  return { type, size, next: offset, first };
}

/** Inflate one zlib stream starting at `offset`; returns its bytes and the offset just past it. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  const result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start] as number;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset] as number;
    offset += 1;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Apply a git delta instruction stream to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] as number;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOffset += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          copySize += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

export interface PackRead {
  objects: Map<string, GitObject>;
}

/** Read a packfile (v2/v3), resolving OFS_DELTA and REF_DELTA entries. */
export function readPack(pack: Buffer): PackRead {
  if (pack.length < 32) throw new Error('pack is too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const expected = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
  const actual = pack.subarray(pack.length - 20).toString('hex');
  if (expected !== actual) throw new Error('pack trailer checksum mismatch');
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, string>();
  interface PendingDelta {
    oid: string;
    type: GitObjectType;
    data: Buffer;
    baseOid: string | null;
    baseOffset: number | null;
  }
  const pending: PendingDelta[] = [];
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    const header = readPackEntryHeader(pack, offset);
    offset = header.next;
    if (header.first >> 4 === 6) {
      const base = readOfsDeltaBase(pack, offset);
      offset = base.next;
      const inflated = inflateAt(pack, offset);
      offset = inflated.next;
      const baseOffset = entryOffset - base.baseOffset;
      pending.push({ oid: '', type: 'commit', data: inflated.data, baseOid: null, baseOffset });
    } else if (header.first >> 4 === 7) {
      const baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const inflated = inflateAt(pack, offset);
      offset = inflated.next;
      pending.push({ oid: '', type: 'commit', data: inflated.data, baseOid, baseOffset: null });
    } else {
      const inflated = inflateAt(pack, offset);
      offset = inflated.next;
      if (inflated.data.length !== header.size) throw new Error('pack object size mismatch');
      const oid = hashObject(header.type, inflated.data);
      objects.set(oid, { type: header.type, data: inflated.data });
      byOffset.set(entryOffset, oid);
    }
  }
  for (const delta of pending) {
    let baseOid = delta.baseOid;
    if (baseOid === null && delta.baseOffset !== null) baseOid = byOffset.get(delta.baseOffset) ?? null;
    if (baseOid === null) throw new Error('delta base not found in pack');
    const base = objects.get(baseOid);
    if (base === undefined) throw new Error('delta base object missing');
    const data = applyDelta(base.data, delta.data);
    const oid = hashObject(base.type, data);
    objects.set(oid, { type: base.type, data });
    delta.oid = oid;
  }
  return { objects };
}

// ---------------------------------------------------------------------------
// fetch planning
// ---------------------------------------------------------------------------

export interface FetchPlan {
  /** Objects to send, in a stable order. */
  objects: GitObject[];
  /** The new shallow boundary commits (depth cut). */
  shallow: string[];
  /** Old shallow commits now fully included. */
  unshallow: string[];
}

interface ReachableWalk {
  /** Commits to send. */
  included: Set<string>;
  /** Sent commits at the depth limit whose parents were not sent. */
  boundary: Set<string>;
  /** Old shallow commits now fully included. */
  unshallow: string[];
  /** Non-commit objects to send outright (tag objects and their non-commit targets). */
  extra: Set<string>;
  /** Commits the client already fully holds. */
  held: Set<string>;
}

/** Follow an annotated tag to the object it names (commit or otherwise). */
function peelTagTarget(repo: Repo, oid: string): string | null {
  let current = oid;
  for (let depth = 0; depth < 10; depth += 1) {
    const object = repo.store.get(current);
    if (object === undefined) return null;
    if (object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
  return null;
}

/** Add a tree and everything under it (subtrees and blobs) to `out`. */
function addTreeObjects(repo: Repo, treeOid: string, out: Set<string>): void {
  const stack: string[] = [treeOid];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (out.has(oid)) continue;
    const object = repo.store.get(oid);
    if (object === undefined || object.type !== 'tree') continue;
    out.add(oid);
    for (const entry of parseTree(object.data)) {
      if (entry.mode === '40000') stack.push(entry.oid);
      else out.add(entry.oid);
    }
  }
}

/** Add a commit and its whole tree to `out` (never its parents). */
function addCommitObjects(repo: Repo, commitOid: string, out: Set<string>): void {
  const object = repo.store.get(commitOid);
  if (object === undefined || object.type !== 'commit') return;
  out.add(commitOid);
  addTreeObjects(repo, parseCommit(object.data).tree, out);
}

/**
 * The commits reachable from `wants` within `depth` (null = unlimited).
 *
 * A commit the client already holds is never re-sent, but the walk still
 * goes through it when depth is set (a deepen must reach the parent of an
 * old shallow boundary) and through an old shallow boundary when depth is
 * not set (a full fetch unshallows it). The client's held set stops at its
 * shallow boundary: the parents of a shallow commit are not held.
 */
function walkCommits(
  repo: Repo,
  wants: readonly string[],
  haves: ReadonlySet<string>,
  shallow: readonly string[],
  depth: number | null,
): ReachableWalk {
  const shallowSet = new Set(shallow);
  const held = new Set<string>();
  const heldQueue = [...haves];
  while (heldQueue.length > 0) {
    const oid = heldQueue.shift() as string;
    if (held.has(oid)) continue;
    const object = repo.store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    held.add(oid);
    if (shallowSet.has(oid)) continue;
    for (const parent of parseCommit(object.data).parents) heldQueue.push(parent);
  }

  const included = new Set<string>();
  const boundary = new Set<string>();
  const extra = new Set<string>();
  const visited = new Set<string>();
  const queue: Array<{ oid: string; level: number }> = [];
  for (const want of wants) {
    const object = repo.store.get(want);
    if (object === undefined) continue;
    if (object.type === 'commit') {
      queue.push({ oid: want, level: 1 });
    } else if (object.type === 'tag') {
      extra.add(want);
      const target = peelTagTarget(repo, want);
      if (target === null) continue;
      if (repo.store.get(target)?.type === 'commit') queue.push({ oid: target, level: 1 });
      else extra.add(target);
    } else {
      extra.add(want);
    }
  }
  const seen = new Set<string>();
  while (queue.length > 0) {
    const item = queue.shift() as { oid: string; level: number };
    if (seen.has(item.oid)) continue;
    seen.add(item.oid);
    const object = repo.store.get(item.oid);
    if (object === undefined || object.type !== 'commit') continue;
    visited.add(item.oid);
    const isHeld = held.has(item.oid);
    const isShallowHeld = isHeld && shallowSet.has(item.oid);
    if (!isHeld) included.add(item.oid);
    const parents = parseCommit(object.data).parents;
    const atLimit = depth !== null && item.level >= depth;
    if (atLimit) {
      if (!isHeld && parents.length > 0) boundary.add(item.oid);
      continue;
    }
    if (isHeld && !isShallowHeld) continue;
    for (const parent of parents) queue.push({ oid: parent, level: item.level + 1 });
  }
  const unshallow: string[] = [];
  for (const old of shallow) {
    if (!visited.has(old)) continue;
    if (boundary.has(old)) continue;
    unshallow.push(old);
  }
  return { included, boundary, unshallow, extra, held };
}

export function planFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  shallow: readonly string[],
  depth: number | null,
): FetchPlan {
  const haveSet = new Set(haves);
  const walk = walkCommits(repo, wants, haveSet, shallow, depth);
  // The objects the client already holds: the closure of its held commits.
  const heldObjects = new Set<string>();
  for (const oid of walk.held) addCommitObjects(repo, oid, heldObjects);
  for (const have of haveSet) if (repo.store.has(have)) heldObjects.add(have);
  const toSend = new Set<string>();
  for (const oid of walk.included) addCommitObjects(repo, oid, toSend);
  for (const oid of walk.extra) toSend.add(oid);
  for (const oid of heldObjects) toSend.delete(oid);
  const objects: GitObject[] = [];
  for (const oid of [...toSend].sort()) {
    const object = repo.store.get(oid);
    if (object !== undefined) objects.push(object);
  }
  return { objects, shallow: [...walk.boundary].sort(), unshallow: [...walk.unshallow].sort() };
}

// ---------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------

const V2_CAPS = ['ls-refs=unborn', 'fetch=shallow filter', 'agent=forge/1.0', 'object-format=sha1'];
const V0_UPLOAD_CAPS = 'multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not filter agent=forge/1.0 symref=HEAD:refs/heads/main object-format=sha1';
const V0_RECEIVE_CAPS = 'report-status side-band-64k delete-refs ofs-delta agent=forge/1.0 symref=HEAD:refs/heads/main object-format=sha1';

/** The refs a repo advertises, sorted by name, with peeled tag targets. */
export function advertisedRefs(repo: Repo): Array<{ oid: string; name: string; peeled?: string }> {
  const refs: Array<{ oid: string; name: string; peeled?: string }> = [];
  for (const name of [...repo.refs.keys()].sort()) {
    const oid = repo.refs.get(name) as string;
    const entry: { oid: string; name: string; peeled?: string } = { oid, name };
    if (name.startsWith('refs/tags/')) {
      const object = repo.store.get(oid);
      if (object !== undefined && object.type === 'tag') entry.peeled = parseTag(object.data).object;
    }
    refs.push(entry);
  }
  return refs;
}

/** The v2 capability advertisement. */
export function advertisementV2(): Buffer {
  const parts: Buffer[] = [pktLine('version 2\n')];
  for (const cap of V2_CAPS) parts.push(pktLine(`${cap}\n`));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** The v0 ref advertisement for upload-pack or receive-pack. */
export function advertisementV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? V0_UPLOAD_CAPS : V0_RECEIVE_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const refs = advertisedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const head = repo.refs.get('refs/heads/main');
    const lines: string[] = [];
    if (head !== undefined) lines.push(`${head} HEAD\0${caps}\n`);
    for (const ref of refs) {
      lines.push(`${ref.oid} ${ref.name}\n`);
      if (ref.peeled !== undefined) lines.push(`${ref.peeled} ${ref.name}^{}\n`);
    }
    if (head === undefined && lines.length > 0) {
      const first = lines[0] as string;
      const space = first.indexOf(' ');
      lines[0] = `${first.slice(0, space)} ${first.slice(space + 1).replace(/\n$/, '')}\0${caps}\n`;
    }
    for (const line of lines) parts.push(pktLine(line));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// sideband framing
// ---------------------------------------------------------------------------

/** Wrap `data` in sideband band-1 packets of at most 32768 payload bytes each. */
export function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return Buffer.concat(parts);
}

/** One sideband band-1 packet carrying `text` (already pkt-lined inside band 1 when `inner` is set). */
export function sidebandLine(text: string): Buffer {
  return pktLine(Buffer.concat([Buffer.from([1]), pktLine(text)]));
}

// ---------------------------------------------------------------------------
// upload-pack
// ---------------------------------------------------------------------------

export interface UploadPackRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  deepenSince: number | null;
}

/** Parse a v2 fetch request body (after the command line) into its arguments. */
export function parseV2Fetch(body: Buffer): UploadPackRequest {
  const packets = decodePktLines(body);
  const request: UploadPackRequest = { wants: [], haves: [], shallow: [], depth: null, deepenSince: null };
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!seenDelim) continue;
    if (line.startsWith('want ')) request.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) request.depth = Number.parseInt(line.slice(7).trim(), 10);
    else if (line.startsWith('deepen-since ')) request.deepenSince = Number.parseInt(line.slice(13).trim(), 10);
  }
  return request;
}

/** Parse a v0 upload-pack request body into its arguments. */
export function parseV0Fetch(body: Buffer): UploadPackRequest {
  const packets = decodePktLines(body);
  const request: UploadPackRequest = { wants: [], haves: [], shallow: [], depth: null, deepenSince: null };
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) request.wants.push(line.slice(5).split(' ')[0] as string);
    else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) request.depth = Number.parseInt(line.slice(7).trim(), 10);
    else if (line.startsWith('deepen-since ')) request.deepenSince = Number.parseInt(line.slice(13).trim(), 10);
  }
  return request;
}

/** Parse a v2 ls-refs request body into its arguments. */
export function parseV2LsRefs(body: Buffer): { peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[] } {
  const packets = decodePktLines(body);
  const args = { peel: false, symrefs: false, unborn: false, prefixes: [] as string[] };
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!seenDelim) continue;
    if (line === 'peel') args.peel = true;
    else if (line === 'symrefs') args.symrefs = true;
    else if (line === 'unborn') args.unborn = true;
    else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice(11));
  }
  return args;
}

/** The v2 ls-refs answer for a repo. */
export function lsRefsV2(repo: Repo, args: { peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[] }): Buffer {
  const parts: Buffer[] = [];
  const refs = advertisedRefs(repo);
  const keep = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const headTip = repo.refs.get('refs/heads/main');
  if (refs.length === 0) {
    if (keep('HEAD') && args.unborn) parts.push(pktLine('unborn HEAD symref-target:refs/heads/main\n'));
    parts.push(pktFlush());
    return Buffer.concat(parts);
  }
  if (args.symrefs && headTip !== undefined && keep('HEAD')) {
    parts.push(pktLine(`${headTip} HEAD symref-target:refs/heads/main\n`));
  }
  for (const ref of refs) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (args.peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** The v2 fetch answer: acknowledgments, shallow-info and the sideband packfile. */
export function fetchV2(repo: Repo, request: UploadPackRequest): Buffer {
  const plan = planFetch(repo, request.wants, request.haves, request.shallow, request.depth);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  parts.push(pktLine('NAK\n'));
  parts.push(pktDelim());
  if (request.depth !== null) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  if (plan.objects.length > 0) {
    const pack = writePack(plan.objects);
    parts.push(pktLine('packfile\n'));
    parts.push(sidebandPack(pack));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** The v0 fetch answer: NAK, shallow lines, then the sideband packfile. */
export function fetchV0(repo: Repo, request: UploadPackRequest): Buffer {
  const plan = planFetch(repo, request.wants, request.haves, request.shallow, request.depth);
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (plan.objects.length > 0) {
    const pack = writePack(plan.objects);
    parts.push(sidebandPack(pack));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export interface PushReport {
  unpackOk: boolean;
  unpackDetail: string;
  refs: Array<{ ref: string; ok: boolean; reason: string }>;
}

/**
 * Apply a receive-pack command list to a repo. The pack (already read) holds
 * the objects the client sent; objects already on the server stay.
 */
export function applyPush(repo: Repo, commands: readonly PushCommand[], packObjects: Map<string, GitObject>): PushReport {
  for (const [oid, object] of packObjects) {
    if (!repo.store.has(oid)) repo.store.objects.set(oid, object);
  }
  const refs: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      if (current === undefined) {
        refs.push({ ref: command.ref, ok: false, reason: 'no such ref' });
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        refs.push({ ref: command.ref, ok: false, reason: 'old value mismatch' });
      } else {
        repo.refs.delete(command.ref);
        refs.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      if (current !== undefined) {
        refs.push({ ref: command.ref, ok: false, reason: 'already exists' });
        continue;
      }
    } else {
      if (current === undefined) {
        refs.push({ ref: command.ref, ok: false, reason: 'no such ref' });
        continue;
      }
      if (current !== command.oldOid) {
        refs.push({ ref: command.ref, ok: false, reason: 'old value mismatch' });
        continue;
      }
      if (!repo.store.isAncestor(command.oldOid, command.newOid)) {
        refs.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
    }
    if (!repo.store.has(command.newOid)) {
      refs.push({ ref: command.ref, ok: false, reason: 'object not found' });
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    refs.push({ ref: command.ref, ok: true, reason: '' });
  }
  return { unpackOk: true, unpackDetail: 'ok', refs };
}

/** Parse a receive-pack body into its command list and the raw pack bytes that follow. */
export function parseReceivePack(body: Buffer): { commands: PushCommand[]; pack: Buffer } {
  const commands: PushCommand[] = [];
  let packStart = body.length;
  let offset = 0;
  let first = true;
  while (offset + 4 <= body.length) {
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      offset += 4;
      packStart = offset;
      break;
    }
    if (length < 4 || offset + length > body.length) break;
    const payload = body.subarray(offset + 4, offset + length).toString('utf8');
    const nul = payload.indexOf('\0');
    const line = (nul >= 0 && first ? payload.slice(0, nul) : payload).replace(/\n$/, '');
    const parts = line.split(' ');
    if (parts.length >= 3) {
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
    }
    first = false;
    offset += length;
  }
  return { commands, pack: body.subarray(packStart) };
}

/** The receive-pack answer: the report-status stream inside sideband band 1. */
export function pushReportResponse(report: PushReport): Buffer {
  const parts: Buffer[] = [];
  parts.push(sidebandLine(`unpack ${report.unpackDetail}\n`));
  for (const ref of report.refs) {
    if (ref.ok) parts.push(sidebandLine(`ok ${ref.ref}\n`));
    else parts.push(sidebandLine(`ng ${ref.ref} ${ref.reason}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

export function unpackErrorResponse(detail: string): Buffer {
  const parts: Buffer[] = [sidebandLine(`unpack ${detail}\n`), pktFlush()];
  return Buffer.concat(parts);
}
