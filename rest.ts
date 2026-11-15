// GitHub REST v3: repositories, branches, commits, contents, issues, comments,
// labels and pull requests, over the in-memory store. Every reply is JSON with
// an X-GitHub-Request-Id header (added by app.ts); a repository belongs to the
// login the token names, so the same name under another owner is a 404.

import {
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  parseCommit,
  parseTree,
  type Issue,
  type Label,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';

export interface RestResult {
  status: number;
  json: unknown;
  headers?: Record<string, string>;
}

export interface RestRequest {
  method: string;
  segments: string[];
  query: URLSearchParams;
  body: unknown;
  host: string;
}

function ok(status: number, json: unknown, headers?: Record<string, string>): RestResult {
  return { status, json, headers };
}

function err(status: number, message: string): RestResult {
  return { status, json: { message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bodyString(body: unknown, field: string, fallback = ''): string {
  if (!isRecord(body)) return fallback;
  const value = body[field];
  return typeof value === 'string' ? value : fallback;
}

function bodyBoolean(body: unknown, field: string, fallback: boolean): boolean {
  if (!isRecord(body)) return fallback;
  const value = body[field];
  return typeof value === 'boolean' ? value : fallback;
}

export function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

export function repoGlobalId(repo: Repo): string {
  return globalId('Repository', `${VIEWER_LOGIN}/${repo.name}`);
}

export function issueGlobalId(repo: Repo, issue: Issue): string {
  return globalId('Issue', `${VIEWER_LOGIN}/${repo.name}#${issue.number}`);
}

export function pullGlobalId(repo: Repo, pull: PullRequest): string {
  return globalId('PullRequest', `${VIEWER_LOGIN}/${repo.name}#${pull.number}`);
}

export function commentGlobalId(repo: Repo, issue: Issue, commentId: number): string {
  return globalId('IssueComment', `${VIEWER_LOGIN}/${repo.name}#${issue.number}:${commentId}`);
}

function userJson(): Record<string, unknown> {
  return { login: VIEWER_LOGIN, id: VIEWER_ID, node_id: globalId('User', VIEWER_LOGIN), type: 'User', site_admin: false, name: VIEWER_NAME, email: VIEWER_EMAIL };
}

export function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  const tip = store.defaultTip(repo);
  return {
    id: repo.id,
    node_id: repoGlobalId(repo),
    name: repo.name,
    full_name: `${VIEWER_LOGIN}/${repo.name}`,
    owner: userJson(),
    private: repo.isPrivate,
    html_url: `https://example.invalid/${VIEWER_LOGIN}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${VIEWER_LOGIN}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    git_url: `git://example.invalid/${VIEWER_LOGIN}/${repo.name}.git`,
    ssh_url: `git@example.invalid:${VIEWER_LOGIN}/${repo.name}.git`,
    clone_url: `https://example.invalid/${VIEWER_LOGIN}/${repo.name}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    headSha: tip,
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return { id: label.id, node_id: globalId('Label', label.name), url: '', name: label.name, color: label.color, description: label.description, default: false };
}

export function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: issue.labels.map(labelJson),
    user: userJson(),
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: 'OWNER',
    html_url: `https://example.invalid/${VIEWER_LOGIN}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${VIEWER_LOGIN}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${VIEWER_LOGIN}/${repo.name}`,
  };
}

function headBaseJson(store: Store, repo: Repo, ref: string): Record<string, unknown> {
  const tip = store.refTip(repo, ref);
  return {
    label: `${VIEWER_LOGIN}:${ref}`,
    ref,
    sha: tip ?? '',
    user: userJson(),
    repo: repoJson(store, repo),
  };
}

export function pullJson(store: Store, repo: Repo, pull: PullRequest): Record<string, unknown> {
  const headTip = store.refTip(repo, pull.headRef);
  const baseTip = store.refTip(repo, pull.baseRef);
  return {
    id: pull.id,
    node_id: pullGlobalId(repo, pull),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    draft: false,
    merged: pull.merged,
    mergeable: pull.state === 'open' ? store.prMergeable(repo, pull) : null,
    merge_commit_sha: pull.mergeCommitSha,
    merged_at: pull.mergedAt,
    head: { ...headBaseJson(store, repo, pull.headRef), sha: headTip ?? '' },
    base: { ...headBaseJson(store, repo, pull.baseRef), sha: baseTip ?? '' },
    user: userJson(),
    assignees: [],
    requested_reviewers: [],
    labels: [],
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    html_url: `https://example.invalid/${VIEWER_LOGIN}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${VIEWER_LOGIN}/${repo.name}/pulls/${pull.number}`,
  };
}

/** page/per_page from the query, clamped the way GitHub clamps them. */
function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '30', 10) || 30;
  const perPage = Math.min(100, Math.max(1, perPageRaw));
  return { page, perPage };
}

/** Slice `items` to one page and build the Link header for the next page, if any. */
function paginate<T>(items: readonly T[], query: URLSearchParams, req: RestRequest, path: string): { page: T[]; headers: Record<string, string> } {
  const { page, perPage } = pageParams(query);
  const start = (page - 1) * perPage;
  const sliced = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < items.length) {
    const next = new URLSearchParams(query);
    next.set('page', String(page + 1));
    next.set('per_page', String(perPage));
    headers.link = `<http://${req.host}/api/v3${path}?${next.toString()}>; rel="next"`;
  }
  return { page: [...sliced], headers };
}

/** The repository a route names, or the 404 when it is not the viewer's. */
function lookupRepo(store: Store, owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) return null;
  return store.getRepo(name) ?? null;
}

function commitMessageOf(store: Store, repo: Repo, oid: string): string {
  const object = repo.store.get(oid);
  if (object === undefined || object.type !== 'commit') return '';
  const message = parseCommit(object.data).message;
  return message.endsWith('\n') ? message.slice(0, -1) : message;
}

function commitJson(store: Store, repo: Repo, oid: string): Record<string, unknown> {
  const object = repo.store.get(oid);
  const view = object !== undefined && object.type === 'commit' ? parseCommit(object.data) : null;
  const ident = (line: string): { name: string; email: string; date: string } => {
    const match = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(line);
    if (match === null) return { name: VIEWER_NAME, email: VIEWER_EMAIL, date: store.now() };
    return { name: match[1] as string, email: match[2] as string, date: new Date(Number(match[3]) * 1000).toISOString().replace('.000Z', 'Z') };
  };
  return {
    sha: oid,
    node_id: globalId('Commit', oid),
    commit: {
      message: commitMessageOf(store, repo, oid),
      author: view === null ? { name: VIEWER_NAME, email: VIEWER_EMAIL, date: store.now() } : ident(view.author),
      committer: view === null ? { name: VIEWER_NAME, email: VIEWER_EMAIL, date: store.now() } : ident(view.committer),
      tree: { sha: view?.tree ?? '' },
    },
    author: userJson(),
    committer: userJson(),
    parents: (view?.parents ?? []).map((parent) => ({ sha: parent })),
    url: `/api/v3/repos/${VIEWER_LOGIN}/${repo.name}/commits/${oid}`,
    html_url: `https://example.invalid/${VIEWER_LOGIN}/${repo.name}/commit/${oid}`,
  };
}

/** The commits reachable from `tip`, newest first (breadth-first from the tip). */
function listCommits(store: Store, repo: Repo, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [tip];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    out.push(oid);
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return out;
}

/** Commit one contents change on `branch`, creating the branch from the default tip when needed. */
function commitContents(
  store: Store,
  repo: Repo,
  branch: string,
  path: string,
  contentBase64: string,
  message: string,
  existed: boolean,
): { status: number; commitSha: string; blobSha: string; created: boolean } | { status: number; message: string } {
  let tip = store.refTip(repo, branch);
  if (tip === null) {
    const base = branch === repo.defaultBranch ? null : store.defaultTip(repo);
    if (branch !== repo.defaultBranch && base === null && repo.refs.size > 0) return { status: 422, message: `No commit found for branch ${branch}` };
    if (base !== null) repo.refs.set(`refs/heads/${branch}`, base);
    tip = base;
  }
  let blob: Buffer;
  try {
    if (contentBase64 !== '' && !/^[A-Za-z0-9+/=\r\n]+$/.test(contentBase64)) return { status: 400, message: 'content is not valid base64' };
    blob = Buffer.from(contentBase64, 'base64');
  } catch {
    return { status: 400, message: 'content is not valid base64' };
  }
  const blobSha = repo.store.put('blob', blob);
  const baseTree = tip === null ? null : repo.store.commitTree(tip);
  const newTree = repo.store.setPath(baseTree, path, blobSha);
  const commitSha = repo.store.makeCommit(newTree, tip === null ? [] : [tip], message, store.epochSec());
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  repo.updatedAt = store.now();
  return { status: existed ? 200 : 201, commitSha, blobSha, created: !existed };
}

export function handleRest(store: Store, req: RestRequest): RestResult | null {
  const { method, segments } = req;
  const seg = segments;
  if (seg.length === 0) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(200, {
      current_user_url: '/api/v3/user',
      current_user_authorizations_html_url: 'https://example.invalid/settings/applications',
      authorizations_url: '/api/v3/authorizations',
      code_search_url: '/api/v3/search/code?q={query}',
      commit_search_url: '/api/v3/search/commits?q={query}',
      emails_url: '/api/v3/user/emails',
      emojis_url: '/api/v3/emojis',
      events_url: '/api/v3/events',
      feeds_url: '/api/v3/feeds',
      following_url: '/api/v3/user/following{/target}',
      gists_url: '/api/v3/gists{/gist_id}',
      hub_url: 'https://example.invalid/hub',
      issue_search_url: '/api/v3/search/issues?q={query}',
      issues_url: '/api/v3/issues',
      keys_url: '/api/v3/user/keys',
      label_search_url: '/api/v3/search/labels?q={query}&repository_id={repository_id}',
      notifications_url: '/api/v3/notifications',
      organization_url: '/api/v3/orgs/{org}',
      organization_repositories_url: '/api/v3/orgs/{org}/repos{?type,page,per_page,sort}',
      organization_teams_url: '/api/v3/orgs/{org}/teams',
      public_gists_url: '/api/v3/gists/public',
      rate_limit_url: '/api/v3/rate_limit',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      repository_search_url: '/api/v3/search/repositories?q={query}',
      current_user_repositories_url: '/api/v3/user/repos{?type,page,per_page,sort}',
      starred_url: '/api/v3/user/starred{/owner}{/repo}',
      starred_gists_url: '/api/v3/gists/starred',
      topic_search_url: '/api/v3/search/topics?q={query}',
      user_url: '/api/v3/users/{user}',
      user_organizations_url: '/api/v3/user/orgs',
      user_repositories_url: '/api/v3/users/{user}/repos{?type,page,per_page,sort}',
      user_search_url: '/api/v3/search/users?q={query}',
    }, { 'x-oauth-scopes': 'repo, read:org' });
  }

  if (seg[0] === 'meta') {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(200, { installed_version: '1.0.0', verifiable_password_authentication: true });
  }

  if (seg[0] === 'user') {
    if (seg.length === 1) {
      if (method !== 'GET') return err(404, 'Not Found');
      return ok(200, userJson());
    }
    if (seg[1] === 'repos') {
      if (method === 'GET') {
        const { page, headers } = paginate(store.listRepos(), req.query, req, '/user/repos');
        return ok(200, page.map((repo) => repoJson(store, repo)), headers);
      }
      if (method === 'POST') {
        const name = bodyString(req.body, 'name');
        if (name === '' || !/^[A-Za-z0-9._-]+$/.test(name)) return err(422, 'Repository name is invalid');
        if (store.getRepo(name) !== undefined) return err(422, `Repository ${VIEWER_LOGIN}/${name} already exists`);
        const repo = store.createRepo(name, bodyBoolean(req.body, 'private', false), bodyString(req.body, 'description'));
        return ok(201, repoJson(store, repo));
      }
      return err(404, 'Not Found');
    }
    return err(404, 'Not Found');
  }

  if (seg[0] === 'repos' && seg.length >= 3) {
    const owner = seg[1] as string;
    const name = seg[2] as string;
    const repo = lookupRepo(store, owner, name);
    if (repo === null) return err(404, 'Not Found');
    const rest = seg.slice(3);

    if (rest.length === 0) {
      if (method === 'GET') return ok(200, repoJson(store, repo));
      if (method === 'PATCH') {
        if (isRecord(req.body) && typeof req.body.description === 'string') repo.description = req.body.description;
        if (isRecord(req.body) && typeof req.body.private === 'boolean') repo.isPrivate = req.body.private;
        repo.updatedAt = store.now();
        return ok(200, repoJson(store, repo));
      }
      if (method === 'DELETE') {
        store.deleteRepo(name);
        return { status: 204, json: null };
      }
      return err(404, 'Not Found');
    }

    if (rest[0] === 'branches') {
      if (rest.length === 1) {
        if (method !== 'GET') return err(404, 'Not Found');
        const branches = [...repo.refs.keys()]
          .filter((ref) => ref.startsWith('refs/heads/'))
          .map((ref) => ref.slice('refs/heads/'.length))
          .sort()
          .map((branch) => ({
            name: branch,
            commit: { sha: repo.refs.get(`refs/heads/${branch}`) as string, url: `/api/v3/repos/${owner}/${name}/commits/${repo.refs.get(`refs/heads/${branch}`)}` },
            protected: false,
          }));
        return ok(200, branches);
      }
      if (rest.length === 2) {
        if (method !== 'GET') return err(404, 'Not Found');
        const branch = rest[1] as string;
        const tip = store.refTip(repo, branch);
        if (tip === null) return err(404, 'Not Found');
        return ok(200, { name: branch, commit: { sha: tip, url: `/api/v3/repos/${owner}/${name}/commits/${tip}` }, protected: false });
      }
      return err(404, 'Not Found');
    }

    if (rest[0] === 'commits') {
      if (method !== 'GET') return err(404, 'Not Found');
      if (rest.length === 2) {
        const oid = rest[1] as string;
        const object = repo.store.get(oid.toLowerCase());
        if (object === undefined || object.type !== 'commit') return err(404, 'Not Found');
        return ok(200, commitJson(store, repo, oid.toLowerCase()));
      }
      const ref = req.query.get('sha') ?? req.query.get('ref') ?? repo.defaultBranch;
      const tip = store.resolveRef(repo, ref);
      if (tip === null) return ok(200, []);
      const { page, headers } = paginate(listCommits(store, repo, tip), req.query, req, `/repos/${owner}/${name}/commits`);
      return ok(200, page.map((oid) => commitJson(store, repo, oid)), headers);
    }

    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const ref = bodyString(req.body, 'ref');
        const sha = bodyString(req.body, 'sha').toLowerCase();
        if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) return err(422, 'Invalid ref or sha');
        if (repo.refs.has(ref)) return err(422, 'Reference already exists');
        const object = repo.store.get(sha);
        if (object === undefined) return err(422, 'Object does not exist');
        repo.refs.set(ref, sha);
        return ok(201, { ref, node_id: globalId('Ref', `${owner}/${name}/${ref}`), url: `/api/v3/repos/${owner}/${name}/git/refs/${ref.slice(5)}`, object: { sha, type: object.type, url: `/api/v3/repos/${owner}/${name}/git/${object.type}s/${sha}` } });
      }
      if (method === 'GET' && rest.length >= 4) {
        const ref = `refs/${rest.slice(2).join('/')}`;
        const oid = repo.refs.get(ref);
        if (oid === undefined) return err(404, 'Not Found');
        const object = repo.store.get(oid);
        return ok(200, { ref, node_id: globalId('Ref', `${owner}/${name}/${ref}`), url: `/api/v3/repos/${owner}/${name}/git/refs/${ref.slice(5)}`, object: { sha: oid, type: object?.type ?? 'commit', url: `/api/v3/repos/${owner}/${name}/git/${object?.type ?? 'commit'}s/${oid}` } });
      }
      return err(404, 'Not Found');
    }

    if (rest[0] === 'contents') {
      const path = rest.slice(1).join('/');
      if (method === 'GET') {
        const ref = req.query.get('ref') ?? repo.defaultBranch;
        const tip = store.resolveRef(repo, ref);
        if (tip === null) return err(404, 'Not Found');
        const treeOid = repo.store.commitTree(tip);
        if (treeOid === null) return err(404, 'Not Found');
        const files = repo.store.flattenTree(treeOid);
        if (path === '') {
          const entries = listDirectory(repo, treeOid, '');
          return ok(200, entries);
        }
        const file = files.get(path);
        if (file !== undefined) {
          const data = repo.store.get(file.oid)?.data ?? Buffer.alloc(0);
          return ok(200, {
            type: 'file',
            encoding: 'base64',
            size: data.length,
            name: path.split('/').pop() ?? path,
            path,
            content: data.toString('base64'),
            sha: file.oid,
            url: `/api/v3/repos/${owner}/${name}/contents/${path}`,
            git_url: `/api/v3/repos/${owner}/${name}/git/blobs/${file.oid}`,
            html_url: `https://example.invalid/${owner}/${name}/blob/${ref}/${path}`,
            download_url: `https://example.invalid/${owner}/${name}/raw/${ref}/${path}`,
          });
        }
        const dirEntries = listDirectory(repo, treeOid, path);
        if (dirEntries === null) return err(404, 'Not Found');
        return ok(200, dirEntries);
      }
      if (method === 'PUT') {
        const message = bodyString(req.body, 'message', 'Update');
        const content = bodyString(req.body, 'content');
        const branch = bodyString(req.body, 'branch', repo.defaultBranch);
        const sha = bodyString(req.body, 'sha');
        let existed = false;
        const tip = store.resolveRef(repo, branch);
        if (tip !== null) {
          const treeOid = repo.store.commitTree(tip);
          const files = treeOid === null ? new Map() : repo.store.flattenTree(treeOid);
          const existing = files.get(path);
          if (existing !== undefined) {
            existed = true;
            if (sha === '') return err(422, 'sha is required to update a file');
            if (sha.toLowerCase() !== existing.oid) return err(409, 'The file has changed since it was last read');
          }
        }
        const result = commitContents(store, repo, branch, path, content, message, existed);
        if ('message' in result) return err(result.status, result.message);
        const data = Buffer.from(content, 'base64');
        return ok(result.created ? 201 : 200, {
          content: {
            type: 'file',
            encoding: 'base64',
            size: data.length,
            name: path.split('/').pop() ?? path,
            path,
            content,
            sha: result.blobSha,
            url: `/api/v3/repos/${owner}/${name}/contents/${path}`,
            git_url: `/api/v3/repos/${owner}/${name}/git/blobs/${result.blobSha}`,
            html_url: `https://example.invalid/${owner}/${name}/blob/${branch}/${path}`,
            download_url: `https://example.invalid/${owner}/${name}/raw/${branch}/${path}`,
          },
          commit: { sha: result.commitSha, message, url: `/api/v3/repos/${owner}/${name}/commits/${result.commitSha}` },
        });
      }
      if (method === 'DELETE') {
        const branch = bodyString(req.body, 'branch', repo.defaultBranch);
        const sha = bodyString(req.body, 'sha');
        const tip = store.resolveRef(repo, branch);
        if (tip === null) return err(404, 'Not Found');
        const treeOid = repo.store.commitTree(tip);
        const files = treeOid === null ? new Map() : repo.store.flattenTree(treeOid);
        const existing = files.get(path);
        if (existing === undefined) return err(404, 'Not Found');
        if (sha !== '' && sha.toLowerCase() !== existing.oid) return err(409, 'The file has changed since it was last read');
        const newTree = repo.store.setPath(treeOid, path, null);
        const message = bodyString(req.body, 'message', 'Delete');
        const commitSha = repo.store.makeCommit(newTree, [tip], message, store.epochSec());
        repo.refs.set(`refs/heads/${branch}`, commitSha);
        repo.updatedAt = store.now();
        return ok(200, { commit: { sha: commitSha, message, url: `/api/v3/repos/${owner}/${name}/commits/${commitSha}` } });
      }
      return err(404, 'Not Found');
    }

    if (rest[0] === 'labels') {
      if (method === 'GET') return ok(200, [...repo.labels.values()].map(labelJson));
      if (method === 'POST') {
        const labelName = bodyString(req.body, 'name');
        if (labelName === '') return err(422, 'Label name is required');
        const existing = repo.labels.get(labelName);
        if (existing !== undefined) return ok(201, labelJson(existing));
        const label = store.createLabel(repo, labelName, bodyString(req.body, 'color', 'ededed'), bodyString(req.body, 'description'));
        return ok(201, labelJson(label));
      }
      return err(404, 'Not Found');
    }

    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'GET') {
          let list = [...repo.issues];
          const state = req.query.get('state') ?? 'open';
          if (state !== 'all') list = list.filter((issue) => issue.state === state);
          const sort = req.query.get('sort') ?? 'created';
          const direction = req.query.get('direction') ?? 'desc';
          if (sort === 'created') {
            list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
          }
          const { page, headers } = paginate(list, req.query, req, `/repos/${owner}/${name}/issues`);
          return ok(200, page.map((issue) => issueJson(store, repo, issue)), headers);
        }
        if (method === 'POST') {
          const title = bodyString(req.body, 'title');
          if (title === '') return err(422, 'Title is required');
          const labelNames = isRecord(req.body) && Array.isArray(req.body.labels) ? (req.body.labels as unknown[]) : [];
          const labels: Label[] = [];
          for (const entry of labelNames) {
            const labelName = typeof entry === 'string' ? entry : isRecord(entry) ? String(entry.name ?? '') : '';
            const label = repo.labels.get(labelName);
            if (label === undefined) return err(422, `Label ${labelName} does not exist`);
            labels.push(label);
          }
          const issue = store.createIssue(repo, title, bodyString(req.body, 'body'), labels);
          return ok(201, issueJson(store, repo, issue));
        }
        return err(404, 'Not Found');
      }
      const number = Number.parseInt(rest[1] as string, 10);
      const issue = repo.issues.find((entry) => entry.number === number);
      if (issue === undefined) return err(404, 'Not Found');
      if (rest.length === 2) {
        if (method === 'GET') return ok(200, issueJson(store, repo, issue));
        if (method === 'PATCH') {
          if (isRecord(req.body) && typeof req.body.state === 'string' && (req.body.state === 'open' || req.body.state === 'closed')) {
            issue.state = req.body.state;
            issue.closedAt = req.body.state === 'closed' ? store.now() : null;
          }
          if (isRecord(req.body) && typeof req.body.title === 'string') issue.title = req.body.title;
          if (isRecord(req.body) && typeof req.body.body === 'string') issue.body = req.body.body;
          issue.updatedAt = store.now();
          return ok(200, issueJson(store, repo, issue));
        }
        return err(404, 'Not Found');
      }
      if (rest[2] === 'comments') {
        if (method === 'GET') {
          return ok(200, issue.comments.map((comment) => ({
            id: comment.id,
            node_id: commentGlobalId(repo, issue, comment.id),
            body: comment.body,
            user: userJson(),
            created_at: comment.createdAt,
            updated_at: comment.updatedAt,
            html_url: `https://example.invalid/${owner}/${name}/issues/${issue.number}#issuecomment-${comment.id}`,
            url: `/api/v3/repos/${owner}/${name}/issues/comments/${comment.id}`,
          })));
        }
        if (method === 'POST') {
          const commentBody = bodyString(req.body, 'body');
          if (commentBody === '') return err(422, 'Comment body is required');
          const comment = store.createComment(repo, issue, commentBody);
          return ok(201, {
            id: comment.id,
            node_id: commentGlobalId(repo, issue, comment.id),
            body: comment.body,
            user: userJson(),
            created_at: comment.createdAt,
            updated_at: comment.updatedAt,
            html_url: `https://example.invalid/${owner}/${name}/issues/${issue.number}#issuecomment-${comment.id}`,
            url: `/api/v3/repos/${owner}/${name}/issues/comments/${comment.id}`,
          });
        }
        return err(404, 'Not Found');
      }
      return err(404, 'Not Found');
    }

    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'GET') {
          let list = [...repo.pulls];
          const state = req.query.get('state') ?? 'open';
          if (state !== 'all') list = list.filter((pull) => pull.state === state);
          list.sort((a, b) => b.seq - a.seq);
          const { page, headers } = paginate(list, req.query, req, `/repos/${owner}/${name}/pulls`);
          return ok(200, page.map((pull) => pullJson(store, repo, pull)), headers);
        }
        if (method === 'POST') {
          const title = bodyString(req.body, 'title');
          const head = bodyString(req.body, 'head');
          const base = bodyString(req.body, 'base');
          if (title === '' || head === '' || base === '') return err(422, 'title, head and base are required');
          const headTip = store.refTip(repo, head);
          const baseTip = store.refTip(repo, base);
          if (headTip === null) return err(422, `Head branch ${head} does not exist`);
          if (baseTip === null) return err(422, `Base branch ${base} does not exist`);
          if (headTip === baseTip) return err(422, 'No commits between base and head');
          const existing = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
          if (existing !== undefined) return err(422, 'A pull request already exists for this head and base');
          const pull = store.createPull(repo, title, bodyString(req.body, 'body'), head, base);
          return ok(201, pullJson(store, repo, pull));
        }
        return err(404, 'Not Found');
      }
      const number = Number.parseInt(rest[1] as string, 10);
      const pull = repo.pulls.find((entry) => entry.number === number);
      if (pull === undefined) return err(404, 'Not Found');
      if (rest.length === 2) {
        if (method === 'GET') return ok(200, pullJson(store, repo, pull));
        return err(404, 'Not Found');
      }
      if (rest[2] === 'files') {
        if (method !== 'GET') return err(404, 'Not Found');
        const headTip = store.refTip(repo, pull.headRef);
        const baseTip = store.refTip(repo, pull.baseRef);
        const headTree = headTip === null ? null : repo.store.commitTree(headTip);
        const baseTree = baseTip === null ? null : repo.store.commitTree(baseTip);
        return ok(200, store.diffTrees(repo, baseTree, headTree));
      }
      if (rest[2] === 'merge') {
        if (method !== 'PUT') return err(404, 'Not Found');
        if (pull.state === 'closed') return err(405, pull.merged ? 'Pull request is already merged' : 'Pull request is closed');
        const headTip = store.refTip(repo, pull.headRef);
        const baseTip = store.refTip(repo, pull.baseRef);
        if (headTip === null || baseTip === null) return err(404, 'Not Found');
        const base = store.mergeBase(repo, baseTip, headTip);
        const mergedTree = store.threeWayMerge(repo, baseTip, headTip, base);
        if (mergedTree === null) return err(405, 'Merge conflict');
        const message = `Merge pull request #${pull.number} from ${pull.headRef}`;
        const mergeSha = repo.store.makeCommit(mergedTree, [baseTip], message, store.epochSec());
        repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
        pull.state = 'closed';
        pull.merged = true;
        pull.mergedAt = store.now();
        pull.mergeCommitSha = mergeSha;
        pull.updatedAt = store.now();
        repo.updatedAt = store.now();
        return ok(200, { sha: mergeSha, merged: true, message });
      }
      return err(404, 'Not Found');
    }

    return err(404, 'Not Found');
  }

  return null;
}

/** The entries of the directory `dir` inside the tree at `treeOid`; null when `dir` is not a directory. */
function listDirectory(repo: Repo, treeOid: string, dir: string): Array<Record<string, unknown>> | null {
  const files = repo.store.flattenTree(treeOid);
  const entries = new Map<string, { type: string; oid: string }>();
  const prefix = dir === '' ? '' : `${dir}/`;
  let found = false;
  for (const [path, entry] of files) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) {
      entries.set(rest, { type: 'file', oid: entry.oid });
      found = true;
    } else {
      entries.set(rest.slice(0, slash), { type: 'dir', oid: '' });
      found = true;
    }
  }
  if (!found) {
    if (dir === '') return [];
    return null;
  }
  const out: Array<Record<string, unknown>> = [];
  for (const name of [...entries.keys()].sort()) {
    const entry = entries.get(name) as { type: string; oid: string };
    if (entry.type === 'dir') {
      const subTree = dirTreeOid(repo, treeOid, dir === '' ? name : `${dir}/${name}`);
      out.push({
        type: 'dir',
        name,
        path: dir === '' ? name : `${dir}/${name}`,
        sha: subTree ?? '',
        size: 0,
        url: '',
        html_url: '',
        git_url: '',
        download_url: null,
      });
    } else {
      const data = repo.store.get(entry.oid)?.data ?? Buffer.alloc(0);
      out.push({
        type: 'file',
        name,
        path: dir === '' ? name : `${dir}/${name}`,
        sha: entry.oid,
        size: data.length,
        url: '',
        html_url: '',
        git_url: '',
        download_url: '',
      });
    }
  }
  return out;
}

function dirTreeOid(repo: Repo, treeOid: string, dir: string): string | null {
  const segments = dir.split('/');
  let current: string | null = treeOid;
  for (const segment of segments) {
    if (current === null) return null;
    const object = repo.store.get(current);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segment && candidate.mode === '40000');
    current = entry?.oid ?? null;
  }
  return current;
}
