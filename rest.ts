// REST v3 API under /api/v3: repositories, branches, commits, contents,
// issues, comments, labels and pull requests, over the shared store.

import {
  gid,
  isOid,
  parseCommit,
  parseTree,
  sha1Obj,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

export interface RestResult {
  status: number;
  headers?: Record<string, string>;
  body: string | null;
}

function json(status: number, value: unknown, headers: Record<string, string> = {}): RestResult {
  return { status, headers, body: JSON.stringify(value) };
}

function err(status: number, message: string): RestResult {
  return json(status, { message });
}

function notFound(what = 'Not Found'): RestResult {
  return err(404, what);
}

export function userJson(store: Store): Record<string, unknown> {
  return {
    login: store.login,
    id: 1000,
    node_id: gid('user', store.login),
    type: 'User',
    site_admin: false,
    html_url: `https://github.example/${store.login}`,
    url: `/api/v3/users/${store.login}`,
  };
}

export function repoJson(store: Store, r: Repo): Record<string, unknown> {
  return {
    id: r.id,
    node_id: r.gid,
    name: r.name,
    full_name: `${r.owner}/${r.name}`,
    owner: { login: r.owner, id: 1000, node_id: gid('user', r.owner), type: 'User' },
    private: r.isPrivate,
    description: r.description,
    default_branch: r.defaultBranch,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    fork: false,
    archived: false,
    disabled: false,
    visibility: r.isPrivate ? 'private' : 'public',
    html_url: `https://github.example/${r.owner}/${r.name}`,
    url: `/api/v3/repos/${r.owner}/${r.name}`,
    created_at: store.isoFromSeq(r.seq),
    updated_at: store.isoFromSeq(r.seq),
    pushed_at: store.isoFromSeq(r.seq),
  };
}

function labelJson(l: { name: string; color: string }): Record<string, unknown> {
  return { id: 0, node_id: gid('label', l.name), name: l.name, color: l.color, default: false, description: '' };
}

export function issueJson(store: Store, r: Repo, iss: Issue): string {
  if (iss.jsonCache) return iss.jsonCache;
  const text = JSON.stringify({
    id: iss.id,
    node_id: iss.gid,
    number: iss.number,
    title: iss.title,
    body: iss.body,
    state: iss.state,
    labels: iss.labels.map((name) => {
      const l = r.labels.get(name);
      return { name, color: l ? l.color : 'ededed' };
    }),
    user: { login: store.login, id: 1000, type: 'User' },
    assignees: [],
    locked: false,
    comments: iss.comments.length,
    html_url: `https://github.example/${r.owner}/${r.name}/issues/${iss.number}`,
    url: `/api/v3/repos/${r.owner}/${r.name}/issues/${iss.number}`,
    repository_url: `/api/v3/repos/${r.owner}/${r.name}`,
    created_at: store.isoFromSeq(iss.seq),
    updated_at: store.isoFromSeq(iss.seq),
    closed_at: iss.state === 'closed' ? store.isoFromSeq(iss.seq) : null,
  });
  iss.jsonCache = text;
  return text;
}

function issueObj(store: Store, r: Repo, iss: Issue): Record<string, unknown> {
  return JSON.parse(issueJson(store, r, iss)) as Record<string, unknown>;
}

export function pullJson(store: Store, r: Repo, pr: Pull): Record<string, unknown> {
  return {
    id: pr.id,
    node_id: pr.gid,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    locked: false,
    head: {
      ref: pr.head,
      sha: pr.headSha,
      label: `${r.owner}:${pr.head}`,
      user: { login: store.login, id: 1000, type: 'User' },
      repo: repoJson(store, r),
    },
    base: {
      ref: pr.base,
      sha: pr.baseSha,
      label: `${r.owner}:${pr.base}`,
      user: { login: store.login, id: 1000, type: 'User' },
      repo: repoJson(store, r),
    },
    merged: pr.merged,
    mergeable: true,
    merge_commit_sha: pr.mergeSha,
    merged_at: pr.mergedAt,
    closed_at: pr.state === 'closed' ? pr.mergedAt : null,
    html_url: `https://github.example/${r.owner}/${r.name}/pull/${pr.number}`,
    url: `/api/v3/repos/${r.owner}/${r.name}/pulls/${pr.number}`,
    created_at: store.isoFromSeq(pr.seq),
    updated_at: store.isoFromSeq(pr.seq),
    user: { login: store.login, id: 1000, type: 'User' },
  };
}

interface Ctx {
  store: Store;
  method: string;
  seg: string[];
  query: URLSearchParams;
  body: Record<string, unknown> | null;
  malformed: boolean;
  host: string;
  base: string;
}

function paginate<T>(items: readonly T[], query: URLSearchParams, url: string): { page: T[]; link: string | null } {
  const perPage = Math.max(1, Math.min(100, parseInt(query.get('per_page') ?? '30', 10) || 30));
  const pageNum = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  const start = (pageNum - 1) * perPage;
  const page = items.slice(start, start + perPage);
  let link: string | null = null;
  const totalPages = Math.ceil(items.length / perPage);
  if (pageNum < totalPages) {
    const next = new URL(url);
    next.searchParams.set('page', String(pageNum + 1));
    next.searchParams.set('per_page', String(perPage));
    const last = new URL(url);
    last.searchParams.set('page', String(totalPages));
    last.searchParams.set('per_page', String(perPage));
    link = `<${next.toString()}>; rel="next", <${last.toString()}>; rel="last"`;
  }
  return { page, link };
}

function needBody(ctx: Ctx): Record<string, unknown> | null {
  if (ctx.malformed) return null;
  return ctx.body ?? {};
}

/** Resolve a repo under the token owner's login; null when absent or foreign. */
function resolveRepo(ctx: Ctx, owner: string, name: string): Repo | null {
  if (owner !== ctx.store.login) return null;
  return ctx.store.getRepo(owner, name) ?? null;
}

function branchTip(r: Repo, branch: string): string | undefined {
  return r.refs.get(`refs/heads/${branch}`);
}

function parseAuthorIdent(raw: string): { name: string; email: string; date: string } {
  const m = /^(.*?) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(raw);
  if (!m) return { name: raw, email: '', date: '' };
  return { name: m[1]!, email: m[2]!, date: new Date(parseInt(m[3]!, 10) * 1000).toISOString() };
}

function commitJson(store: Store, r: Repo, oid: string): Record<string, unknown> {
  const obj = r.objects.get(oid)!;
  const c = parseCommit(obj.data);
  const author = parseAuthorIdent(c.author);
  const committer = parseAuthorIdent(c.committer);
  return {
    sha: oid,
    node_id: gid('commit', oid),
    commit: {
      message: c.message.replace(/\n+$/, ''),
      author,
      committer,
      tree: { sha: c.tree },
    },
    author: { login: store.login, id: 1000, type: 'User' },
    committer: { login: store.login, id: 1000, type: 'User' },
    parents: c.parents.map((p) => ({ sha: p })),
    url: `/api/v3/repos/${r.owner}/${r.name}/commits/${oid}`,
    html_url: `https://github.example/${r.owner}/${r.name}/commit/${oid}`,
  };
}

/** Navigate a tree by path segments; returns the object and its type. */
function treeLookup(r: Repo, commitOid: string, path: string): { oid: string; type: string; size: number } | null {
  const commit = r.objects.get(commitOid);
  if (!commit || commit.type !== 'commit') return null;
  let curOid = parseCommit(commit.data).tree;
  let curType = 'tree';
  const segs = path.split('/').filter((s) => s !== '');
  for (const seg of segs) {
    const obj = r.objects.get(curOid);
    if (!obj || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((e) => e.name === seg);
    if (!entry) return null;
    curOid = entry.oid;
    curType = entry.mode === '40000' ? 'tree' : 'blob';
  }
  let size = 0;
  if (curType === 'blob') {
    const blob = r.objects.get(curOid);
    size = blob ? blob.data.length : 0;
  }
  return { oid: curOid, type: curType, size };
}

export async function handleRest(ctx: Ctx): Promise<RestResult> {
  const { store, method, seg } = ctx;
  const scopes = { 'x-oauth-scopes': 'repo, read:org' };

  // GET /api/v3/
  if (seg.length === 0) {
    if (method !== 'GET') return err(404, 'Not Found');
    return json(200, {
      current_user_url: '/api/v3/user',
      current_user_authorizations_html_url: '/api/v3/authorizations',
      authorizations_url: '/api/v3/authorizations',
      code_search_url: '/api/v3/search/code?q={query}',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      user_url: '/api/v3/users/{user}',
      rate_limit_url: '/api/v3/rate_limit',
    }, scopes);
  }

  if (seg[0] === 'meta' && seg.length === 1) {
    if (method !== 'GET') return err(404, 'Not Found');
    return json(200, { installed_version: '1.0.0', verifiable_password_authentication: true }, scopes);
  }

  if (seg[0] === 'user' && seg.length === 1) {
    if (method !== 'GET') return err(404, 'Not Found');
    return json(200, userJson(store), scopes);
  }

  if (seg[0] === 'user' && seg[1] === 'repos') {
    if (method === 'GET') {
      const repos = store.listRepos();
      const { page, link } = paginate(repos, ctx.query, `${ctx.base}/api/v3/user/repos`);
      const headers: Record<string, string> = { ...scopes };
      if (link) headers.link = link;
      return json(200, page.map((r) => repoJson(store, r)), headers);
    }
    if (method === 'POST') {
      if (ctx.malformed) return err(400, 'Malformed JSON body');
      const b = needBody(ctx)!;
      const name = typeof b.name === 'string' ? b.name : '';
      if (name === '') return err(422, 'Repository name is required');
      if (store.getRepo(store.login, name)) return err(422, 'Repository already exists');
      const repo = store.createRepo(name, b.private === true, typeof b.description === 'string' ? b.description : '');
      return json(201, repoJson(store, repo), scopes);
    }
    return err(404, 'Not Found');
  }

  if (seg[0] !== 'repos' || seg.length < 3) return err(404, 'Not Found');
  const owner = decodeURIComponent(seg[1]!);
  const repoName = decodeURIComponent(seg[2]!);
  const repo = resolveRepo(ctx, owner, repoName);
  const rest = seg.slice(3);

  // /repos/{o}/{r}
  if (rest.length === 0) {
    if (method === 'GET') {
      if (!repo) return notFound('Not Found');
      return json(200, repoJson(store, repo), scopes);
    }
    if (method === 'PATCH') {
      if (!repo) return notFound('Not Found');
      if (ctx.malformed) return err(400, 'Malformed JSON body');
      const b = needBody(ctx)!;
      if (typeof b.description === 'string') repo.description = b.description;
      if (typeof b.default_branch === 'string' && repo.refs.has(`refs/heads/${b.default_branch}`)) repo.defaultBranch = b.default_branch;
      return json(200, repoJson(store, repo), scopes);
    }
    if (method === 'DELETE') {
      if (!repo) return notFound('Not Found');
      store.deleteRepo(repo);
      return { status: 204, headers: scopes, body: null };
    }
    return err(404, 'Not Found');
  }

  if (!repo) return notFound('Not Found');

  // branches
  if (rest[0] === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const list = [...repo.refs.keys()]
        .filter((n) => n.startsWith('refs/heads/'))
        .sort()
        .map((n) => ({ name: n.slice('refs/heads/'.length), commit: { sha: repo.refs.get(n)! }, protected: false }));
      return json(200, list, scopes);
    }
    if (rest.length === 2 && method === 'GET') {
      const tip = branchTip(repo, decodeURIComponent(rest[1]!));
      if (!tip) return notFound('Branch not found');
      return json(200, { name: decodeURIComponent(rest[1]!), commit: { sha: tip }, protected: false }, scopes);
    }
    return err(404, 'Not Found');
  }

  // commits
  if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
    const shaParam = ctx.query.get('sha');
    let tip: string | undefined;
    if (shaParam) {
      tip = repo.refs.get(`refs/heads/${shaParam}`) ?? (isOid(shaParam) ? shaParam : undefined);
    } else {
      tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    }
    if (!tip) return json(200, [], scopes);
    const out: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    const queue = [tip];
    const perPage = Math.max(1, Math.min(100, parseInt(ctx.query.get('per_page') ?? '30', 10) || 30));
    while (queue.length && out.length < perPage) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      out.push(commitJson(store, repo, oid));
      for (const p of parseCommit(obj.data).parents) queue.push(p);
    }
    return json(200, out, scopes);
  }

  // git refs
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      if (ctx.malformed) return err(400, 'Malformed JSON body');
      const b = needBody(ctx)!;
      const ref = typeof b.ref === 'string' ? b.ref : '';
      const sha = typeof b.sha === 'string' ? b.sha : '';
      if (!ref.startsWith('refs/') || !isOid(sha)) return err(422, 'Invalid ref or sha');
      if (repo.refs.has(ref)) return err(422, 'Reference already exists');
      if (!repo.objects.has(sha)) return err(422, 'Object does not exist');
      repo.refs.set(ref, sha);
      repo.treeCache.clear();
      return json(201, { ref, node_id: gid('ref', ref), object: { sha, type: 'commit' } }, scopes);
    }
    if (method === 'GET' && rest.length >= 4 && rest[2] === 'heads') {
      const branch = decodeURIComponent(rest[3]!);
      const tip = branchTip(repo, branch);
      if (!tip) return notFound('Not Found');
      return json(200, { ref: `refs/heads/${branch}`, node_id: gid('ref', `refs/heads/${branch}`), object: { sha: tip, type: 'commit' } }, scopes);
    }
    if (method === 'GET' && rest.length === 2) {
      const list = [...repo.refs.entries()].sort().map(([ref, sha]) => ({ ref, object: { sha, type: 'commit' } }));
      return json(200, list, scopes);
    }
    return err(404, 'Not Found');
  }

  // contents
  if (rest[0] === 'contents') {
    const filePath = rest.slice(1).map((s) => decodeURIComponent(s)).join('/');
    const refParam = ctx.query.get('ref');
    const branch = refParam && repo.refs.has(`refs/heads/${refParam}`) ? refParam : repo.defaultBranch;
    if (method === 'GET') {
      let tip = repo.refs.get(`refs/heads/${branch}`);
      if (refParam && isOid(refParam)) tip = refParam;
      if (!tip) return notFound('Not Found');
      const found = treeLookup(repo, tip, filePath);
      if (!found) return notFound('Not Found');
      if (found.type === 'tree') {
        const obj = repo.objects.get(found.oid)!;
        const entries = parseTree(obj.data).map((e) => {
          const isDir = e.mode === '40000';
          let size = 0;
          if (!isDir) {
            const blob = repo.objects.get(e.oid);
            size = blob ? blob.data.length : 0;
          }
          return {
            type: isDir ? 'dir' : 'file',
            name: e.name,
            path: filePath === '' ? e.name : `${filePath}/${e.name}`,
            sha: e.oid,
            size,
            url: `/api/v3/repos/${owner}/${repoName}/contents/${filePath === '' ? e.name : `${filePath}/${e.name}`}`,
          };
        });
        return json(200, entries, scopes);
      }
      const blob = repo.objects.get(found.oid)!;
      return json(200, {
        type: 'file',
        encoding: 'base64',
        size: found.size,
        name: filePath.split('/').pop() ?? filePath,
        path: filePath,
        content: blob.data.toString('base64'),
        sha: found.oid,
        url: `/api/v3/repos/${owner}/${repoName}/contents/${filePath}`,
        html_url: `https://github.example/${owner}/${repoName}/blob/${branch}/${filePath}`,
      }, scopes);
    }
    if (method === 'PUT') {
      if (ctx.malformed) return err(400, 'Malformed JSON body');
      const b = needBody(ctx)!;
      const contentB64 = typeof b.content === 'string' ? b.content : '';
      let content: Buffer;
      try {
        content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
      } catch {
        return err(400, 'Invalid base64 content');
      }
      const reqBranch = typeof b.branch === 'string' && b.branch !== '' ? b.branch : repo.defaultBranch;
      let files: Map<string, Buffer>;
      let isNewBranch = false;
      const existing = store.filesAtRef(repo, reqBranch);
      if (existing) {
        files = new Map(existing);
      } else if (repo.refs.size === 0) {
        files = new Map();
        isNewBranch = true;
      } else {
        const baseFiles = store.filesAtRef(repo, repo.defaultBranch);
        files = new Map(baseFiles ?? new Map());
        isNewBranch = true;
      }
      void isNewBranch;
      const existed = files.has(filePath);
      if (existed) {
        const curSha = sha1Obj('blob', files.get(filePath)!);
        if (typeof b.sha !== 'string') return err(409, 'sha is required to update a file');
        if (b.sha.toLowerCase() !== curSha.toLowerCase()) return err(409, 'sha does not match the current file');
      }
      files.set(filePath, content);
      const message = typeof b.message === 'string' && b.message !== '' ? b.message : `Update ${filePath}`;
      const commitSha = store.commitFiles(repo, reqBranch, files, message);
      const blobSha = sha1Obj('blob', content);
      return json(existed ? 200 : 201, {
        content: {
          name: filePath.split('/').pop() ?? filePath,
          path: filePath,
          sha: blobSha,
          size: content.length,
          type: 'file',
          encoding: 'base64',
          content: content.toString('base64'),
          url: `/api/v3/repos/${owner}/${repoName}/contents/${filePath}`,
        },
        commit: { sha: commitSha, message },
      }, scopes);
    }
    if (method === 'DELETE') {
      if (ctx.malformed) return err(400, 'Malformed JSON body');
      const b = needBody(ctx)!;
      const reqBranch = typeof b.branch === 'string' && b.branch !== '' ? b.branch : repo.defaultBranch;
      const existing = store.filesAtRef(repo, reqBranch);
      if (!existing || !existing.has(filePath)) return notFound('Not Found');
      const files = new Map(existing);
      files.delete(filePath);
      const message = typeof b.message === 'string' && b.message !== '' ? b.message : `Delete ${filePath}`;
      const commitSha = store.commitFiles(repo, reqBranch, files, message);
      return json(200, { commit: { sha: commitSha, message } }, scopes);
    }
    return err(404, 'Not Found');
  }

  // labels
  if (rest[0] === 'labels') {
    if (method === 'POST') {
      if (ctx.malformed) return err(400, 'Malformed JSON body');
      const b = needBody(ctx)!;
      const name = typeof b.name === 'string' ? b.name : '';
      if (name === '') return err(422, 'Label name is required');
      const color = typeof b.color === 'string' ? b.color : 'ededed';
      if (!repo.labels.has(name)) repo.labels.set(name, { name, color });
      return json(201, labelJson(repo.labels.get(name)!), scopes);
    }
    if (method === 'GET') {
      return json(200, [...repo.labels.values()].map(labelJson), scopes);
    }
    return err(404, 'Not Found');
  }

  // issues
  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'GET') {
        let list = [...repo.issues];
        const state = ctx.query.get('state') ?? 'open';
        if (state === 'open') list = list.filter((i) => i.state === 'open');
        else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
        const sort = ctx.query.get('sort') ?? 'created';
        const dir = ctx.query.get('direction') ?? 'desc';
        if (sort === 'created') {
          list.sort((a, b) => (dir === 'asc' ? a.number - b.number : b.number - a.number));
        }
        const { page, link } = paginate(list, ctx.query, `${ctx.base}/api/v3/repos/${owner}/${repoName}/issues`);
        const headers: Record<string, string> = { ...scopes };
        if (link) headers.link = link;
        return { status: 200, headers, body: `[${page.map((i) => issueJson(store, repo, i)).join(',')}]` };
      }
      if (method === 'POST') {
        if (ctx.malformed) return err(400, 'Malformed JSON body');
        const b = needBody(ctx)!;
        const title = typeof b.title === 'string' ? b.title : '';
        if (title === '') return err(422, 'Title is required');
        const rawLabels = Array.isArray(b.labels) ? b.labels : [];
        const labels: string[] = [];
        for (const l of rawLabels) {
          const name = typeof l === 'string' ? l : typeof l === 'object' && l !== null ? (l as Record<string, unknown>).name : undefined;
          if (typeof name !== 'string') continue;
          if (!repo.labels.has(name)) return err(422, `Label '${name}' does not exist`);
          labels.push(name);
        }
        const number = repo.nextIssue++;
        const id = store.issueIdSeq++;
        const iss: Issue = {
          number,
          id,
          gid: gid('issue', `${repo.id}:${number}`),
          title,
          body: typeof b.body === 'string' ? b.body : '',
          state: 'open',
          labels,
          comments: [],
          seq: store.timeSeq++,
          jsonCache: '',
        };
        repo.issues.push(iss);
        return { status: 201, headers: scopes, body: issueJson(store, repo, iss) };
      }
      return err(404, 'Not Found');
    }
    const num = parseInt(rest[1]!, 10);
    const iss = repo.issues.find((i) => i.number === num);
    if (rest.length === 2) {
      if (method === 'GET') {
        if (!iss) return notFound('Not Found');
        return { status: 200, headers: scopes, body: issueJson(store, repo, iss) };
      }
      if (method === 'PATCH') {
        if (!iss) return notFound('Not Found');
        if (ctx.malformed) return err(400, 'Malformed JSON body');
        const b = needBody(ctx)!;
        if (typeof b.title === 'string') iss.title = b.title;
        if (typeof b.body === 'string') iss.body = b.body;
        if (b.state === 'open' || b.state === 'closed') iss.state = b.state;
        if (Array.isArray(b.labels)) {
          const labels: string[] = [];
          for (const l of b.labels) {
            const name = typeof l === 'string' ? l : typeof l === 'object' && l !== null ? (l as Record<string, unknown>).name : undefined;
            if (typeof name !== 'string') continue;
            if (!repo.labels.has(name)) return err(422, `Label '${name}' does not exist`);
            labels.push(name);
          }
          iss.labels = labels;
        }
        iss.jsonCache = '';
        return { status: 200, headers: scopes, body: issueJson(store, repo, iss) };
      }
      return err(404, 'Not Found');
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (!iss) return notFound('Not Found');
      if (method === 'GET') {
        return json(200, iss.comments.map((c) => ({
          id: c.id,
          node_id: c.gid,
          body: c.body,
          user: { login: store.login, id: 1000, type: 'User' },
          created_at: store.isoFromSeq(iss.seq),
          updated_at: store.isoFromSeq(iss.seq),
        })), scopes);
      }
      if (method === 'POST') {
        if (ctx.malformed) return err(400, 'Malformed JSON body');
        const b = needBody(ctx)!;
        const bodyText = typeof b.body === 'string' ? b.body : '';
        const id = store.commentSeq++;
        const comment = { id, gid: gid('comment', `${repo.id}:${iss.number}:${id}`), body: bodyText };
        iss.comments.push(comment);
        iss.jsonCache = '';
        return json(201, {
          id,
          node_id: comment.gid,
          body: bodyText,
          user: { login: store.login, id: 1000, type: 'User' },
          created_at: store.isoFromSeq(iss.seq),
          updated_at: store.isoFromSeq(iss.seq),
        }, scopes);
      }
      return err(404, 'Not Found');
    }
    return err(404, 'Not Found');
  }

  // pulls
  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (method === 'GET') {
        let list = [...repo.pulls];
        const state = ctx.query.get('state') ?? 'open';
        if (state === 'open') list = list.filter((p) => p.state === 'open');
        else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
        list.sort((a, b) => b.number - a.number);
        const { page, link } = paginate(list, ctx.query, `${ctx.base}/api/v3/repos/${owner}/${repoName}/pulls`);
        const headers: Record<string, string> = { ...scopes };
        if (link) headers.link = link;
        return json(200, page.map((p) => pullJson(store, repo, p)), headers);
      }
      if (method === 'POST') {
        if (ctx.malformed) return err(400, 'Malformed JSON body');
        const b = needBody(ctx)!;
        const title = typeof b.title === 'string' ? b.title : '';
        const head = typeof b.head === 'string' ? b.head : '';
        const base = typeof b.base === 'string' && b.base !== '' ? b.base : repo.defaultBranch;
        if (title === '' || head === '') return err(422, 'Title and head are required');
        const headSha = branchTip(repo, head);
        const baseSha = branchTip(repo, base);
        if (!headSha) return err(422, 'Head branch not found');
        if (!baseSha) return err(422, 'Base branch not found');
        const existing = repo.pulls.find((p) => p.head === head && p.state === 'open');
        if (existing) return err(422, 'A pull request already exists for this head branch');
        const number = repo.nextPull++;
        const id = store.pullIdSeq++;
        const baseFiles = store.filesAtCommit(repo, baseSha);
        const headFiles = store.filesAtCommit(repo, headSha);
        const pr: Pull = {
          number,
          id,
          gid: gid('pull', `${repo.id}:${number}`),
          title,
          body: typeof b.body === 'string' ? b.body : '',
          state: 'open',
          merged: false,
          mergedAt: null,
          mergeSha: null,
          head,
          base,
          headSha,
          baseSha,
          files: store.diffFiles(baseFiles, headFiles),
          seq: store.timeSeq++,
        };
        repo.pulls.push(pr);
        return json(201, pullJson(store, repo, pr), scopes);
      }
      return err(404, 'Not Found');
    }
    const num = parseInt(rest[1]!, 10);
    const pr = repo.pulls.find((p) => p.number === num);
    if (rest.length === 2 && method === 'GET') {
      if (!pr) return notFound('Not Found');
      return json(200, pullJson(store, repo, pr), scopes);
    }
    if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
      if (!pr) return notFound('Not Found');
      return json(200, pr.files, scopes);
    }
    if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
      if (!pr) return notFound('Not Found');
      if (ctx.malformed) return err(400, 'Malformed JSON body');
      if (pr.merged && pr.mergeSha) {
        return json(200, { sha: pr.mergeSha, merged: true, message: 'Pull request successfully merged' }, scopes);
      }
      if (pr.state === 'closed') return err(405, 'Pull request is closed');
      if (store.prConflicted(repo, pr)) return err(405, 'Merge conflict');
      const sha = store.mergePull(repo, pr);
      if (!sha) return err(405, 'Merge conflict');
      pr.state = 'closed';
      pr.merged = true;
      pr.mergeSha = sha;
      pr.mergedAt = store.isoFromSeq(store.timeSeq);
      return json(200, { sha, merged: true, message: 'Pull request successfully merged' }, scopes);
    }
    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}

// Re-exported for the GraphQL and MCP layers.
export function repoByGid(store: Store, gidValue: string): Repo | undefined {
  for (const r of store.repos.values()) if (r.gid === gidValue) return r;
  return undefined;
}

export function createIssueInRepo(store: Store, repo: Repo, title: string, body: string): Issue {
  const number = repo.nextIssue++;
  const id = store.issueIdSeq++;
  const iss: Issue = {
    number,
    id,
    gid: gid('issue', `${repo.id}:${number}`),
    title,
    body,
    state: 'open',
    labels: [],
    comments: [],
    seq: store.timeSeq++,
    jsonCache: '',
  };
  repo.issues.push(iss);
  return iss;
}

export function createPullInRepo(
  store: Store,
  repo: Repo,
  title: string,
  body: string,
  head: string,
  base: string,
): Pull | null {
  const headSha = branchTip(repo, head);
  const baseSha = branchTip(repo, base);
  if (!headSha || !baseSha) return null;
  const existing = repo.pulls.find((p) => p.head === head && p.state === 'open');
  if (existing) return existing;
  const number = repo.nextPull++;
  const id = store.pullIdSeq++;
  const pr: Pull = {
    number,
    id,
    gid: gid('pull', `${repo.id}:${number}`),
    title,
    body,
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeSha: null,
    head,
    base,
    headSha,
    baseSha,
    files: store.diffFiles(store.filesAtCommit(repo, baseSha), store.filesAtCommit(repo, headSha)),
    seq: store.timeSeq++,
  };
  repo.pulls.push(pr);
  return pr;
}
