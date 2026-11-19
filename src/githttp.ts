// Git smart HTTP: info/refs advertisements (v2 when the client asks with
// `Git-Protocol: version=2`, else v0; receive-pack is always v0), v2/v0
// upload-pack (ls-refs, fetch with shallow/deepen) and v0 receive-pack
// (push with report-status). Packs are undeltified; fetch packs are cached
// per (wants, haves, depth) for the clone workload.
import {
  collectReachable,
  isAncestor,
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  verifyPack,
  writePack,
  type GitObject,
} from './gitobj.ts';
import type { Repo } from './store.ts';
import { decodePktLines, encodePktLines, packetLines, PKT_FLUSH, pktLine, splitAtFlush, ZERO_OID } from './util.ts';

const AGENT = 'github-core-clone/1.0.0';
/** Max pack bytes per sideband packet: a pkt-line is at most 65520 bytes
 * including its 4-byte length, and one byte is the sideband band. */
const MAX_SIDEBAND = 65515;

/** Split pack bytes into sideband band-1 pkt-lines (each <= 64 KiB). */
function sidebandPack(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += MAX_SIDEBAND) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + MAX_SIDEBAND));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return out;
}

/** The ref advertisement lines for a repo (sorted by name, HEAD first is not required). */
function refLines(repo: Repo): { name: string; oid: string; peeled?: string; symrefTarget?: string }[] {
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const out: { name: string; oid: string; peeled?: string; symrefTarget?: string }[] = [];
  out.push({ name: 'HEAD', oid: repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID, symrefTarget: `refs/heads/${repo.defaultBranch}` });
  for (const [name, oid] of refs) {
    const obj = repo.getObject(oid);
    let peeled: string | undefined;
    if (obj?.type === 'tag') {
      try {
        const target = parseTag(obj.data).object;
        // Peel to the commit the tag points at (possibly through nested tags).
        let current = target;
        for (let i = 0; i < 8; i += 1) {
          const next = repo.getObject(current);
          if (!next || next.type !== 'tag') break;
          current = parseTag(next.data).object;
        }
        peeled = current;
      } catch {
        peeled = undefined;
      }
    }
    out.push({ name, oid, peeled });
  }
  return out;
}

function v2Capabilities(): string[] {
  return ['version 2', `agent=${AGENT}`, 'object-format=sha1', 'ls-refs=unborn', 'fetch=shallow wait-for-done'];
}

function v0UploadCapabilities(repo: Repo): string {
  return `symref=HEAD:refs/heads/${repo.defaultBranch} side-band-64k shallow ofs-delta thin-pack agent=${AGENT}`;
}

function v0ReceiveCapabilities(repo: Repo): string {
  return `symref=HEAD:refs/heads/${repo.defaultBranch} report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
}

/** GET /{owner}/{repo}/info/refs?service=... — returns { status, contentType, body }. */
export function infoRefs(repo: Repo | undefined, service: 'git-upload-pack' | 'git-receive-pack', gitProtocol2: boolean): { status: number; contentType: string; body: Buffer } {
  if (!repo) {
    return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8') };
  }
  const serviceLine = `# service=${service}\n`;
  if (service === 'git-upload-pack' && gitProtocol2) {
    const lines: (string | 'flush')[] = [serviceLine, 'flush', ...v2Capabilities(), 'flush'];
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: encodePktLines(lines) };
  }
  // v0 advertisement (upload-pack without the version=2 header, or receive-pack).
  const caps = service === 'git-upload-pack' ? v0UploadCapabilities(repo) : v0ReceiveCapabilities(repo);
  const refs = refLines(repo);
  const parts: Buffer[] = [pktLine(serviceLine), PKT_FLUSH];
  if (refs.length <= 1 && (refs[0]?.oid ?? ZERO_OID) === ZERO_OID) {
    // Empty repository: the capabilities^{} pseudo-ref carries the capabilities.
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((ref, index) => {
      const line = index === 0 ? `${ref.oid} ${ref.name}\0${caps}\n` : `${ref.oid} ${ref.name}\n`;
      parts.push(pktLine(line));
      if (ref.peeled) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    });
  }
  parts.push(PKT_FLUSH);
  const contentType = service === 'git-upload-pack' ? 'application/x-git-upload-pack-advertisement' : 'application/x-git-receive-pack-advertisement';
  return { status: 200, contentType, body: Buffer.concat(parts) };
}

// --------------------------------------------------------------------------- upload-pack

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallowBoundaries: string[];
  depth: number | null;
  done: boolean;
}

/** Objects for a fetch: walk from wants (depth-limited), minus haves' closure. */
function fetchObjects(repo: Repo, req: FetchRequest): { objects: GitObject[]; shallow: string[] } {
  const lookup = (oid: string): GitObject | undefined => repo.getObject(oid);
  const wanted = new Set<string>();
  const shallow: string[] = [];
  if (req.depth !== null) {
    // Depth-limited walk: commits at depth < N are sent; the deepest sent
    // commits (depth N-1, when they have parents) are the shallow boundary.
    const queue: { oid: string; depth: number }[] = req.wants.map((oid) => ({ oid, depth: 0 }));
    const seenCommits = new Set<string>();
    while (queue.length > 0) {
      const { oid, depth } = queue.shift() as { oid: string; depth: number };
      if (oid === ZERO_OID || seenCommits.has(oid)) continue;
      const obj = lookup(oid);
      if (!obj || obj.type !== 'commit') {
        // A want that is not a commit (e.g. a tag): include its closure whole.
        if (obj) for (const reachable of collectReachable([oid], lookup)) wanted.add(reachable);
        continue;
      }
      seenCommits.add(oid);
      if (depth >= req.depth) continue;
      wanted.add(oid);
      const parents = parseCommit(obj.data).parents;
      if (depth === req.depth - 1) {
        if (parents.length > 0) shallow.push(oid);
      } else {
        for (const parent of parents) queue.push({ oid: parent, depth: depth + 1 });
      }
    }
    // Expand the sent commits to their trees/blobs.
    const extra = new Set<string>();
    for (const oid of wanted) {
      const obj = lookup(oid);
      if (!obj || obj.type !== 'commit') continue;
      const commit = parseCommit(obj.data);
      for (const reachable of collectReachable([commit.tree], lookup)) extra.add(reachable);
    }
    for (const oid of extra) wanted.add(oid);
  } else {
    for (const oid of collectReachable(req.wants, lookup)) wanted.add(oid);
  }
  // Exclude everything the client already has — but never traverse past a
  // shallow boundary: a deepen request must deliver the commits beyond the
  // boundary even though they are reachable from the client's have.
  if (req.haves.length > 0) {
    const excluded = exclusionSet(repo, req.haves, new Set(req.shallowBoundaries));
    for (const oid of excluded) wanted.delete(oid);
  }
  // Explicit shallow boundaries the client sent (deepen of an existing shallow).
  for (const boundary of req.shallowBoundaries) {
    if (repo.getObject(boundary) && !shallow.includes(boundary)) shallow.push(boundary);
  }
  const objects: GitObject[] = [];
  for (const oid of wanted) {
    const obj = lookup(oid);
    if (obj) objects.push(obj);
  }
  return { objects, shallow };
}

/** Objects reachable from `roots`, except that the walk never descends past
 * a commit in `cutoffs` (its own tree is included, its parents are not).
 * Unknown roots are ignored. */
function exclusionSet(repo: Repo, roots: readonly string[], cutoffs: ReadonlySet<string>): Set<string> {
  const lookup = (oid: string): GitObject | undefined => repo.getObject(oid);
  const seen = new Set<string>();
  const queue: string[] = [...roots];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (oid === ZERO_OID || seen.has(oid)) continue;
    const obj = lookup(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      try {
        for (const reachable of collectReachable([commit.tree], lookup)) seen.add(reachable);
      } catch {
        // A tree the server lacks: ignore it.
      }
      if (!cutoffs.has(oid)) {
        for (const parent of commit.parents) queue.push(parent);
      }
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) queue.push(entry.oid);
    } else if (obj.type === 'tag') {
      try {
        queue.push(parseTag(obj.data).object);
      } catch {
        // ignore a malformed tag
      }
    }
  }
  return seen;
}

/** Build (or reuse from cache) the pack for a fetch. The shallow list is
 * cached with the pack: it is deterministic for the same request, and
 * recomputing it (fetchObjects) on every cache hit cost a full tree walk
 * per clone. The key includes the shallow boundaries: they change the
 * exclusion cutoffs, so they change the pack. */
function fetchPack(repo: Repo, req: FetchRequest): { pack: Buffer; shallow: string[] } {
  const key = [...req.wants].sort().join(',') + '|' + [...req.haves].sort().join(',') + '|' + String(req.depth) + '|' + [...req.shallowBoundaries].sort().join(',');
  const cached = repo.packCache.get(key);
  if (cached) return cached;
  const { objects, shallow } = fetchObjects(repo, req);
  const pack = writePack(objects);
  if (repo.packCache.size >= 64) {
    const first = repo.packCache.keys().next().value as string | undefined;
    if (first !== undefined) repo.packCache.delete(first);
  }
  const entry = { pack, shallow };
  repo.packCache.set(key, entry);
  return entry;
}

function v2LsRefs(repo: Repo, args: readonly string[]): Buffer {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const lines: string[] = [];
  const refs = refLines(repo);
  const hasRefs = refs.some((r) => r.name !== 'HEAD' && r.oid !== ZERO_OID);
  if (!hasRefs && unborn) {
    // An empty repository advertises only its unborn HEAD (with the symref
    // target); an `unborn refs/heads/<branch>` line would read as an
    // existing branch to clients that test the tip's presence.
    if (keep('HEAD')) lines.push(`unborn HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`);
  } else {
    for (const ref of refs) {
      if (!keep(ref.name)) continue;
      if (ref.oid === ZERO_OID) {
        if (unborn) lines.push(`unborn ${ref.name}${ref.symrefTarget && symrefs ? ` symref-target:${ref.symrefTarget}` : ''}\n`);
        continue;
      }
      let line = `${ref.oid} ${ref.name}`;
      if (ref.symrefTarget && symrefs) line += ` symref-target:${ref.symrefTarget}`;
      if (ref.peeled && peel) line += ` peeled:${ref.peeled}`;
      lines.push(`${line}\n`);
    }
  }
  return encodePktLines([...lines, 'flush']);
}

function v2Fetch(repo: Repo, args: readonly string[]): Buffer {
  const req: FetchRequest = { wants: [], haves: [], shallowBoundaries: [], depth: null, done: false };
  for (const arg of args) {
    if (arg.startsWith('want ')) req.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) req.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) req.shallowBoundaries.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) {
      const n = Number(arg.slice(7).trim());
      if (Number.isInteger(n) && n > 0) req.depth = n;
    } else if (arg === 'done') req.done = true;
  }
  const { pack, shallow } = fetchPack(repo, req);
  const parts: Buffer[] = [];
  parts.push(encodePktLines(['acknowledgments\n', 'NAK\n', 'delim']));
  if (shallow.length > 0) {
    parts.push(encodePktLines(['shallow-info\n', ...shallow.map((oid) => `shallow ${oid}\n`), 'delim']));
  }
  parts.push(encodePktLines(['packfile\n']));
  for (const chunk of sidebandPack(pack)) parts.push(chunk);
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function v0Fetch(repo: Repo, args: readonly string[]): Buffer {
  const req: FetchRequest = { wants: [], haves: [], shallowBoundaries: [], depth: null, done: false };
  for (const arg of args) {
    if (arg.startsWith('want ')) {
      // The first want may carry capabilities after the oid.
      const rest = arg.slice(5).trim();
      req.wants.push(rest.split(' ')[0] as string);
    } else if (arg.startsWith('have ')) req.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) req.shallowBoundaries.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) {
      const n = Number(arg.slice(7).trim());
      if (Number.isInteger(n) && n > 0) req.depth = n;
    } else if (arg === 'done') req.done = true;
  }
  const { pack, shallow } = fetchPack(repo, req);
  const parts: Buffer[] = [];
  parts.push(encodePktLines(['NAK\n', ...shallow.map((oid) => `shallow ${oid}\n`)]));
  for (const chunk of sidebandPack(pack)) parts.push(chunk);
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** POST /{owner}/{repo}/git-upload-pack. */
export function uploadPack(repo: Repo | undefined, body: Buffer): { status: number; contentType: string; body: Buffer } {
  if (!repo) {
    return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8') };
  }
  let packets;
  try {
    packets = decodePktLines(body);
  } catch (err) {
    return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: `malformed pkt-line: ${err instanceof Error ? err.message : String(err)}` }), 'utf8') };
  }
  const lines = packetLines(packets);
  const first = lines[0] ?? '';
  try {
    if (first.startsWith('command=')) {
      const command = first.slice('command='.length).trim();
      // Arguments live after the delim packet.
      const delimIndex = packets.findIndex((p) => p.kind === 'delim');
      const args = packetLines(delimIndex < 0 ? [] : packets.slice(delimIndex + 1));
      if (command === 'ls-refs') {
        return { status: 200, contentType: 'application/x-git-upload-pack-result', body: v2LsRefs(repo, args) };
      }
      if (command === 'fetch') {
        return { status: 200, contentType: 'application/x-git-upload-pack-result', body: v2Fetch(repo, args) };
      }
      return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: `unknown command ${command}` }), 'utf8') };
    }
    // v0: wants section, flush, haves section, flush.
    const args = lines;
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: v0Fetch(repo, args) };
  } catch (err) {
    return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: `upload-pack failed: ${err instanceof Error ? err.message : String(err)}` }), 'utf8') };
  }
}

// --------------------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** POST /{owner}/{repo}/git-receive-pack. */
export function receivePack(repo: Repo | undefined, body: Buffer): { status: number; contentType: string; body: Buffer } {
  if (!repo) {
    return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8') };
  }
  const report = (unpackOk: boolean, unpackDetail: string, refs: { ref: string; ok: boolean; reason: string }[]): Buffer => {
    const lines: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
    for (const r of refs) lines.push(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`);
    const band1 = encodePktLines([...lines, 'flush']);
    return Buffer.concat([pktLine(Buffer.concat([Buffer.from([1]), band1])), PKT_FLUSH]);
  };
  // The pack follows the command flush as raw bytes: find the flush first and
  // decode ONLY the command section as pkt-lines (the pack is not pkt-lined).
  const packStart = firstFlushEnd(body);
  if (packStart === null) {
    return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'malformed pkt-line stream' }), 'utf8') };
  }
  let packets;
  try {
    packets = decodePktLines(body.subarray(0, packStart));
  } catch {
    return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'malformed pkt-line stream' }), 'utf8') };
  }
  const [commandPackets] = splitAtFlush(packets);
  const commands: PushCommand[] = [];
  for (const line of packetLines(commandPackets)) {
    const nul = line.indexOf('\0');
    const clean = nul >= 0 ? line.slice(0, nul) : line;
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(clean);
    if (!match) {
      return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: `malformed push command ${JSON.stringify(line.slice(0, 60))}` }), 'utf8') };
    }
    commands.push({ oldOid: match[1] as string, newOid: match[2] as string, ref: match[3] as string });
  }
  if (commands.length === 0) {
    return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'no push commands' }), 'utf8') };
  }
  const packBytes = body.subarray(packStart);
  const hasUpdates = commands.some((c) => c.newOid !== ZERO_OID);
  if (hasUpdates && packBytes.length > 0) {
    if (!verifyPack(packBytes)) {
      return {
        status: 200,
        contentType: 'application/x-git-receive-pack-result',
        body: report(false, 'pack checksum mismatch', commands.map((c) => ({ ref: c.ref, ok: false, reason: 'unpacker error' }))),
      };
    }
    try {
      const objects = readPack(packBytes);
      repo.storeObjects(objects);
    } catch (err) {
      return {
        status: 200,
        contentType: 'application/x-git-receive-pack-result',
        body: report(false, err instanceof Error ? err.message : 'unpacker error', commands.map((c) => ({ ref: c.ref, ok: false, reason: 'unpacker error' }))),
      };
    }
  } else if (hasUpdates && packBytes.length === 0) {
    return {
      status: 200,
      contentType: 'application/x-git-receive-pack-result',
      body: report(false, 'unpacker error', commands.map((c) => ({ ref: c.ref, ok: false, reason: 'unpacker error' }))),
    };
  }
  const results: { ref: string; ok: boolean; reason: string }[] = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (!command.ref.startsWith('refs/') || command.ref.includes('..') || /[\s~^:?*[\\]/.test(command.ref)) {
      results.push({ ref: command.ref, ok: false, reason: 'invalid ref' });
      continue;
    }
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'ref does not exist' });
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        results.push({ ref: command.ref, ok: false, reason: 'old oid mismatch' });
      } else {
        repo.refs.delete(command.ref);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (!repo.getObject(command.newOid)) {
      results.push({ ref: command.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (current === undefined) {
      if (command.oldOid !== ZERO_OID) {
        results.push({ ref: command.ref, ok: false, reason: 'old oid mismatch' });
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    if (command.oldOid !== current) {
      results.push({ ref: command.ref, ok: false, reason: 'old oid mismatch' });
      continue;
    }
    // Fast-forward: the new tip must descend from the old tip. isAncestor
    // stops at the old tip instead of walking the whole chain.
    let ff = false;
    try {
      ff = isAncestor(current, command.newOid, (oid) => repo.getObject(oid));
    } catch {
      ff = false;
    }
    if (!ff) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    results.push({ ref: command.ref, ok: true, reason: '' });
  }
  repo.packCache.clear();
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: report(true, 'ok', results) };
}

/** The byte offset just after the first flush packet (0000) in a raw buffer. */
function firstFlushEnd(body: Buffer): number | null {
  let offset = 0;
  while (offset + 4 <= body.length) {
    const lenHex = body.subarray(offset, offset + 4).toString('ascii');
    if (lenHex === '0000') return offset + 4;
    if (lenHex === '0001') {
      offset += 4;
      continue;
    }
    const len = parseInt(lenHex, 16);
    if (!Number.isFinite(len) || len < 4 || offset + len > body.length) return null;
    offset += len;
  }
  return null;
}
