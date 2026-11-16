// Shared helpers: hashing, pkt-lines, base64. Node stdlib only.
import { createHash } from 'node:crypto';

export const ZERO_OID = '0000000000000000000000000000000000000000';

/** Lowercase hex SHA-1 of bytes. */
export function sha1(data: Buffer | string): string {
  return createHash('sha1').update(data).digest('hex');
}

export function isOid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

/** The git object id of `<type> <len>\0<data>`. */
export function hashObject(type: string, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1(Buffer.concat([header, data]));
}

/** Standard base64 of bytes or UTF-8 text. */
export function b64encode(data: Buffer | string): string {
  return Buffer.isBuffer(data) ? data.toString('base64') : Buffer.from(data, 'utf8').toString('base64');
}

/** Decode base64, ignoring whitespace/newlines (GitHub wraps contents at 60 chars). */
export function b64decode(text: string): Buffer {
  return Buffer.from(text.replace(/[\r\n\t ]+/g, ''), 'base64');
}

/** URL-safe opaque global id (never the plain database id). */
export function globalId(kind: string, ...parts: readonly (string | number)[]): string {
  return b64encode(`${kind}:${parts.join(':')}`).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// --------------------------------------------------------------------------- pkt-lines

/** One pkt-line: 4 hex chars of (4 + payload length) + payload. */
export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const header = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

/** Encode a list of text lines, 'flush' and 'delim' markers into pkt-lines. */
export function encodePktLines(items: readonly (string | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(PKT_FLUSH);
    else if (item === 'delim') parts.push(PKT_DELIM);
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

export type Packet = { kind: 'data' | 'flush' | 'delim'; payload: Buffer };

/**
 * Decode a whole pkt-line stream. Throws on a malformed length prefix; a trailing
 * partial packet is ignored (the caller treats a short body as malformed input).
 */
export function decodePktLines(buf: Buffer): Packet[] {
  const out: Packet[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const lenHex = buf.subarray(offset, offset + 4).toString('ascii');
    if (lenHex === '0000') {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (lenHex === '0001') {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    const len = parseInt(lenHex, 16);
    if (!Number.isFinite(len) || len < 4 || offset + len > buf.length) {
      throw new Error(`malformed pkt-line length ${JSON.stringify(lenHex)} at offset ${offset}`);
    }
    out.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
    offset += len;
  }
  return out;
}

/** Split decoded packets at the first flush: [before, after]. */
export function splitAtFlush(packets: readonly Packet[]): [Packet[], Packet[]] {
  const idx = packets.findIndex((p) => p.kind === 'flush');
  if (idx < 0) return [packets.slice(), []];
  return [packets.slice(0, idx), packets.slice(idx + 1)];
}

/** The text of data packets, each without its trailing newline. */
export function packetLines(packets: readonly Packet[]): string[] {
  const lines: string[] = [];
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    lines.push(p.payload.toString('utf8').replace(/\n$/, ''));
  }
  return lines;
}

/** ISO 8601 UTC timestamp for an epoch second. */
export function isoOf(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString();
}
