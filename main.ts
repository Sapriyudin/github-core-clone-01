// Entry <-> env lifecycle: bind an ephemeral port, tell the env where to
// reach this forge, then wait until the env says the trial is over.
//
// The trial harness (env/src/wire.ts) works like this:
//   1. MAKEFUN_ENV_URL names the env's origin (http://store:8080 inside a
//      trial container). Without it there is nothing to talk to, so exit 1.
//   2. Listen on port 0 and let the kernel pick a free port. Never bind
//      8080 — that port belongs to the env.
//   3. POST $MAKEFUN_ENV_URL/register {"port": N}. The env records the
//      address the request came from plus N as this entry's base URL.
//      The first register wins; a 409 means another entry already won,
//      which is not this process's problem to fix — keep waiting.
//   4. GET $MAKEFUN_ENV_URL/done until it answers {"done": true}. The env
//      answers at once ({"done": false} while the suite runs), so this is
//      a poll, not a long-held request. Keep polling through errors; the
//      process never exits before the env says done.
//   5. Close the server and exit 0. The harness then stops the env, which
//      writes the export the scorer reads.
//
// main.ts imports its own server and nothing else: no package, no Node
// built-in, no model call.

import { createApp } from './app.ts';

const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envUrl === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

const REQUEST_TIMEOUT_MS = 30_000;
const FIRST_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 2_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Backoff after `failures` failed attempts: doubles from 250 ms, capped at 2 s. */
function backoffMs(failures: number): number {
  return Math.min(MAX_BACKOFF_MS, FIRST_BACKOFF_MS * 2 ** Math.min(failures, 8));
}

/**
 * POST the bound port until the env accepts it. 200 is the normal answer
 * and 409 (a first register already won) is accepted too. 400/405 are
 * contract errors and end the program; anything else is retried, since
 * the env may still be starting.
 */
async function register(port: number): Promise<void> {
  let failures = 0;
  for (;;) {
    try {
      const res = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
      // Network error or a retryable status: fall through to the backoff.
    }
    await sleep(backoffMs(failures));
    failures += 1;
  }
}

/** Poll GET /done until it answers {"done": true}; never return before that. */
async function waitForDone(): Promise<void> {
  let failures = 0;
  for (;;) {
    try {
      const res = await fetch(`${envUrl}/done`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: it is not
      // done, so poll again.
    }
    await sleep(backoffMs(failures));
    failures += 1;
  }
}

/** Bind the port, register it, then wait for the env: the whole life of the process. */
async function main(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${address.port}\n`);

  await register(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitForDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
