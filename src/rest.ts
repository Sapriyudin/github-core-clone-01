// REST v3 (api.github.com-compatible subset): repositories, git refs,
// branches, commits, contents, labels, issues, comments, pull requests.
// Every reply is application/json with X-GitHub-Request-Id (added by app.ts).
// Errors are { message }. No token = 401 (app.ts); a repo under another
// owner is 404, never 403.
import { b64decode, b64encode, hashObject, isoOf } from './util.ts';
import { VIEWER, walkCommits, type Issue, type Pull, type Repo, type Store } from './store.ts';

export interface RestContext {
  method: string;
  /** Path segments after /api/v3, each percent-decoded. */
  segments: string[];
  query: URLSearchParams;
  /** Parsed JSON body, or null when there is none. */
  body: unknown;
  /** True when a non-empty body failed to parse as JSON. */
  bodyParseError: boolean;
  /** Absolute base URL of the entry (for Link headers). */
  baseUrl: string;
}

export interface RestResult {
  status: number;
  headers?: Record<string, string>;
  /** JSON-serializable body, or null for an empty body (204). */
  body: unknown;
}

const err = (status: number, message: string): RestResult => ({ status, body: { message } });

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repoNodeId(repo),
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: VIEWER.id, node_id: userNodeId(), avatar_url: '', type: 'User', site_admin: false },
    private: repo.privateFlag,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    html_url: `https://github.com/${repo.fullName}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `https://github.com/${repo.fullName}.git`,
    git_url: `git://github.com/${repo.fullName}.git`,
    ssh_url: `git@github.com:${repo.fullName}.git`,
    homepage: null,
    language: null,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    size: 0,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length + repo.pulls.filter((p) => p.state === 'open').length,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    archived: false,
    disabled: false,
    visibility: repo.privateFlag ? 'private' : 'public',
    license: null,
    topics: [],
    allow_forking: true,
    is_template: false,
    web_commit_signoff_required: false,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function repoNodeId(repo: Repo): string {
  return b64encode(`R:${repo.owner}/${repo.name}`);
}

function userNodeId(): string {
  return b64encode(`U:${VIEWER.login}`);
}

function issueNodeId(repo: Repo, issue: Issue): string {
  return b64encode(`I:${repo.owner}/${repo.name}#${issue.number}`);
}

function pullNodeId(repo: Repo, pull: Pull): string {
  return b64encode(`P:${repo.owner}/${repo.name}#${pull.number}`);
}

function labelJson(label: { id: number; name: string; color: string; description: string }): Record<string, unknown> {
  return { id: label.id, node_id: b64encode(`L:${label.name}`), name: label.name, color: label.color, description: label.description, default: true, url: '' };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issueNodeId(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map(labelJson),
    user: { login: issue.user.login, id: VIEWER.id, node_id: userNodeId(), type: 'User' },
    assignee: null,
    assignees: [],
    locked: false,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    author_association: 'OWNER',
    html_url: `https://github.com/${repo.fullName}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
    events_url: '',
    labels_url: '',
    milestone: null,
    pull_request: undefined,
    state_reason: null,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const headUser = { login: repo.owner, id: VIEWER.id, node_id: userNodeId(), type: 'User' };
  return {
    id: pull.id,
    node_id: pullNodeId(repo, pull),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: !pull.merged && pull.state === 'open' ? !repo.pullConflicts(pull) : null,
    mergeable_state: pull.merged ? 'merged' : pull.state === 'closed' ? 'closed' : repo.pullConflicts(pull) ? 'conflicting' : 'clean',
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}`, user: headUser, repo: repoJson(repo) },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}`, user: headUser, repo: repoJson(repo) },
    user: { login: pull.user.login, id: VIEWER.id, node_id: userNodeId(), type: 'User' },
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    labels: [],
    draft: false,
    locked: false,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    author_association: 'OWNER',
    html_url: `https://github.com/${repo.fullName}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    diff_url: '',
    patch_url: '',
    issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${pull.number}`,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
  };
}

function commentJson(repo: Repo, issue: Issue, comment: { id: number; body: string; user: { login: string }; createdAt: string }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: b64encode(`C:${repo.owner}/${repo.name}#${issue.number}#${comment.id}`),
    body: comment.body,
    user: { login: comment.user.login, id: VIEWER.id, node_id: userNodeId(), type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    html_url: `https://github.com/${repo.fullName}/issues/${issue.number}#issuecomment-${comment.id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments/${comment.id}`,
    issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    author_association: 'OWNER',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pageOf(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const perPage = Math.min(100, Math.max(1, Number(query.get('per_page') ?? '30') || 30));
  return { page, perPage };
}

/** Slice a list into a page and build GitHub's Link header (next/last). */
function paginate<T>(items: readonly T[], query: URLSearchParams, path: string, baseUrl: string): { page: T[]; headers: Record<string, string> } {
  const { page, perPage } = pageOf(query);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const pageItems = items.slice(start, start + perPage);
  const links: string[] = [];
  const urlFor = (p: number): string => {
    const q = new URLSearchParams(query);
    q.set('page', String(p));
    q.set('per_page', String(perPage));
    return `${baseUrl}${path}?${q.toString()}`;
  };
  if (page < totalPages) links.push(`<${urlFor(page + 1)}>; rel="next"`);
  if (totalPages > 1) links.push(`<${urlFor(totalPages)}>; rel="last"`);
  if (page > 1) links.push(`<${urlFor(1)}>; rel="first"`, `<${urlFor(page - 1)}>; rel="prev"`);
  return { page: pageItems, headers: links.length > 0 ? { link: links.join(', ') } : {} };
}

export function handleRest(store: Store, ctx: RestContext): RestResult {
  const { method, segments: s } = ctx;
  if (ctx.bodyParseError) return err(400, 'Problems parsing JSON');

  // GET /api/v3/ — the API root.
  if (s.length === 0) {
    if (method !== 'GET') return err(404, 'Not Found');
    return {
      status: 200,
      headers: { 'x-oauth-scopes': 'repo, read:org' },
      body: {
        current_user_url: '/api/v3/user',
        current_user_authorizations_html_url: 'https://github.com/settings/applications',
        authorizations_url: '/api/v3/authorizations',
        code_search_url: '/api/v3/search/code?q={query}',
        commit_search_url: '/api/v3/search/commits?q={query}',
        emails_url: '/api/v3/user/emails',
        emojis_url: '/api/v3/emojis',
        events_url: '/api/v3/events',
        feeds_url: '/api/v3/feeds',
        followers_url: '/api/v3/user/followers',
        following_url: '/api/v3/user/following{/target}',
        gists_url: '/api/v3/gists{/gist_id}',
        hub_url: 'https://api.github.com/hub',
        issue_search_url: '/api/v3/search/issues?q={query}',
        issues_url: '/api/v3/issues',
        keys_url: '/api/v3/user/keys',
        label_search_url: '/api/v3/search/labels?q={query}',
        notifications_url: '/api/v3/notifications',
        organization_url: '/api/v3/orgs/{org}',
        organization_repositories_url: '/api/v3/orgs/{org}/repos',
        organization_teams_url: '/api/v3/orgs/{org}/teams',
        public_gists_url: '/api/v3/gists/public',
        rate_limit_url: '/api/v3/rate_limit',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        repository_search_url: '/api/v3/search/repositories?q={query}',
        current_user_repositories_url: '/api/v3/user/repos',
        starred_url: '/api/v3/user/starred{/owner}{/repo}',
        starred_gists_url: '/api/v3/gists/starred',
        topic_search_url: '/api/v3/search/topics?q={query}',
        user_url: '/api/v3/users/{user}',
        user_organizations_url: '/api/v3/user/orgs',
        user_repositories_url: '/api/v3/user/repos{?type,page,per_page,sort}',
        user_search_url: '/api/v3/search/users?q={query}',
      },
    };
  }

  // GET /api/v3/meta
  if (s[0] === 'meta') {
    if (method !== 'GET') return err(404, 'Not Found');
    return { status: 200, body: { installed_version: '1.0.0', verifiable_password_authentication: true, api_version: 'v3' } };
  }

  // GET /api/v3/user
  if (s[0] === 'user' && s.length === 1) {
    if (method !== 'GET') return err(404, 'Not Found');
    return {
      status: 200,
      body: {
        login: VIEWER.login,
        id: VIEWER.id,
        node_id: userNodeId(),
        avatar_url: '',
        gravatar_id: '',
        url: '/api/v3/users/adaiversen',
        html_url: `https://github.com/${VIEWER.login}`,
        followers_url: '',
        following_url: '',
        gists_url: '',
        starred_url: '',
        subscriptions_url: '',
        organizations_url: '',
        repos_url: '/api/v3/user/repos',
        events_url: '',
        received_events_url: '',
        type: 'User',
        site_admin: false,
        name: VIEWER.name,
        company: null,
        blog: '',
        location: null,
        email: VIEWER.email,
        hireable: null,
        bio: null,
        twitter_username: null,
        public_repos: store.viewerRepos().length,
        public_gists: 0,
        followers: 0,
        following: 0,
        created_at: '2025-01-01T00:00:00Z',
        updated_at: '2025-01-01T00:00:00Z',
      },
    };
  }

  // POST /api/v3/user/repos, GET /api/v3/user/repos
  if (s[0] === 'user' && s[1] === 'repos') {
    if (s.length !== 2) return err(404, 'Not Found');
    if (method === 'POST') {
      if (!isRecord(ctx.body) || typeof ctx.body.name !== 'string' || ctx.body.name === '') return err(422, 'name is required');
      const name = ctx.body.name as string;
      if (!/^[A-Za-z0-9._-]+$/.test(name)) return err(422, 'name is invalid');
      const created = store.createRepo(name, typeof ctx.body.description === 'string' ? ctx.body.description : '', ctx.body.private === true);
      if (created === 'exists') return err(422, `Repository ${VIEWER.login}/${name} already exists`);
      return { status: 201, body: repoJson(created) };
    }
    if (method === 'GET') {
      const repos = store.viewerRepos();
      const { page, headers } = paginate(repos, ctx.query, '/api/v3/user/repos', ctx.baseUrl);
      return { status: 200, headers, body: page.map(repoJson) };
    }
    return err(404, 'Not Found');
  }

  // /api/v3/repos/{owner}/{repo}/...
  if (s[0] === 'repos') {
    const owner = s[1] ?? '';
    const name = s[2] ?? '';
    if (!owner || !name) return err(404, 'Not Found');
    const repo = owner === VIEWER.login ? store.getRepo(owner, name) : undefined;
    if (!repo) return err(404, 'Not Found');
    const rest = s.slice(3);
    return handleRepo(store, repo, rest, ctx);
  }

  return err(404, 'Not Found');
}

function handleRepo(store: Store, repo: Repo, rest: string[], ctx: RestContext): RestResult {
  const { method } = ctx;

  // GET/PATCH/DELETE /repos/{o}/{r}
  if (rest.length === 0) {
    if (method === 'GET') return { status: 200, body: repoJson(repo) };
    if (method === 'PATCH') {
      if (isRecord(ctx.body)) {
        if (typeof ctx.body.description === 'string') repo.description = ctx.body.description;
        if (typeof ctx.body.private === 'boolean') repo.privateFlag = ctx.body.private;
      }
      repo.updatedAt = new Date().toISOString();
      return { status: 200, body: repoJson(repo) };
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo.owner, repo.name);
      return { status: 204, body: null };
    }
    return err(404, 'Not Found');
  }

  const head = rest[0] as string;

  // ---- git refs ------------------------------------------------------------
  if (head === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      if (!isRecord(ctx.body) || typeof ctx.body.ref !== 'string' || typeof ctx.body.sha !== 'string') {
        return err(422, 'ref and sha are required');
      }
      const ref = ctx.body.ref as string;
      const sha = (ctx.body.sha as string).toLowerCase();
      if (!ref.startsWith('refs/')) return err(422, 'ref must start with refs/');
      if (!/^[0-9a-f]{40}$/.test(sha)) return err(422, 'sha is not a valid object id');
      if (!repo.getObject(sha)) return err(422, 'sha does not exist in this repository');
      if (repo.refs.has(ref)) return err(422, 'ref already exists');
      repo.refs.set(ref, sha);
      repo.packCache.clear();
      return { status: 201, body: { ref, object: { sha, type: repo.getObject(sha)?.type ?? 'commit', url: '' }, url: '' } };
    }
    if (method === 'GET' && rest.length >= 3) {
      const ref = `refs/${rest.slice(2).join('/')}`;
      const oid = repo.refs.get(ref);
      if (oid === undefined) return err(404, 'Not Found');
      return { status: 200, body: { ref, object: { sha: oid, type: repo.getObject(oid)?.type ?? 'commit', url: '' }, url: '' } };
    }
    return err(404, 'Not Found');
  }

  // ---- branches ------------------------------------------------------------
  if (head === 'branches') {
    if (method === 'GET' && rest.length === 1) {
      const branches = [...repo.refs.keys()]
        .filter((r) => r.startsWith('refs/heads/'))
        .map((r) => r.slice('refs/heads/'.length))
        .sort()
        .map((name) => ({ name, commit: { sha: repo.refs.get(`refs/heads/${name}`) as string, url: '' }, protected: false }));
      return { status: 200, body: branches };
    }
    if (method === 'GET' && rest.length >= 2) {
      const branch = rest.slice(1).join('/');
      const tip = repo.branchTip(branch);
      if (tip === undefined) return err(404, 'Not Found');
      return { status: 200, body: { name: branch, commit: { sha: tip, url: '' }, protected: false } };
    }
    return err(404, 'Not Found');
  }

  // ---- commits -------------------------------------------------------------
  if (head === 'commits') {
    if (method === 'GET' && rest.length === 1) {
      const ref = ctx.query.get('sha') ?? repo.defaultBranch;
      const tip = repo.resolveRef(ref);
      if (tip === undefined) return { status: 200, body: [] };
      const commits = walkCommits(repo, tip).map((c) => {
        const parseIdent = (ident: string): { name: string; email: string; date: string } => {
          const match = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(ident);
          if (!match) return { name: ident, email: '', date: '' };
          return { name: match[1] as string, email: match[2] as string, date: isoOf(Number(match[3])) };
        };
        return {
          sha: c.sha,
          node_id: b64encode(`C:${repo.owner}/${repo.name}#${c.sha}`),
          commit: { message: c.message, author: parseIdent(c.author), committer: parseIdent(c.committer), tree: { sha: repo.commitTree(c.sha) ?? '' }, url: '' },
          author: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
          committer: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
          parents: repo.commitParents(c.sha).map((sha) => ({ sha, url: '' })),
          url: '',
          html_url: '',
        };
      });
      return { status: 200, body: commits };
    }
    return err(404, 'Not Found');
  }

  // ---- contents ------------------------------------------------------------
  if (head === 'contents') {
    const path = rest.slice(1).join('/');
    const refParam = ctx.query.get('ref') ?? repo.defaultBranch;
    if (method === 'GET') {
      const tip = repo.resolveRef(refParam);
      if (tip === undefined) return err(404, 'Not Found');
      const file = repo.fileAt(tip, path);
      if (file !== null) {
        const sha = hashObject('blob', file);
        const name = path.split('/').pop() as string;
        const content = b64encode(file);
        const wrapped = content.replace(/(.{60})/g, '$1\n');
        return {
          status: 200,
          body: {
            type: 'file',
            encoding: 'base64',
            size: file.length,
            name,
            path,
            content: wrapped,
            sha,
            url: '',
            html_url: '',
            git_url: '',
            download_url: '',
            _links: { self: '', git: '', html: '' },
          },
        };
      }
      const dir = repo.directoryAt(tip, path);
      if (dir === null) return err(404, 'Not Found');
      return {
        status: 200,
        body: dir.map((entry) => ({
          type: entry.type,
          size: entry.type === 'file' ? (repo.getObject(entry.sha)?.data.length ?? 0) : 0,
          name: entry.name,
          path: entry.path,
          sha: entry.sha,
          url: '',
          html_url: '',
          git_url: '',
          download_url: entry.type === 'file' ? '' : null,
          _links: { self: '', git: '', html: '' },
        })),
      };
    }
    if (method === 'PUT') {
      if (!isRecord(ctx.body) || typeof ctx.body.message !== 'string' || typeof ctx.body.content !== 'string') {
        return err(422, 'message and content are required');
      }
      const branch = typeof ctx.body.branch === 'string' && ctx.body.branch !== '' ? (ctx.body.branch as string) : repo.defaultBranch;
      const content = b64decode(ctx.body.content as string);
      const sha = typeof ctx.body.sha === 'string' ? (ctx.body.sha as string).toLowerCase() : undefined;
      const tip = repo.branchTip(branch);
      const exists = tip !== undefined && repo.fileAt(tip, path) !== null;
      if (exists && sha === undefined) return err(422, 'sha was not supplied for an update');
      if (!exists && sha !== undefined) return err(422, 'sha was supplied for a file that does not exist');
      const result = repo.contentsCommit({ branch, path, content, message: ctx.body.message as string, expectedBlobSha: sha });
      if (result.error === 'stale sha') return err(409, 'the file was modified since the supplied sha');
      if (result.error === 'not found') return err(404, 'Not Found');
      const blobSha = result.blobSha as string;
      const status = exists ? 200 : 201;
      return {
        status,
        body: {
          content: { name: path.split('/').pop(), path, sha: blobSha, size: content.length, type: 'file', encoding: 'base64', url: '' },
          commit: { sha: result.commitSha, message: ctx.body.message, author: { name: VIEWER.name, email: VIEWER.email, date: new Date().toISOString() }, committer: { name: VIEWER.name, email: VIEWER.email, date: new Date().toISOString() } },
        },
      };
    }
    if (method === 'DELETE') {
      if (!isRecord(ctx.body) || typeof ctx.body.message !== 'string' || typeof ctx.body.sha !== 'string') {
        return err(422, 'message and sha are required');
      }
      const branch = typeof ctx.body.branch === 'string' && ctx.body.branch !== '' ? (ctx.body.branch as string) : repo.defaultBranch;
      const result = repo.contentsCommit({ branch, path, content: null, message: ctx.body.message as string, expectedBlobSha: (ctx.body.sha as string).toLowerCase() });
      if (result.error === 'stale sha') return err(409, 'the file was modified since the supplied sha');
      if (result.error === 'not found') return err(404, 'Not Found');
      return { status: 200, body: { commit: { sha: result.commitSha, message: ctx.body.message } } };
    }
    return err(404, 'Not Found');
  }

  // ---- labels --------------------------------------------------------------
  if (head === 'labels') {
    if (method === 'GET' && rest.length === 1) return { status: 200, body: repo.labels.map(labelJson) };
    if (method === 'POST' && rest.length === 1) {
      if (!isRecord(ctx.body) || typeof ctx.body.name !== 'string' || ctx.body.name === '') return err(422, 'name is required');
      if (repo.findLabel(ctx.body.name as string)) return err(422, 'label already exists');
      const label = {
        id: repo.nextLabelId++,
        name: ctx.body.name as string,
        color: typeof ctx.body.color === 'string' ? (ctx.body.color as string) : 'ededed',
        description: typeof ctx.body.description === 'string' ? (ctx.body.description as string) : '',
      };
      repo.labels.push(label);
      return { status: 201, body: labelJson(label) };
    }
    return err(404, 'Not Found');
  }

  // ---- issues --------------------------------------------------------------
  if (head === 'issues') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const state = ctx.query.get('state') ?? 'open';
        const sort = ctx.query.get('sort') ?? 'created';
        const direction = ctx.query.get('direction') ?? 'desc';
        let issues = [...repo.issues];
        if (state !== 'all') issues = issues.filter((i) => i.state === state);
        if (sort === 'created') {
          issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
        }
        const { page, headers } = paginate(issues, ctx.query, `/api/v3/repos/${repo.owner}/${repo.name}/issues`, ctx.baseUrl);
        return { status: 200, headers, body: page.map((i) => issueJson(repo, i)) };
      }
      if (method === 'POST') {
        if (!isRecord(ctx.body) || typeof ctx.body.title !== 'string' || ctx.body.title === '') return err(422, 'title is required');
        const labels = Array.isArray(ctx.body.labels) ? (ctx.body.labels as unknown[]).filter((l): l is string => typeof l === 'string') : [];
        const created = repo.createIssue(ctx.body.title as string, typeof ctx.body.body === 'string' ? (ctx.body.body as string) : '', labels);
        if ('error' in created) return err(422, created.error);
        return { status: 201, body: issueJson(repo, created) };
      }
      return err(404, 'Not Found');
    }
    const number = Number(rest[1]);
    if (!Number.isInteger(number) || number <= 0) return err(404, 'Not Found');
    const issue = repo.getIssue(number);
    if (!issue) return err(404, 'Not Found');
    if (rest.length === 2) {
      if (method === 'GET') return { status: 200, body: issueJson(repo, issue) };
      if (method === 'PATCH') {
        if (isRecord(ctx.body)) {
          if (typeof ctx.body.title === 'string') issue.title = ctx.body.title;
          if (typeof ctx.body.body === 'string') issue.body = ctx.body.body;
          if (ctx.body.state === 'open' || ctx.body.state === 'closed') issue.state = ctx.body.state;
        }
        issue.updatedAt = new Date().toISOString();
        return { status: 200, body: issueJson(repo, issue) };
      }
      return err(404, 'Not Found');
    }
    if (rest[2] === 'comments') {
      if (rest.length !== 3) return err(404, 'Not Found');
      if (method === 'GET') return { status: 200, body: issue.comments.map((c) => commentJson(repo, issue, c)) };
      if (method === 'POST') {
        if (!isRecord(ctx.body) || typeof ctx.body.body !== 'string' || (ctx.body.body as string) === '') return err(422, 'body is required');
        const comment = { id: repo.nextCommentId++, body: ctx.body.body as string, user: { login: VIEWER.login }, createdAt: new Date().toISOString() };
        issue.comments.push(comment);
        issue.updatedAt = comment.createdAt;
        return { status: 201, body: commentJson(repo, issue, comment) };
      }
      return err(404, 'Not Found');
    }
    return err(404, 'Not Found');
  }

  // ---- pulls ---------------------------------------------------------------
  if (head === 'pulls') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const state = ctx.query.get('state') ?? 'open';
        let pulls = [...repo.pulls];
        if (state !== 'all') pulls = pulls.filter((p) => p.state === state);
        pulls.sort((a, b) => b.number - a.number);
        const { page, headers } = paginate(pulls, ctx.query, `/api/v3/repos/${repo.owner}/${repo.name}/pulls`, ctx.baseUrl);
        return { status: 200, headers, body: page.map((p) => pullJson(repo, p)) };
      }
      if (method === 'POST') {
        if (!isRecord(ctx.body) || typeof ctx.body.title !== 'string' || (ctx.body.title as string) === '') return err(422, 'title is required');
        if (typeof ctx.body.head !== 'string' || typeof ctx.body.base !== 'string') return err(422, 'head and base are required');
        const created = repo.createPull(ctx.body.title as string, typeof ctx.body.body === 'string' ? (ctx.body.body as string) : '', ctx.body.head as string, ctx.body.base as string);
        if ('error' in created) return err(422, created.error);
        return { status: 201, body: pullJson(repo, created) };
      }
      return err(404, 'Not Found');
    }
    const number = Number(rest[1]);
    if (!Number.isInteger(number) || number <= 0) return err(404, 'Not Found');
    const pull = repo.getPull(number);
    if (!pull) return err(404, 'Not Found');
    if (rest.length === 2) {
      if (method === 'GET') return { status: 200, body: pullJson(repo, pull) };
      return err(404, 'Not Found');
    }
    if (rest[2] === 'files' && rest.length === 3) {
      if (method !== 'GET') return err(404, 'Not Found');
      const files = repo.pullFiles(pull).map((f) => ({ filename: f.path, status: f.status, additions: f.additions, deletions: f.deletions, changes: f.changes }));
      return { status: 200, body: files };
    }
    if (rest[2] === 'merge' && rest.length === 3) {
      if (method !== 'PUT') return err(404, 'Not Found');
      if (pull.merged || pull.state === 'closed') return err(405, 'Pull request is already merged or closed');
      const result = repo.squashMerge(pull);
      if (result === 'conflict') return err(405, 'Merge conflict');
      if (result === 'stale') return err(409, 'Head branch is stale');
      return { status: 200, body: { sha: result, merged: true, message: `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}` } };
    }
    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}
