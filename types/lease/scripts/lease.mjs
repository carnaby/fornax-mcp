// The tool of the lease type (spec 05a 4.2): it holds the GPU for a program that `fornax lease` runs on this PC and
// renders nothing. Node standard library only. It talks to `fornax lease` through two files in <data>/leases/<job id>/:
// `alive` (renewed every 15 s; it holds the started_at of the claim fornax lease serves) and `done` (written when the
// program ended; it holds the started_at the program ran under). Every failure is exit code 4: a lease never retries.
//
// The pack runs standalone on the worker's Node and must not import worker code, so its folder helpers (newest,
// sweep) are its own on purpose; worker code that handles the same folders must keep the same rules.
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const positive = (name, fallback) => {
  const v = Number(arg(name));
  return Number.isFinite(v) && v > 0 ? v : fallback;
};
// Tests shorten the clock; the pack's run line never passes these.
const TICK_MS = positive('tick-ms', 1000);
const GRACE_MS = positive('grace-ms', 60_000);
const MINUTE_MS = positive('minute-ms', 60_000);
const LEFTOVER_MS = 86_400_000;

/** <data>/types/lease/scripts/lease.mjs → <data>/leases: the folder fornax lease finds through its own paths. */
const leasesDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'leases');

const fail = (message) => {
  console.error(message);
  process.exit(4);
};
// Node's own exit code for a throw is 1, which the worker retries: anything unexpected is 4 as well. The code, not the
// message: the message may hold this PC's path.
process.on('uncaughtException', (e) => fail(`the lease tool failed (${e?.code ?? e?.name ?? 'error'})`));

const id = process.env.FORNAX_JOB_ID ?? '';
if (!/^[0-9A-Za-z]{1,64}$/.test(id)) fail('FORNAX_JOB_ID is missing or not a job id');
let params;
try {
  params = JSON.parse(readFileSync(arg('params') ?? '', 'utf8'));
} catch {
  fail('the params file cannot be read');
}
if (!params || typeof params !== 'object') fail('the params are not an object');
const minutes = params.minutes;
if (!Number.isInteger(minutes) || minutes < 1) fail('the params have no minutes');
const label = typeof params.label === 'string' && params.label ? params.label : 'leased';

const dir = join(leasesDir, id);
const alive = join(dir, 'alive');
const done = join(dir, 'done');
// Wall clock only to compare with alive's change time; elapsed time runs on the monotonic clock.
const start = Date.now();
const startMono = performance.now();

/** Newest change of a lease folder: the folder itself or any file in it. */
function newest(path) {
  let t = statSync(path).mtimeMs;
  for (const name of readdirSync(path)) {
    try {
      t = Math.max(t, statSync(join(path, name)).mtimeMs);
    } catch {
      // Gone meanwhile.
    }
  }
  return t;
}

/** Leftovers of crashed runs: lease folders nothing touched for a day. */
function sweep() {
  let entries = [];
  try {
    entries = readdirSync(leasesDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name === id) continue;
    const path = join(leasesDir, e.name);
    try {
      if (start - newest(path) > LEFTOVER_MS) rmSync(path, { recursive: true, force: true });
    } catch {
      // Held or gone: a later sweep tries again.
    }
  }
}

/** A file's content and change time, or null when it is not there. */
function read(file) {
  try {
    return { text: readFileSync(file, 'utf8').trim(), mtimeMs: statSync(file).mtimeMs };
  } catch {
    return null;
  }
}

let timer;
let ended = false;

/** Ends the tool once its output is flushed: no process.exit, which could cut the last lines short. */
function end(code, message) {
  if (message) console.error(message);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // fornax lease or the next start of this tool sweeps it.
  }
  ended = true;
  clearInterval(timer);
  process.exitCode = code;
}

let shownMinute = -1;
function tick() {
  const now = Date.now();
  // done before alive: fornax lease writes alive before done, so a done seen here meets its alive in the same tick.
  const d = read(done);
  const a = read(alive);
  // Only the done of the claim alive names ends the lease. A done of an earlier claim, or one with no alive, is only
  // ignored, never removed: removing it could race fornax lease writing the matching one. A stale done is harmless
  // (the next done overwrites it, the sweep removes leftovers). An empty done or alive is still being written: the
  // next tick decides.
  if (d && d.text && a && a.text === d.text) return end(0);
  const elapsed = performance.now() - startMono;
  if (elapsed >= minutes * MINUTE_MS) return end(4, 'the lease time ran out');
  if (!a) {
    if (elapsed > GRACE_MS) return end(4, `no \`fornax lease\` took this lease within ${GRACE_MS / 1000} s`);
  } else if (now - Math.max(a.mtimeMs, start) > GRACE_MS) {
    // An alive older than this tool (an earlier claim's) gets the same grace as a missing one.
    return end(4, '`fornax lease` stopped renewing the lease');
  }
  // Whole minutes: the line is printed once a minute.
  const minute = Math.floor(elapsed / MINUTE_MS);
  if (minute !== shownMinute) {
    shownMinute = minute;
    console.log(JSON.stringify({ progress: Math.min(1, minute / minutes), message: `${label}, ${minute} min` }));
  }
}

try {
  mkdirSync(dir, { recursive: true });
} catch (e) {
  fail(`the lease folder cannot be created (${e.code ?? 'error'})`);
}
sweep();
tick();
if (!ended) timer = setInterval(tick, TICK_MS);
