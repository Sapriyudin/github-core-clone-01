// Git object model: blobs, trees, commits, tags; pack v2/v3 read/write (undeltified
// output; OFS_DELTA and REF_DELTA resolved on input); reachability walks.
// Node stdlib only (zlib for pack entry compression).
import { inflateSync, deflateSync } from 'node:zlib';
import { hashObject, sha1, ZERO_OID } from './util.ts';

export type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a tree object's raw bytes into entries (in stored order). */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('malformed tree: no mode terminator');
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('malformed tree: no name terminator');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree sort: entries sort by name, directories as if the name ends with '/'. */
export function sortTreeEntries(entries: readonly TreeEntry[]): TreeEntry[] {
  const key = (e: TreeEntry): string => (e.mode === '40000' ? `${e.name}/` : e.name);
  return [...entries].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/** Build a tree object's raw bytes from entries (sorted git-style). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of sortTreeEntries(entries)) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse a commit object's raw bytes. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** Build a commit object's raw bytes. */
export function buildCommit(info: CommitInfo): Buffer {
  const lines: string[] = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.author}`);
  lines.push(`committer ${info.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${info.message}`, 'utf8');
}

/** Parse a tag object's raw bytes: { object, type, tag, tagger, message }. */
export function parseTag(data: Buffer): { object: string; type: string; tag: string; tagger: string; message: string } {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// --------------------------------------------------------------------------- deltas

/** Read a git varint (delta size encoding: 7 bits per byte, little-endian groups). */
function readVarint(data: Buffer, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let pos = offset;
  for (;;) {
    if (pos >= data.length) throw new Error('delta varint overruns the buffer');
    const byte = data[pos] as number;
    pos += 1;
    value |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  return { value, next: pos };
}

/** Apply a git delta to its base object, returning the result bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const sourceSize = readVarint(delta, 0);
  if (sourceSize.value !== base.length) throw new Error(`delta base size ${sourceSize.value} != ${base.length}`);
  const targetSize = readVarint(delta, sourceSize.next);
  const parts: Buffer[] = [];
  let pos = targetSize.next;
  while (pos < delta.length) {
    const op = delta[pos] as number;
    pos += 1;
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) {
        if ((op & (1 << i)) !== 0) {
          if (pos >= delta.length) throw new Error('delta copy overruns the buffer');
          offset |= (delta[pos] as number) << (8 * i);
          pos += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if ((op & (0x10 << i)) !== 0) {
          if (pos >= delta.length) throw new Error('delta copy overruns the buffer');
          size |= (delta[pos] as number) << (8 * i);
          pos += 1;
        }
      }
      if (size === 0) size = 0x10000;
      if (offset + size > base.length) throw new Error('delta copy escapes the base object');
      parts.push(base.subarray(offset, offset + size));
    } else if (op !== 0) {
      if (pos + op > delta.length) throw new Error('delta insert overruns the buffer');
      parts.push(delta.subarray(pos, pos + op));
      pos += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const out = Buffer.concat(parts);
  if (out.length !== targetSize.value) throw new Error(`delta result size ${out.length} != ${targetSize.value}`);
  return out;
}

// --------------------------------------------------------------------------- packs

const PACK_TYPES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const PACK_TYPE_IDS: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** Read a whole packfile (v2/v3), resolving deltas; returns oid -> object. */
export function readPack(buf: Buffer): Map<string, GitObject> {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  // Verify the trailer checksum.
  const expected = sha1(buf.subarray(0, buf.length - 20));
  const actual = buf.subarray(buf.length - 20).toString('hex');
  if (expected !== actual) throw new Error('pack trailer checksum mismatch');
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, { type: ObjectType; data: Buffer }>();
  let offset = 12;
  const end = buf.length - 20;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    if (offset >= end) throw new Error('pack ends before its declared object count');
    let byte = buf[offset] as number;
    offset += 1;
    const typeId = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      if (offset >= end) throw new Error('pack size varint overruns');
      byte = buf[offset] as number;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (typeId === 6) {
      // OFS_DELTA: base offset is a negative offset varint.
      let offByte = buf[offset] as number;
      offset += 1;
      let baseOffset = offByte & 0x7f;
      while ((offByte & 0x80) !== 0) {
        offByte = buf[offset] as number;
        offset += 1;
        baseOffset = ((baseOffset + 1) << 7) | (offByte & 0x7f);
      }
      const base = byOffset.get(entryOffset - baseOffset);
      if (!base) throw new Error('OFS_DELTA base is not an earlier pack entry');
      const inflated = inflateSync(buf.subarray(offset));
      const consumed = inflatedConsumed(buf, offset);
      offset += consumed;
      const data = applyDelta(base.data, inflated);
      const obj: GitObject = { type: base.type, data };
      objects.set(hashObject(obj.type, obj.data), obj);
      byOffset.set(entryOffset, obj);
    } else if (typeId === 7) {
      // REF_DELTA: 20-byte base oid follows the size varint.
      if (offset + 20 > end) throw new Error('REF_DELTA base oid overruns');
      const baseOid = buf.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const base = objects.get(baseOid);
      if (!base) throw new Error(`REF_DELTA base ${baseOid} is not in the pack`);
      const inflated = inflateSync(buf.subarray(offset));
      const consumed = inflatedConsumed(buf, offset);
      offset += consumed;
      const data = applyDelta(base.data, inflated);
      const obj: GitObject = { type: base.type, data };
      objects.set(hashObject(obj.type, obj.data), obj);
      byOffset.set(entryOffset, obj);
    } else {
      const type = PACK_TYPES[typeId];
      if (!type) throw new Error(`unknown pack object type ${typeId}`);
      const inflated = inflateSync(buf.subarray(offset));
      const consumed = inflatedConsumed(buf, offset);
      offset += consumed;
      if (inflated.length !== size) throw new Error(`pack object size ${inflated.length} != declared ${size}`);
      const obj: GitObject = { type, data: inflated };
      objects.set(hashObject(type, inflated), obj);
      byOffset.set(entryOffset, obj);
    }
  }
  return objects;
}

/**
 * How many compressed bytes the zlib stream at `offset` occupies. inflateSync
 * ignores trailing bytes but throws on a truncated stream, so the shortest
 * prefix that inflates to the full result is exactly the stream's end.
 */
function inflatedConsumed(buf: Buffer, offset: number): number {
  const rest = buf.subarray(offset);
  const inflated = inflateSync(rest);
  let lo = 1;
  let hi = rest.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      const trial = inflateSync(rest.subarray(0, mid));
      if (trial.equals(inflated)) hi = mid;
      else lo = mid + 1;
    } catch {
      lo = mid + 1;
    }
  }
  return lo;
}

/** Write an undeltified pack v2 from objects (each stored once, by oid). */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    const typeId = PACK_TYPE_IDS[obj.type];
    const size = obj.data.length;
    const headerBytes: number[] = [];
    let remaining = size;
    let first = (typeId << 4) | (remaining & 0x0f);
    remaining >>= 4;
    if (remaining > 0) first |= 0x80;
    headerBytes.push(first);
    while (remaining > 0) {
      let byte = remaining & 0x7f;
      remaining >>= 7;
      if (remaining > 0) byte |= 0x80;
      headerBytes.push(byte);
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = Buffer.from(sha1(body), 'hex');
  return Buffer.concat([body, trailer]);
}

/** Verify a pack's trailer checksum without parsing its objects. */
export function verifyPack(buf: Buffer): boolean {
  if (buf.length < 32 || buf.subarray(0, 4).toString('ascii') !== 'PACK') return false;
  return sha1(buf.subarray(0, buf.length - 20)) === buf.subarray(buf.length - 20).toString('hex');
}

// --------------------------------------------------------------------------- reachability

export type ObjectLookup = (oid: string) => GitObject | undefined;

/**
 * All objects reachable from `roots` (commits -> trees -> blobs, tags -> targets).
 * Throws on a missing object.
 */
export function collectReachable(roots: readonly string[], lookup: ObjectLookup): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [...roots];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (oid === ZERO_OID || seen.has(oid)) continue;
    const obj = lookup(oid);
    if (!obj) throw new Error(`missing object ${oid}`);
    seen.add(oid);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) queue.push(entry.oid);
    } else if (obj.type === 'tag') {
      queue.push(parseTag(obj.data).object);
    }
  }
  return seen;
}

/** The ancestors of a commit (itself included), in BFS order. */
export function commitAncestors(tip: string, lookup: ObjectLookup, limit = 100_000): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [tip];
  while (queue.length > 0 && seen.size < limit) {
    const oid = queue.shift() as string;
    if (oid === ZERO_OID || seen.has(oid)) continue;
    const obj = lookup(oid);
    if (!obj || obj.type !== 'commit') continue;
    seen.add(oid);
    for (const parent of parseCommit(obj.data).parents) queue.push(parent);
  }
  return seen;
}

/** Whether `ancestor` is an ancestor of (or equal to) `descendant`. */
export function isAncestor(ancestor: string, descendant: string, lookup: ObjectLookup): boolean {
  if (ancestor === descendant) return true;
  return commitAncestors(descendant, lookup).has(ancestor);
}

/** The first common ancestor of two commits (merge-base), or null. */
export function mergeBase(a: string, b: string, lookup: ObjectLookup): string | null {
  const ancestorsA = commitAncestors(a, lookup);
  const queue: string[] = [b];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (oid === ZERO_OID || seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsA.has(oid)) return oid;
    const obj = lookup(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) queue.push(parent);
  }
  return null;
}

/**
 * Flatten a tree (recursively) into path -> { mode, oid, type }.
 * Directories themselves are not listed, only files (and submodules).
 */
export function flattenTree(
  treeOid: string,
  lookup: ObjectLookup,
  prefix = '',
  out: Map<string, { mode: string; oid: string }> = new Map(),
): Map<string, { mode: string; oid: string }> {
  const obj = lookup(treeOid);
  if (!obj || obj.type !== 'tree') throw new Error(`tree ${treeOid} not found`);
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      flattenTree(entry.oid, lookup, path, out);
    } else {
      out.set(path, { mode: entry.mode, oid: entry.oid });
    }
  }
  return out;
}
