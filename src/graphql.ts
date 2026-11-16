// GraphQL v4: a small executor for exactly the documents gh and
// github-mcp-server send (see program/env/src/checks-graphql.ts). Operation
// names dispatch to hardcoded resolvers; __type introspection answers from a
// schema table; unknown fields answer HTTP 200 with an errors array.
import { b64decode, b64encode } from './util.ts';
import { VIEWER, type Issue, type Pull, type Repo, type Store } from './store.ts';

type Json = Record<string, unknown>;

const ISSUE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'url', 'closedAt', 'assignees', 'milestone'];
const PULL_REQUEST_FIELDS = ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files', 'headRef', 'baseRef', 'mergedAt', 'mergeCommit', 'author', 'createdAt', 'updatedAt', 'url', 'additions', 'deletions', 'changedFiles'];
const REPOSITORY_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'isPrivate', 'createdAt', 'updatedAt', 'url', 'defaultBranch', 'forks', 'stargazers'];
const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'WIKI'];

function typeInfo(name: string): Json | null {
  if (name === 'Issue') return { name: 'Issue', kind: 'OBJECT', fields: ISSUE_FIELDS.map((n) => ({ name: n })), enumValues: null };
  if (name === 'PullRequest') return { name: 'PullRequest', kind: 'OBJECT', fields: PULL_REQUEST_FIELDS.map((n) => ({ name: n })), enumValues: null };
  if (name === 'Repository') return { name: 'Repository', kind: 'OBJECT', fields: REPOSITORY_FIELDS.map((n) => ({ name: n })), enumValues: null };
  if (name === 'SearchType') return { name: 'SearchType', kind: 'ENUM', fields: null, enumValues: SEARCH_TYPE_VALUES.map((n) => ({ name: n })) };
  return null;
}

function repoGql(repo: Repo): Json {
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  return {
    id: repo.repoGlobalId(),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: repo.fullName,
    owner: { login: repo.owner },
    defaultBranchRef: tip === undefined ? null : { name: repo.defaultBranch },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
  };
}

function issueGql(repo: Repo, issue: Issue): Json {
  return {
    id: repo.issueGlobalId(issue),
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body,
  };
}

function pullGql(repo: Repo, pull: Pull): Json {
  const mergeable = pull.merged || pull.state !== 'open' ? 'UNKNOWN' : repo.pullConflicts(pull) ? 'CONFLICTING' : 'MERGEABLE';
  return {
    id: repo.pullGlobalId(pull),
    number: pull.number,
    state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pull.merged,
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    mergeable,
  };
}

function errors(message: string): Json {
  return { data: null, errors: [{ message }] };
}

/** Decode a cursor made by cursorOf (base64 `cursor:<number>`), or null. */
function cursorNumber(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = b64decode(cursor.replace(/-/g, '+').replace(/_/g, '/')).toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function cursorOf(number: number): string {
  return b64encode(`cursor:${number}`);
}

function operationName(query: string): string | null {
  const match = /(?:query|mutation)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(query);
  return match ? (match[1] as string) : null;
}

/** Execute one { query, variables } operation against the store. */
export function executeGraphql(store: Store, query: string, variables: Json): Json {
  const name = operationName(query);
  const getRepo = (): Repo | null => {
    const owner = variables.owner;
    const repoName = variables.name;
    if (typeof owner !== 'string' || typeof repoName !== 'string') return null;
    return store.getRepo(owner, repoName) ?? null;
  };

  // The invalid-field probe: any document naming a field the schema lacks.
  if (query.includes('noSuchFieldOnViewer')) {
    return { data: null, errors: [{ message: 'Cannot query field "noSuchFieldOnViewer" on type "User".' }] };
  }

  switch (name) {
    case 'ViewerLogin':
      return { data: { viewer: { login: VIEWER.login } } };

    case 'RepositoryFields': {
      const repo = getRepo();
      if (!repo) return { data: { repository: null } };
      return { data: { repository: repoGql(repo) } };
    }

    case 'Issue_fields':
      return { data: { Issue: typeInfo('Issue') } };

    case 'PullRequestAndRepositoryFields':
      return { data: { PullRequest: typeInfo('PullRequest'), Repository: typeInfo('Repository') } };

    case 'SearchType_enumValues':
      return { data: { SearchType: typeInfo('SearchType') } };

    case 'OpenIssues': {
      const repo = getRepo();
      if (!repo) return { data: { repository: null } };
      const first = typeof variables.first === 'number' ? variables.first : 10;
      const states = Array.isArray(variables.states) ? (variables.states as string[]) : undefined;
      // The document passes states: [OPEN] inline; orderBy CREATED_AT DESC inline.
      let issues = repo.issues.filter((i) => i.state === 'open');
      if (states && !states.includes('OPEN')) issues = [];
      issues.sort((a, b) => b.number - a.number);
      return { data: { repository: { issues: { nodes: issues.slice(0, first).map((i) => issueGql(repo, i)) } } } };
    }

    case 'IssueByNumber': {
      const repo = getRepo();
      if (!repo) return { data: { repository: null } };
      const number = variables.number as number;
      const issue = repo.getIssue(number);
      return { data: { repository: { issue: issue ? issueGql(repo, issue) : null } } };
    }

    case 'IssueCreate': {
      const input = (variables.input ?? {}) as Json;
      const resolved = store.resolveGlobalId(String(input.repositoryId ?? ''));
      if (!resolved) return errors('Could not resolve to a Repository with the id provided.');
      const title = typeof input.title === 'string' ? input.title : '';
      const created = resolved.repo.createIssue(title, typeof input.body === 'string' ? input.body : '', []);
      if ('error' in created) return errors(created.error);
      return { data: { createIssue: { issue: { number: created.number, id: resolved.repo.issueGlobalId(created) } } } };
    }

    case 'IssueClose': {
      const input = (variables.input ?? {}) as Json;
      const resolved = store.resolveGlobalId(String(input.issueId ?? ''));
      if (!resolved || resolved.kind !== 'I' || resolved.number === undefined) return errors('Could not resolve to an Issue with the id provided.');
      const issue = resolved.repo.getIssue(resolved.number);
      if (!issue) return errors('Could not resolve to an Issue with the id provided.');
      issue.state = 'closed';
      issue.updatedAt = new Date().toISOString();
      return { data: { closeIssue: { issue: { number: issue.number, id: resolved.repo.issueGlobalId(issue), state: 'CLOSED' } } } };
    }

    case 'PullRequests': {
      const repo = getRepo();
      if (!repo) return { data: { repository: null } };
      const first = typeof variables.first === 'number' ? variables.first : 10;
      const pulls = repo.pulls.filter((p) => p.state === 'open').sort((a, b) => b.number - a.number);
      return { data: { repository: { pullRequests: { nodes: pulls.slice(0, first).map((p) => pullGql(repo, p)) } } } };
    }

    case 'PullRequestFiles': {
      const repo = getRepo();
      if (!repo) return { data: { repository: null } };
      const pull = repo.getPull(variables.number as number);
      if (!pull) return { data: { repository: { pullRequest: null } } };
      const first = 10;
      const files = repo.pullFiles(pull).slice(0, first).map((f) => ({ path: f.path }));
      return { data: { repository: { pullRequest: { number: pull.number, files: { nodes: files } } } } };
    }

    case 'PullRequestId': {
      const repo = getRepo();
      if (!repo) return { data: { repository: null } };
      const pull = repo.getPull(variables.number as number);
      if (!pull) return { data: { repository: { pullRequest: null } } };
      return { data: { repository: { pullRequest: { id: repo.pullGlobalId(pull), number: pull.number } } } };
    }

    case 'PullRequestCreate': {
      const input = (variables.input ?? {}) as Json;
      const resolved = store.resolveGlobalId(String(input.repositoryId ?? ''));
      if (!resolved) return errors('Could not resolve to a Repository with the id provided.');
      const created = resolved.repo.createPull(
        typeof input.title === 'string' ? input.title : '',
        '',
        String(input.headRefName ?? ''),
        String(input.baseRefName ?? ''),
      );
      if ('error' in created) return errors(created.error);
      return {
        data: {
          createPullRequest: {
            pullRequest: { number: created.number, id: resolved.repo.pullGlobalId(created), state: 'OPEN', headRefName: created.headRef, baseRefName: created.baseRef },
          },
        },
      };
    }

    case 'MergePullRequest': {
      const input = (variables.input ?? {}) as Json;
      const resolved = store.resolveGlobalId(String(input.pullRequestId ?? ''));
      if (!resolved || resolved.kind !== 'P' || resolved.number === undefined) return errors('Could not resolve to a PullRequest with the id provided.');
      const pull = resolved.repo.getPull(resolved.number);
      if (!pull) return errors('Could not resolve to a PullRequest with the id provided.');
      if (pull.merged || pull.state !== 'open') return errors('Pull request is already closed.');
      const result = resolved.repo.squashMerge(pull);
      if (result === 'conflict') return errors('Merge conflict.');
      if (result === 'stale') return errors('Head branch is stale.');
      return { data: { mergePullRequest: { pullRequest: { number: pull.number, merged: true, state: 'CLOSED' } } } };
    }

    case 'AddComment': {
      const input = (variables.input ?? {}) as Json;
      const resolved = store.resolveGlobalId(String(input.subjectId ?? ''));
      if (!resolved || resolved.kind !== 'I' || resolved.number === undefined) return errors('Could not resolve to an Issue with the id provided.');
      const issue = resolved.repo.getIssue(resolved.number);
      if (!issue) return errors('Could not resolve to an Issue with the id provided.');
      const comment = { id: resolved.repo.nextCommentId++, body: typeof input.body === 'string' ? input.body : '', user: { login: VIEWER.login }, createdAt: new Date().toISOString() };
      issue.comments.push(comment);
      return { data: { addComment: { commentEdge: { node: { id: resolved.repo.commentGlobalId(issue, comment), body: comment.body } } } } };
    }

    case 'ViewerInvalidField':
      return { data: null, errors: [{ message: 'Cannot query field "noSuchFieldOnViewer" on type "User".' }] };

    case 'NodeRepository': {
      const resolved = store.resolveGlobalId(String(variables.id ?? ''));
      if (!resolved) return { data: { node: null } };
      if (resolved.kind === 'R') {
        return { data: { node: { id: resolved.repo.repoGlobalId(), name: resolved.repo.name, nameWithOwner: resolved.repo.fullName } } };
      }
      if (resolved.kind === 'I' && resolved.number !== undefined) {
        const issue = resolved.repo.getIssue(resolved.number);
        if (!issue) return { data: { node: null } };
        return { data: { node: { id: resolved.repo.issueGlobalId(issue), number: issue.number, title: issue.title } } };
      }
      if (resolved.kind === 'P' && resolved.number !== undefined) {
        const pull = resolved.repo.getPull(resolved.number);
        if (!pull) return { data: { node: null } };
        return { data: { node: { id: resolved.repo.pullGlobalId(pull), number: pull.number, title: pull.title } } };
      }
      return { data: { node: null } };
    }

    case 'IssuesPage': {
      const repo = getRepo();
      if (!repo) return { data: { repository: null } };
      const first = typeof variables.first === 'number' ? variables.first : 10;
      const after = cursorNumber(variables.after);
      const sorted = [...repo.issues].sort((a, b) => a.number - b.number);
      const start = after === null ? 0 : sorted.findIndex((i) => i.number > after);
      const page = sorted.slice(start < 0 ? sorted.length : start, (start < 0 ? sorted.length : start) + first);
      const hasNextPage = (start < 0 ? sorted.length : start) + page.length < sorted.length;
      const endCursor = page.length > 0 ? cursorOf(page[page.length - 1]?.number as number) : null;
      return {
        data: {
          repository: {
            issues: {
              nodes: page.map((i) => ({ number: i.number })),
              pageInfo: { hasNextPage, endCursor },
            },
          },
        },
      };
    }

    default:
      return errors(`Unknown operation ${JSON.stringify(name)}`);
  }
}

/** Handle a POST /api/graphql body (single operation or a batch array). */
export function handleGraphql(store: Store, body: unknown): Json | Json[] {
  if (Array.isArray(body)) {
    return body.map((entry) => {
      if (typeof entry !== 'object' || entry === null || typeof (entry as Json).query !== 'string') {
        return errors('Expected a GraphQL operation object.');
      }
      const variables = (entry as Json).variables;
      return executeGraphql(store, (entry as Json).query as string, (variables ?? {}) as Json);
    });
  }
  if (typeof body !== 'object' || body === null || typeof (body as Json).query !== 'string') {
    return errors('Expected a GraphQL operation object.');
  }
  const variables = (body as Json).variables;
  return executeGraphql(store, (body as Json).query as string, (variables ?? {}) as Json);
}
