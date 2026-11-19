// Git smart HTTP: protocol v2 upload-pack (capability advertisement, ls-refs,
// fetch with shallow/deepen), v0 upload-pack fallback, and v0 receive-pack
// (report-status, side-band-64k, delete-refs, fast-forward only).

import {
  ZERO_OID,
  collectReachable,
  isAncestor,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
  readPack,
  writePack,
  type GitObj,
  type Repo,
} from './store.ts';

// ---------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------

export function pkt(data: string | Buffer): Buffer {
  const body = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const header = Buffer.allocUnsafe(4);
  header.write((body.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, body]);
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');

export interface Pkt {
  kind: 'data' | 'flush' | 'delim' | 'end';
  payload?: Buffer;
}

/** Decode pkt-lines from the start of `buf`; returns packets and bytes consumed. */
export function decodePktLines(buf: Buffer): { packets: Pkt[]; consumed: number } {
  const packets: Pkt[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const head = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const len = parseInt(head, 16);
    if (len === 0) {
      packets.push({ kind: 'flush' });
      off += 4;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim' });
      off += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'end' });
      off += 4;
      continue;
    }
    if (len < 4 || off + len > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return { packets, consumed: off };
}

function pktLines(items: (string | Buffer | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(FLUSH);
    else if (item === 'delim') parts.push(DELIM);
    else parts.push(pkt(item));
  }
  return Buffer.concat(parts);
}

/** Split pack bytes into sideband band-1 pkt-lines (max 65515 data bytes each). */
function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let off = 0; off < pack.length; off += 65515) {
    const chunk = pack.subarray(off, Math.min(pack.length, off + 65515));
    const payload = Buffer.concat([Buffer.from([1]), chunk]);
    parts.push(pkt(payload));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// ref listing
// ---------------------------------------------------------------------------

export interface RefInfo {
  oid: string;
  name: string;
  peeled?: string;
}

export function listRefs(repo: Repo): RefInfo[] {
  const out: RefInfo[] = [];
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const info: RefInfo = { oid, name };
    const obj = repo.objects.get(oid);
    if (obj && obj.type === 'tag') info.peeled = peelToCommit(repo, oid);
    out.push(info);
  }
  return out;
}

function headTarget(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

// ---------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------

export function advertisementV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const refs = listRefs(repo);
  const parts: Buffer[] = [pkt(`# service=${service}\n`), FLUSH];
  const caps =
    service === 'git-upload-pack'
      ? 'side-band-64k thin-pack ofs-delta shallow multi_ack_detailed symref=HEAD:' + headTarget(repo)
      : 'report-status side-band-64k delete-refs ofs-delta thin-pack symref=HEAD:' + headTarget(repo);
  const headOid = repo.refs.get(headTarget(repo)) ?? ZERO_OID;
  if (refs.length === 0) {
    parts.push(pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const lines: Buffer[] = [];
    lines.push(pkt(`${headOid} HEAD\0${caps}\n`));
    for (const r of refs) {
      lines.push(pkt(`${r.oid} ${r.name}\n`));
      if (r.peeled) lines.push(pkt(`${r.peeled} ${r.name}^{}\n`));
    }
    parts.push(...lines);
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

export function advertisementV2(): Buffer {
  return pktLines([
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow filter\n',
    'object-format=sha1\n',
    'agent=github-forge/1.0\n',
    'flush',
  ]);
}

// ---------------------------------------------------------------------------
// fetch planning
// ---------------------------------------------------------------------------

interface FetchPlan {
  send: Map<string, GitObj>;
  shallow: string[];
  unshallow: string[];
  acks: string[];
}

/**
 * Plan a fetch: objects reachable from `wants` (depth-limited when `depth` is
 * set), minus everything reachable from `haves`. Also computes shallow
 * boundaries and unshallow lines for deepen requests.
 */
export function planFetch(
  repo: Repo,
  wants: string[],
  haves: string[],
  opts: { depth?: number; shallow?: string[] },
): FetchPlan {
  const excluded = collectReachable(repo, haves, new Set(opts.shallow ?? []));
  const included = new Map<string, GitObj>();
  const shallow: string[] = [];
  const unshallow: string[] = [];
  const depth = opts.depth;
  const wantCommits = new Set<string>();

  const addTree = (treeOid: string): void => {
    const stack = [treeOid];
    while (stack.length) {
      const oid = stack.pop()!;
      const obj = repo.objects.get(oid);
      if (!obj || included.has(oid)) continue;
      included.set(oid, obj);
      if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) if (e.mode !== '160000') stack.push(e.oid);
      }
    }
  };

  const queue: { oid: string; gen: number }[] = [];
  for (const w of wants) {
    const obj = repo.objects.get(w);
    if (!obj) continue;
    if (obj.type === 'tag') {
      included.set(w, obj);
      const target = parseTag(obj.data).object;
      const tObj = repo.objects.get(target);
      if (tObj && tObj.type === 'commit') queue.push({ oid: target, gen: 1 });
      else if (tObj) included.set(target, tObj);
    } else if (obj.type === 'commit') {
      queue.push({ oid: w, gen: 1 });
    } else {
      included.set(w, obj);
    }
  }
  const seenCommit = new Set<string>();
  while (queue.length) {
    const { oid, gen } = queue.shift()!;
    if (seenCommit.has(oid)) continue;
    seenCommit.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    wantCommits.add(oid);
    included.set(oid, obj);
    const c = parseCommit(obj.data);
    addTree(c.tree);
    const atBoundary = depth !== undefined && gen >= depth;
    if (atBoundary) {
      if (c.parents.length > 0) shallow.push(oid);
    } else {
      for (const p of c.parents) queue.push({ oid: p, gen: gen + 1 });
    }
  }
  // unshallow: previously-shallow boundaries whose parents are now included.
  for (const s of opts.shallow ?? []) {
    if (!wantCommits.has(s)) continue;
    if (shallow.includes(s)) continue;
    unshallow.push(s);
  }
  const send = new Map<string, GitObj>();
  for (const [oid, obj] of included) {
    if (!excluded.has(oid)) send.set(oid, obj);
  }
  // ACKs: haves that are ancestors of (or equal to) a want.
  const acks: string[] = [];
  for (const h of haves) {
    if (wantCommits.has(h)) {
      acks.push(h);
      continue;
    }
    for (const w of wants) {
      if (isAncestor(repo, h, w)) {
        acks.push(h);
        break;
      }
    }
  }
  return { send, shallow, unshallow, acks };
}

// ---------------------------------------------------------------------------
// v2 fetch / ls-refs request parsing
// ---------------------------------------------------------------------------

interface V2Command {
  command: string;
  args: string[];
  done: boolean;
}

function parseV2Request(body: Buffer): V2Command | null {
  const { packets } = decodePktLines(body);
  let command = '';
  const args: string[] = [];
  let seenDelim = false;
  for (const p of packets) {
    if (p.kind === 'flush') break;
    if (p.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (p.kind !== 'data' || !p.payload) continue;
    const line = p.payload.toString('utf8');
    if (!seenDelim) {
      const m = /^command=(\S+)\n?$/.exec(line.trim());
      if (m) command = m[1]!;
    } else {
      args.push(line);
    }
  }
  if (!command) return null;
  const done = args.some((a) => a.trim() === 'done');
  return { command, args, done };
}

function v2FetchResponse(repo: Repo, plan: FetchPlan, wants: string[], haves: string[], done: boolean): Buffer {
  const parts: Buffer[] = [];
  // The acknowledgments section is sent only while negotiating (haves were
  // sent without `done`). When the client sent `done` — the normal case for
  // a clone or a fetch that ends negotiation — the server goes straight to
  // the pack (upload-pack.c: no haves, or done, skips the ack section).
  // A client that sent haves without done gets NAK, or ACK lines + ready
  // (ack section closed by DELIM, then the pack follows in this response).
  if (!done && haves.length > 0) {
    parts.push(pkt('acknowledgments\n'));
    if (plan.acks.length > 0) {
      for (const a of plan.acks) parts.push(pkt(`ACK ${a}\n`));
      parts.push(pkt('ready\n'));
      parts.push(DELIM);
    } else {
      parts.push(pkt('NAK\n'));
      parts.push(FLUSH);
      return Buffer.concat(parts);
    }
  }
  // shallow-info
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pkt('shallow-info\n'));
    for (const s of plan.shallow) parts.push(pkt(`shallow ${s}\n`));
    for (const u of plan.unshallow) parts.push(pkt(`unshallow ${u}\n`));
    parts.push(FLUSH);
  }
  // packfile
  if (plan.send.size > 0) {
    parts.push(pkt('packfile\n'));
    parts.push(sidebandPack(writePack(plan.send)));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function v2LsRefsResponse(repo: Repo, prefixes: string[]): Buffer {
  const parts: Buffer[] = [];
  const headOid = repo.refs.get(headTarget(repo));
  const headName = headTarget(repo);
  const all = listRefs(repo);
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  // HEAD is listed when no filter is in force, or when a prefix matches it
  // (e.g. ref-prefix HEAD); a prefix like refs/heads/ does not match HEAD.
  if (prefixes.length === 0 || prefixes.some((p) => 'HEAD'.startsWith(p))) {
    if (headOid) {
      parts.push(pkt(`${headOid} HEAD symref-target:${headName}\n`));
    } else {
      parts.push(pkt(`unborn HEAD symref-target:${headName}\n`));
    }
  }
  for (const r of all) {
    if (!keep(r.name)) continue;
    let line = `${r.oid} ${r.name}`;
    if (r.peeled) line += ` peeled:${r.peeled}`;
    parts.push(pkt(`${line}\n`));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** Handle POST git-upload-pack (v2 when the Git-Protocol header says so, else v0). */
export function handleUploadPack(repo: Repo, body: Buffer, isV2: boolean): { status: number; contentType: string; body: Buffer } {
  const CT = 'application/x-git-upload-pack-result';
  if (isV2) {
    const cmd = parseV2Request(body);
    if (!cmd) return { status: 400, contentType: CT, body: Buffer.from('bad request') };
    if (cmd.command === 'ls-refs') {
      const prefixes: string[] = [];
      for (const a of cmd.args) {
        const m = /^ref-prefix (\S+)\n?$/.exec(a.trim());
        if (m) prefixes.push(m[1]!);
      }
      return { status: 200, contentType: CT, body: v2LsRefsResponse(repo, prefixes) };
    }
    if (cmd.command === 'fetch') {
      const wants: string[] = [];
      const haves: string[] = [];
      const shallow: string[] = [];
      let depth: number | undefined;
      for (const a of cmd.args) {
        const line = a.trim();
        if (line.startsWith('want ')) wants.push(line.slice(5).trim());
        else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
        else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
        else if (line.startsWith('deepen ')) {
          const n = parseInt(line.slice(7).trim(), 10);
          if (Number.isFinite(n)) depth = n;
        }
      }
      const plan = planFetch(repo, wants, haves, { depth, shallow });
      return { status: 200, contentType: CT, body: v2FetchResponse(repo, plan, wants, haves, cmd.done) };
    }
    return { status: 400, contentType: CT, body: Buffer.from('unknown command') };
  }
  // ---- v0 fetch ----
  // Response order (git 2.43 fetch-pack.c, find_common): when a depth was
  // requested the client reads the shallow/unshallow list FIRST (up to a
  // flush), then the ACK/NAK lines, then the pack. A request without `done`
  // is a negotiation round: answer with the shallow list (+ acks) only; the
  // pack is sent only in the final (`done`) round.
  const { packets } = decodePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  let done = false;
  for (const p of packets) {
    if (p.kind === 'flush') continue;
    if (p.kind !== 'data' || !p.payload) continue;
    const line = p.payload.toString('utf8').trim();
    if (line.startsWith('want ')) {
      const rest = line.slice(5).trim();
      wants.push(rest.split(' ')[0]!);
    } else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n)) depth = n;
    } else if (line === 'done') done = true;
  }
  const plan = planFetch(repo, wants, haves, { depth, shallow });
  const parts: Buffer[] = [];
  const hasShallowInfo = plan.shallow.length > 0 || plan.unshallow.length > 0;
  if (hasShallowInfo) {
    for (const s of plan.shallow) parts.push(pkt(`shallow ${s}\n`));
    for (const u of plan.unshallow) parts.push(pkt(`unshallow ${u}\n`));
    parts.push(FLUSH);
  }
  if (!done) {
    // Negotiation round: no pack yet. (A deepen round answers with the
    // shallow list alone; a haves round also gets the ACK/NAK lines.) The
    // client reads the shallow list up to a flush, so always terminate it.
    if (depth !== undefined && !hasShallowInfo) parts.push(FLUSH);
    if (depth === undefined) {
      if (plan.acks.length > 0) {
        for (const a of plan.acks) parts.push(pkt(`ACK ${a}\n`));
      } else {
        parts.push(pkt('NAK\n'));
      }
      parts.push(FLUSH);
    }
    return { status: 200, contentType: CT, body: Buffer.concat(parts) };
  }
  if (plan.acks.length > 0) {
    for (const a of plan.acks) parts.push(pkt(`ACK ${a}\n`));
  } else {
    parts.push(pkt('NAK\n'));
  }
  if (plan.send.size > 0) parts.push(sidebandPack(writePack(plan.send)));
  parts.push(FLUSH);
  // Response-end marker for stateless RPC (real git's fetch-pack expects it
  // after the pack; the suite's v0 consumer ignores non-data packets).
  parts.push(Buffer.from('0002', 'ascii'));
  return { status: 200, contentType: CT, body: Buffer.concat(parts) };
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export interface PushReportLine {
  ref: string;
  ok: boolean;
  reason: string;
}

/**
 * Apply a receive-pack request. Returns the report lines; the caller frames
 * them into a sideband response. Objects from the pack are stored first
 * (unpack), then each command is validated (fast-forward only) and applied.
 */
export function handleReceivePack(repo: Repo, body: Buffer): { status: number; contentType: string; body: Buffer } {
  const CT = 'application/x-git-receive-pack-result';
  const { packets, consumed } = decodePktLines(body);
  const commands: PushCommand[] = [];
  let malformed = false;
  for (const p of packets) {
    if (p.kind === 'flush') break;
    if (p.kind !== 'data' || !p.payload) continue;
    const text = p.payload.toString('utf8');
    const line = text.replace(/\n$/, '');
    const nul = line.indexOf('\0');
    const head = nul >= 0 ? line.slice(0, nul) : line;
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(head);
    if (!m) {
      malformed = true;
      continue;
    }
    commands.push({ oldOid: m[1]!, newOid: m[2]!, ref: m[3]! });
  }
  if (malformed || commands.length === 0) {
    // Still answer with a report so the client can parse it; unpack ok, no refs.
    const report = pktLines(['unpack ok\n', 'flush']);
    return { status: 200, contentType: CT, body: sidebandReport(report) };
  }
  // Unpack: everything after the command flush is the packfile. A real git
  // client appends a 0002 response-end packet after the pack; if the pack
  // does not parse as-is, retry without a trailing 0002.
  const packBytes = body.subarray(consumed);
  let unpackOk = true;
  if (packBytes.length > 0) {
    const tryUnpack = (bytes: Buffer): boolean => {
      try {
        const objects = readPack(bytes, (oid) => repo.objects.get(oid));
        for (const [oid, obj] of objects) {
          if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
        }
        return true;
      } catch {
        return false;
      }
    };
    unpackOk = tryUnpack(packBytes);
    if (!unpackOk && packBytes.length >= 4 && packBytes.subarray(packBytes.length - 4).toString('ascii') === '0002') {
      unpackOk = tryUnpack(packBytes.subarray(0, packBytes.length - 4));
    }
  }
  const lines: (string | 'flush')[] = [unpackOk ? 'unpack ok\n' : 'unpack error\n'];
  const reportLines: PushReportLine[] = [];
  if (unpackOk) {
    for (const cmd of commands) {
      const current = repo.refs.get(cmd.ref);
      let ok = true;
      let reason = '';
      if (cmd.newOid === ZERO_OID) {
        // delete
        if (!current) {
          ok = false;
          reason = 'no such ref';
        } else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) {
          ok = false;
          reason = 'non-fast-forward';
        }
      } else if (cmd.oldOid === ZERO_OID) {
        // create
        if (current) {
          ok = false;
          reason = 'already exists';
        } else if (!repo.objects.has(cmd.newOid)) {
          ok = false;
          reason = 'missing object';
        }
      } else {
        // update
        if (!current || current !== cmd.oldOid) {
          ok = false;
          reason = 'non-fast-forward';
        } else if (!repo.objects.has(cmd.newOid)) {
          ok = false;
          reason = 'missing object';
        } else if (cmd.ref.startsWith('refs/heads/') && !isAncestor(repo, cmd.oldOid, cmd.newOid)) {
          ok = false;
          reason = 'non-fast-forward';
        }
      }
      if (ok) {
        if (cmd.newOid === ZERO_OID) repo.refs.delete(cmd.ref);
        else repo.refs.set(cmd.ref, cmd.newOid);
        repo.treeCache.clear();
        lines.push(`ok ${cmd.ref}\n`);
      } else {
        lines.push(`ng ${cmd.ref} ${reason}\n`);
      }
      reportLines.push({ ref: cmd.ref, ok, reason });
    }
  } else {
    for (const cmd of commands) {
      lines.push(`ng ${cmd.ref} unpack failed\n`);
      reportLines.push({ ref: cmd.ref, ok: false, reason: 'unpack failed' });
    }
  }
  void reportLines;
  lines.push('flush');
  return { status: 200, contentType: CT, body: sidebandReport(pktLines(lines)) };
}

function sidebandReport(report: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let off = 0; off < report.length; off += 65515) {
    const chunk = report.subarray(off, Math.min(report.length, off + 65515));
    parts.push(pkt(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(FLUSH);
  // Response-end marker for stateless RPC (real git's send-pack expects it;
  // the suite's receive-pack consumer ignores non-data packets).
  parts.push(Buffer.from('0002', 'ascii'));
  return Buffer.concat(parts);
}

