// The forge's store: repositories, git objects, refs, issues, pull requests,
// labels and comments — all in memory, one process. Deterministic where the
// suite compares values within a run (commit shas, ids); wall-clock-free
// timestamps for git objects come from a monotonic counter.
import {
  buildCommit,
  buildTree,
  collectReachable,
  flattenTree,
  mergeBase,
  parseCommit,
  parseTree,
  sortTreeEntries,
  type CommitInfo,
  type GitObject,
  type ObjectType,
  type TreeEntry,
} from './gitobj.ts';
import { globalId, hashObject, isoOf, ZERO_OID } from './util.ts';

export const VIEWER = Object.freeze({
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface IssueComment {
  id: number;
  body: string;
  user: { login: string };
  createdAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  user: { login: string };
  createdAt: string;
  updatedAt: string;
  comments: IssueComment[];
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  user: { login: string };
  createdAt: string;
  updatedAt: string;
}

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

/** Split text into lines (a trailing newline does not make an empty line). */
function linesOf(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Line additions/deletions between two texts, via LCS on lines (files are small). */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = linesOf(oldText);
  const b = linesOf(newText);
  const m = a.length;
  const n = b.length;
  // LCS lengths, two rows.
  let prev = new Array<number>(n + 1).fill(0);
  let curr = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i += 1) {
    curr[0] = 0;
    for (let j = 1; j <= n; j += 1) {
      curr[j] = a[i - 1] === b[j - 1] ? (prev[j - 1] as number) + 1 : Math.max(prev[j] as number, curr[j - 1] as number);
    }
    [prev, curr] = [curr, prev];
  }
  const lcs = prev[n] as number;
  return { additions: n - lcs, deletions: m - lcs };
}

export class Repo {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  description: string;
  privateFlag: boolean;
  readonly defaultBranch = 'main';
  readonly createdAt: string;
  updatedAt: string;
  readonly refs = new Map<string, string>();
  readonly objects = new Map<string, GitObject>();
  readonly labels: Label[] = [];
  readonly issues: Issue[] = [];
  readonly pulls: Pull[] = [];
  nextNumber = 1;
  nextCommentId = 1;
  nextLabelId = 1;
  /** Monotonic commit clock: deterministic shas within a run. */
  private clock = 1_700_000_000;
  /** Pack cache: key -> pack bytes (bounded, FIFO). */
  readonly packCache = new Map<string, Buffer>();

  constructor(id: number, owner: string, name: string, description: string, privateFlag: boolean) {
    this.id = id;
    this.owner = owner;
    this.name = name;
    this.description = description;
    this.privateFlag = privateFlag;
    this.createdAt = isoOf(1_700_000_000);
    this.updatedAt = this.createdAt;
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  // ------------------------------------------------------------ git objects

  storeObject(type: ObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  /** The next deterministic commit timestamp (seconds), advancing the clock. */
  nextCommitTime(): number {
    this.clock += 1;
    return this.clock;
  }

  identity(): string {
    return `${VIEWER.name} <${VIEWER.email}>`;
  }

  /** Create a commit object (not yet referenced) and return its oid. */
  makeCommit(tree: string, parents: readonly string[], message: string): string {
    const ts = this.nextCommitTime();
    const ident = `${this.identity()} ${ts} +0000`;
    const info: CommitInfo = { tree, parents: [...parents], author: ident, committer: ident, message };
    return this.storeObject('commit', buildCommit(info));
  }

  /** Resolve a ref name, branch short name, HEAD, or raw oid to a commit oid. */
  resolveRef(name: string): string | undefined {
    if (name === 'HEAD') return this.refs.get(`refs/heads/${this.defaultBranch}`);
    if (this.refs.has(name)) return this.refs.get(name);
    if (this.refs.has(`refs/heads/${name}`)) return this.refs.get(`refs/heads/${name}`);
    if (this.refs.has(`refs/tags/${name}`)) return this.refs.get(`refs/tags/${name}`);
    if (/^[0-9a-f]{40}$/.test(name) && this.objects.has(name)) return name;
    return undefined;
  }

  /** The commit oid a branch (short or full name) points at, or undefined. */
  branchTip(branch: string): string | undefined {
    const ref = branch.startsWith('refs/') ? branch : `refs/heads/${branch}`;
    return this.refs.get(ref);
  }

  /** The tree oid of a commit, or null. */
  commitTree(commitOid: string): string | null {
    const obj = this.objects.get(commitOid);
    if (!obj || obj.type !== 'commit') return null;
    return parseCommit(obj.data).tree;
  }

  /** Flatten the tree of a commit into path -> { mode, oid }. */
  treeFiles(commitOid: string): Map<string, { mode: string; oid: string }> | null {
    const tree = this.commitTree(commitOid);
    if (tree === null) return null;
    try {
      return flattenTree(tree, (oid) => this.objects.get(oid));
    } catch {
      return null;
    }
  }

  /** The blob bytes at a path in a commit's tree, or null. */
  fileAt(commitOid: string, path: string): Buffer | null {
    const files = this.treeFiles(commitOid);
    if (!files) return null;
    const entry = files.get(path);
    if (!entry) return null;
    const obj = this.objects.get(entry.oid);
    if (!obj || obj.type !== 'blob') return null;
    return obj.data;
  }

  /** Build a new tree from a parent tree with path set to a blob (or removed). */
  treeWith(parentTreeOid: string | null, path: string, blobOid: string | null): string {
    // Collect the current flat file map, apply the change, rebuild nested trees.
    const flat = new Map<string, { mode: string; oid: string }>();
    if (parentTreeOid !== null) {
      for (const [p, entry] of flattenTree(parentTreeOid, (oid) => this.objects.get(oid))) flat.set(p, entry);
    }
    if (blobOid === null) flat.delete(path);
    else flat.set(path, { mode: '100644', oid: blobOid });
    // Rebuild nested trees from the flat file map.
    const buildDirFrom = (subFlat: Map<string, { mode: string; oid: string }>): string => {
      const entries: TreeEntry[] = [];
      const dirs = new Map<string, Map<string, { mode: string; oid: string }>>();
      for (const [p, entry] of subFlat) {
        const slash = p.indexOf('/');
        if (slash < 0) {
          entries.push({ mode: entry.mode, name: p, oid: entry.oid });
        } else {
          const dir = p.slice(0, slash);
          let sub = dirs.get(dir);
          if (!sub) {
            sub = new Map();
            dirs.set(dir, sub);
          }
          sub.set(p.slice(slash + 1), entry);
        }
      }
      for (const [dir, deeper] of dirs) {
        entries.push({ mode: '40000', name: dir, oid: buildDirFrom(deeper) });
      }
      return this.storeObject('tree', buildTree(entries));
    };
    return buildDirFrom(flat);
  }

  /** The commit's parent list (first parent chain is enough for these histories). */
  commitParents(commitOid: string): string[] {
    const obj = this.objects.get(commitOid);
    if (!obj || obj.type !== 'commit') return [];
    return parseCommit(obj.data).parents;
  }

  // ------------------------------------------------------------ contents API

  /**
   * Write (or delete) a file on a branch, creating the branch from the default
   * tip when it does not exist yet, and the first commit when the repo is
   * unborn. Returns the new commit sha and the blob sha (or null on delete).
   */
  contentsCommit(options: {
    branch: string;
    path: string;
    content: Buffer | null;
    message: string;
    expectedBlobSha?: string;
  }): { commitSha: string; blobSha: string | null; error?: string } {
    const ref = `refs/heads/${options.branch}`;
    const tip = this.refs.get(ref);
    if (options.expectedBlobSha !== undefined) {
      const current = tip === undefined ? null : this.fileAt(tip, options.path);
      if (current === null) return { commitSha: '', blobSha: null, error: 'not found' };
      const currentSha = hashObject('blob', current);
      if (currentSha !== options.expectedBlobSha) return { commitSha: '', blobSha: null, error: 'stale sha' };
    }
    let blobSha: string | null = null;
    let tree: string;
    if (tip === undefined) {
      // New branch: start from the default branch tip (or an empty tree).
      const baseTip = this.refs.get(`refs/heads/${this.defaultBranch}`);
      const baseTree = baseTip === undefined ? null : this.commitTree(baseTip);
      if (options.content === null) return { commitSha: '', blobSha: null, error: 'not found' };
      blobSha = this.storeObject('blob', options.content);
      tree = this.treeWith(baseTree, options.path, blobSha);
      const commitSha = this.makeCommit(tree, baseTip === undefined ? [] : [baseTip], options.message);
      this.refs.set(ref, commitSha);
      this.packCache.clear();
      return { commitSha, blobSha };
    }
    const parentTree = this.commitTree(tip);
    if (options.content === null) {
      if (this.fileAt(tip, options.path) === null) return { commitSha: '', blobSha: null, error: 'not found' };
      tree = this.treeWith(parentTree, options.path, null);
    } else {
      blobSha = this.storeObject('blob', options.content);
      tree = this.treeWith(parentTree, options.path, blobSha);
    }
    const commitSha = this.makeCommit(tree, [tip], options.message);
    this.refs.set(ref, commitSha);
    this.packCache.clear();
    return { commitSha, blobSha };
  }

  /** The directory listing at a path in a commit's tree (files and subdirs). */
  directoryAt(commitOid: string, dirPath: string): { type: 'file' | 'dir'; name: string; path: string; sha: string }[] | null {
    const treeOid = this.commitTree(commitOid);
    if (treeOid === null) return null;
    let current: string | null = treeOid;
    if (dirPath !== '') {
      const segments = dirPath.split('/');
      for (const segment of segments) {
        if (current === null) return null;
        const obj = this.objects.get(current);
        if (!obj || obj.type !== 'tree') return null;
        const entry = parseTree(obj.data).find((e) => e.name === segment && e.mode === '40000');
        if (!entry) return null;
        current = entry.oid;
      }
    }
    if (current === null) return null;
    const obj = this.objects.get(current);
    if (!obj || obj.type !== 'tree') return null;
    const out: { type: 'file' | 'dir'; name: string; path: string; sha: string }[] = [];
    for (const entry of sortTreeEntries(parseTree(obj.data))) {
      const path = dirPath === '' ? entry.name : `${dirPath}/${entry.name}`;
      out.push({ type: entry.mode === '40000' ? 'dir' : 'file', name: entry.name, path, sha: entry.oid });
    }
    return out;
  }

  // ------------------------------------------------------------ issues & PRs

  findLabel(name: string): Label | undefined {
    return this.labels.find((l) => l.name === name);
  }

  createIssue(title: string, body: string, labelNames: readonly string[]): Issue | { error: string } {
    const labels: Label[] = [];
    for (const name of labelNames) {
      const label = this.findLabel(name);
      if (!label) return { error: `Label does not exist: ${name}` };
      labels.push(label);
    }
    const number = this.nextNumber++;
    const now = new Date().toISOString();
    const issue: Issue = {
      id: this.id * 1_000_000 + number,
      number,
      title,
      body,
      state: 'open',
      labels,
      user: { login: VIEWER.login },
      createdAt: now,
      updatedAt: now,
      comments: [],
    };
    this.issues.push(issue);
    return issue;
  }

  getIssue(number: number): Issue | undefined {
    return this.issues.find((i) => i.number === number);
  }

  createPull(title: string, body: string, head: string, base: string): Pull | { error: string } {
    const headTip = this.branchTip(head);
    const baseTip = this.branchTip(base);
    if (headTip === undefined) return { error: `head branch ${head} does not exist` };
    if (baseTip === undefined) return { error: `base branch ${base} does not exist` };
    const existing = this.pulls.find((p) => p.headRef === head && p.baseRef === base && p.state === 'open');
    if (existing) return { error: 'a pull request for this head already exists' };
    const number = this.nextNumber++;
    const now = new Date().toISOString();
    const pull: Pull = {
      id: this.id * 1_000_000 + number,
      number,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: head,
      baseRef: base,
      headSha: headTip,
      baseSha: baseTip,
      user: { login: VIEWER.login },
      createdAt: now,
      updatedAt: now,
    };
    this.pulls.push(pull);
    return pull;
  }

  getPull(number: number): Pull | undefined {
    return this.pulls.find((p) => p.number === number);
  }

  /** Changed files between the merge-base and the head tip, with line counts. */
  pullFiles(pull: Pull): FileChange[] {
    const base = mergeBase(pull.headSha, pull.baseSha, (oid) => this.objects.get(oid));
    const baseFiles = base === null ? new Map() : this.treeFiles(base) ?? new Map();
    const headFiles = this.treeFiles(pull.headSha) ?? new Map();
    const out: FileChange[] = [];
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
    for (const path of [...paths].sort()) {
      const oldEntry = baseFiles.get(path);
      const newEntry = headFiles.get(path);
      if (oldEntry?.oid === newEntry?.oid) continue;
      if (!oldEntry && newEntry) {
        const data = this.objects.get(newEntry.oid)?.data ?? Buffer.alloc(0);
        const adds = linesOf(data.toString('utf8')).length;
        out.push({ path, status: 'added', additions: adds, deletions: 0, changes: adds });
      } else if (oldEntry && !newEntry) {
        const data = this.objects.get(oldEntry.oid)?.data ?? Buffer.alloc(0);
        const dels = linesOf(data.toString('utf8')).length;
        out.push({ path, status: 'removed', additions: 0, deletions: dels, changes: dels });
      } else if (oldEntry && newEntry) {
        const oldText = (this.objects.get(oldEntry.oid)?.data ?? Buffer.alloc(0)).toString('utf8');
        const newText = (this.objects.get(newEntry.oid)?.data ?? Buffer.alloc(0)).toString('utf8');
        const { additions, deletions } = lineDiff(oldText, newText);
        out.push({ path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return out;
  }

  /** Whether a squash merge of this pull would conflict (3-way check). */
  pullConflicts(pull: Pull): boolean {
    const base = mergeBase(pull.headSha, pull.baseSha, (oid) => this.objects.get(oid));
    if (base === null) return false;
    const mbFiles = this.treeFiles(base) ?? new Map();
    const headFiles = this.treeFiles(pull.headSha) ?? new Map();
    const baseTipFiles = this.treeFiles(pull.baseSha) ?? new Map();
    const paths = new Set([...mbFiles.keys(), ...headFiles.keys()]);
    for (const path of paths) {
      const mb = mbFiles.get(path)?.oid;
      const head = headFiles.get(path)?.oid;
      if (mb === head) continue;
      const current = baseTipFiles.get(path)?.oid;
      if (current !== mb && current !== head) return true;
    }
    return false;
  }

  /**
   * Squash-merge the pull onto its base branch: one commit whose tree is the
   * head tip's tree, parent the base tip. Returns the merge sha, 'conflict',
   * or 'stale' when the base moved since the pull was opened.
   */
  squashMerge(pull: Pull): string | 'conflict' | 'stale' {
    const currentBase = this.branchTip(pull.baseRef);
    if (currentBase === undefined || currentBase !== pull.baseSha) {
      // The base moved: re-evaluate against the current tip.
      pull.baseSha = currentBase ?? pull.baseSha;
    }
    if (this.pullConflicts(pull)) return 'conflict';
    const headTree = this.commitTree(pull.headSha);
    if (headTree === null) return 'stale';
    const message = `Merge pull request #${pull.number} from ${this.owner}/${pull.headRef}`;
    const mergeSha = this.makeCommit(headTree, [pull.baseSha], message);
    this.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = new Date().toISOString();
    pull.mergeCommitSha = mergeSha;
    pull.updatedAt = pull.mergedAt;
    this.packCache.clear();
    return mergeSha;
  }

  // ------------------------------------------------------------ global ids

  repoGlobalId(): string {
    return globalId('R', this.owner, this.name);
  }

  issueGlobalId(issue: Issue): string {
    return globalId('I', this.owner, this.name, issue.number);
  }

  pullGlobalId(pull: Pull): string {
    return globalId('P', this.owner, this.name, pull.number);
  }

  commentGlobalId(issue: Issue, comment: IssueComment): string {
    return globalId('C', this.owner, this.name, issue.number, comment.id);
  }

  /** Decode a global id into { kind, owner, name, number?, comment? }. */
  static decodeGlobalId(id: string): { kind: string; owner: string; name: string; number?: number; comment?: number } | null {
    try {
      const padded = id.replace(/-/g, '+').replace(/_/g, '/');
      const text = Buffer.from(padded, 'base64').toString('utf8');
      const [kind, owner, name, extra, extra2] = text.split(':');
      if (!kind || !owner || !name) return null;
      const out: { kind: string; owner: string; name: string; number?: number; comment?: number } = { kind, owner, name };
      if (extra !== undefined && extra !== '') {
        const n = Number(extra);
        if (Number.isInteger(n)) out.number = n;
      }
      if (extra2 !== undefined && extra2 !== '') {
        const n = Number(extra2);
        if (Number.isInteger(n)) out.comment = n;
      }
      return out;
    } catch {
      return null;
    }
  }
}

export class Store {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(name: string, description: string, privateFlag: boolean): Repo | 'exists' {
    if (this.getRepo(VIEWER.login, name)) return 'exists';
    const repo = new Repo(this.nextRepoId++, VIEWER.login, name, description, privateFlag);
    this.repos.set(this.key(VIEWER.login, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  /** All repositories owned by the viewer, in creation order. */
  viewerRepos(): Repo[] {
    return [...this.repos.values()].filter((r) => r.owner === VIEWER.login);
  }

  /** Resolve a global id to its repo (and issue/pull when the kind names one). */
  resolveGlobalId(id: string): { repo: Repo; kind: string; number?: number; comment?: number } | null {
    const decoded = Repo.decodeGlobalId(id);
    if (!decoded) return null;
    const repo = this.getRepo(decoded.owner, decoded.name);
    if (!repo) return null;
    return { repo, kind: decoded.kind, number: decoded.number, comment: decoded.comment };
  }
}

/** A commit's ancestry walk (newest first) from a tip, capped. */
export function walkCommits(repo: Repo, tip: string, limit = 10_000): { sha: string; message: string; author: string; committer: string }[] {
  const out: { sha: string; message: string; author: string; committer: string }[] = [];
  const seen = new Set<string>();
  const queue: string[] = [tip];
  while (queue.length > 0 && out.length < limit) {
    const oid = queue.shift() as string;
    if (oid === ZERO_OID || seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.getObject(oid);
    if (!obj || obj.type !== 'commit') continue;
    const info = parseCommit(obj.data);
    out.push({ sha: oid, message: info.message, author: info.author, committer: info.committer });
    for (const parent of info.parents) queue.push(parent);
  }
  return out;
}

/** Reachable objects from a set of roots, as a list (commit/tree/blob/tag). */
export function reachableObjects(repo: Repo, roots: readonly string[]): GitObject[] {
  const oids = collectReachable(roots, (oid) => repo.getObject(oid));
  const out: GitObject[] = [];
  for (const oid of oids) {
    const obj = repo.getObject(oid);
    if (obj) out.push(obj);
  }
  return out;
}

export { ZERO_OID };
