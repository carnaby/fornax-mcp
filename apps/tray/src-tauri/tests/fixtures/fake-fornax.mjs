// A stand-in for <data>/app/fornax.mjs in the tray's Rust tests (process.rs, controller.rs). It reads its behaviour from
// the file `mode` next to it (words separated by spaces) and its version from `version` (default 0.5.0), and counts
// the starts of its queue reader in `watch-starts`.
// Commands: --version; worker --events; queue --json --watch; queue move|cancel|pause|resume <…>.
// Worker words: stubborn (ignores stop and the end of stdin), crash (exits 1 without "stopped"), locked (another
// worker holds the lock), grandchild (starts a process that sleeps, in its own process group off Windows like the
// real worker's child, and logs "grandchild <pid>"). Reader words: down (the server cannot be reached), watch-exit
// (exits 1 after its first line), unpaired (exits 1 with the CLI's sentence on stderr before any line). Action words:
// failaction (exits 1 with the server's sentence), slowaction (never ends).
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (name, fallback) => {
  try {
    return readFileSync(join(here, name), 'utf8').trim();
  } catch {
    return fallback;
  }
};
const words = read('mode', '').split(/\s+/).filter(Boolean);
const has = (word) => words.includes(word);
const args = process.argv.slice(2);
const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const forever = () => setInterval(() => {}, 1000);

/** Calls `onLine` for each line of stdin and `onEnd` when stdin closes. */
function readInput(onLine, onEnd) {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => {
    buf += d;
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      onLine(buf.slice(0, i).trim());
      buf = buf.slice(i + 1);
    }
  });
  process.stdin.on('end', onEnd);
}

const job = (id, state, extra = {}) => ({
  id, type: 'echo', owner: 'alice', state, label: null, group: null, priority: 'normal', inputs: {}, attempts: 0,
  type_unavailable: false, run_after: null, created_at: '2026-11-15T13:56:00.000Z', started_at: null, finished_at: null,
  progress: null, progress_message: null, error: null, result_url: `https://fornax.example.com/r/${id}`, ...extra,
});
const queue = () => ({
  ok: true, server_time: new Date().toISOString(), change: '0123456789abcdef', paused: false,
  worker: { online: true, last_seen: null, version: '0.5.0', waiting: null },
  running: null, queued: [job('Q1', 'queued'), job('Q2', 'queued')],
  finished: [job('F1', 'failed', { error: 'bad input', started_at: '2026-11-15T13:40:00.000Z', finished_at: '2026-11-15T13:40:12.000Z' })],
});

if (args[0] === '--version') {
  process.stdout.write(`${read('version', '0.5.0')}\n`);
} else if (args[0] === 'worker' && args.includes('--events')) {
  if (has('locked')) {
    out({ event: 'log', line: 'another fornax worker runs on this PC (pid 1); stop it first' });
    out({ event: 'stopped', code: 1 });
    process.exit(1);
  }
  out({ event: 'started', version: read('version', '0.5.0'), pid: process.pid });
  if (has('crash')) {
    out({ event: 'log', line: 'something broke' });
    process.stderr.write('Error: boom\n');
    process.exit(1);
  }
  if (has('grandchild')) {
    const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    out({ event: 'log', line: `grandchild ${sleeper.pid}` });
  }
  out({ event: 'log', line: 'offering: echo' });
  let stops = 0;
  const stop = () => {
    if (has('stubborn')) return;
    stops += 1;
    if (stops === 1) {
      out({ event: 'log', line: 'stopping (a second stop quits at once)' });
      setTimeout(() => {
        out({ event: 'stopped', code: 0 });
        process.exit(0);
      }, 300);
    } else {
      out({ event: 'stopped', code: 130 });
      process.exit(130);
    }
  };
  readInput((line) => {
    if (line === 'stop') stop();
  }, () => {
    if (stops === 0) stop();
  });
  forever();
} else if (args[0] === 'queue' && args.includes('--watch')) {
  appendFileSync(join(here, 'watch-starts'), 'x\n');
  if (has('unpaired')) {
    process.stderr.write('this computer is not paired as a worker (fornax worker pair)\n');
    process.exit(1);
  }
  if (has('down')) out({ ok: false, error: 'network', message: 'cannot reach the server: ECONNREFUSED' });
  else out(queue());
  if (has('watch-exit')) process.exit(1);
  readInput(() => {}, () => process.exit(0));
  forever();
} else if (args[0] === 'queue' && ['move', 'cancel', 'pause', 'resume'].includes(args[1])) {
  if (has('slowaction')) {
    forever();
  } else if (has('failaction')) {
    process.stderr.write(`job ${args[2]} is running now; only waiting jobs move\n`);
    process.exit(1);
  } else {
    process.stdout.write(`done: ${args.slice(1).join(' ')}\n`);
  }
} else {
  process.stderr.write(`fake fornax: unknown command ${args.join(' ')}\n`);
  process.exit(2);
}
