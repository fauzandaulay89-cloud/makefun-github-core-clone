// Entry point: wire the app server into the trial environment.
//
// The environment drives the trial. This process only has three jobs:
// bind a port, tell the environment where to reach the server, and stay
// alive until the environment reports the trial is finished.
//
// Protocol (the contract the kit's RULES.txt describes):
//   - MAKEFUN_ENV_URL points at the environment, e.g. http://store:8080.
//     Without it there is nothing to register with, so exit 1.
//   - listen(0) lets the kernel pick a free port. Port 8080 belongs to
//     the environment and must never be bound here.
//   - POST /register {port} announces the server. The first registration
//     wins; a 409 means someone else already registered, which is fine.
//   - GET /done is polled until it answers {"done": true}.
//   - Then the server closes and the process exits 0.

import { createApp } from './app.ts';

const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envOrigin === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

// One attempt may take this long before it is abandoned and retried.
const ATTEMPT_TIMEOUT_MS = 30_000;
// Backoff between attempts: start short, grow, cap here.
const BACKOFF_FIRST_MS = 250;
const BACKOFF_CAP_MS = 2_000;

const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** Wait time before the nth retry: doubles from BACKOFF_FIRST_MS up to BACKOFF_CAP_MS. */
function backoffMs(attempt: number): number {
  return Math.min(BACKOFF_CAP_MS, BACKOFF_FIRST_MS * 2 ** Math.min(attempt, 8));
}

/** Announce the bound port to the environment, retrying until it sticks. */
async function announce(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    let fatal: Error | null = null;
    try {
      const response = await fetch(`${envOrigin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      });
      if (response.status === 200 || response.status === 409) return;
      if (response.status === 400 || response.status === 405) {
        fatal = new Error(`register answered HTTP ${response.status}: ${await response.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) fatal = err;
    }
    if (fatal !== null) throw fatal;
    await pause(backoffMs(attempt));
  }
}

/** Keep asking the environment whether the trial is over; return only when it is. */
async function awaitDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${envOrigin}/done`, { signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS) });
      if (response.ok) {
        const payload = (await response.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch {
      // Not answering yet, or the request timed out: not done, so ask again.
    }
    await pause(backoffMs(attempt));
  }
}

/** Bind, announce, wait for the trial to end, then shut down. */
async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${bound.port}\n`);

  await announce(bound.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await awaitDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
