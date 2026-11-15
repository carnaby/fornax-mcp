// A stand-in for `fornax worker --child`, run by the supervisor tests as: node <this> worker --child <mode> <file>.
// restart-once: exits 75 the first time (counted in <file>), then 0. always-75: exits 75. signal: writes the signals
// it gets to <file> and exits 0 after the second (as the worker: first = stop, second = quit). exit-3: exits 3.
// restart-5: exits 75 the first 5 times, then 0. slow-75: counts its starts in <file>, ignores signals and exits 75
// after a second (a restart request that was underway when a stop came). stdin-<n>: writes the lines it reads from
// stdin to <file> and exits 0 after the n-th "stop" or at end of input (then the file ends with ",eof").
import { readFileSync, writeFileSync } from 'node:fs';

const [, , , , mode, file] = process.argv;
const count = () => {
  try {
    return Number(readFileSync(file, 'utf8'));
  } catch {
    return 0;
  }
};
if (mode === 'restart-once') {
  const n = count() + 1;
  writeFileSync(file, String(n));
  process.exit(n === 1 ? 75 : 0);
}
if (mode === 'restart-5') {
  const n = count() + 1;
  writeFileSync(file, String(n));
  process.exit(n <= 5 ? 75 : 0);
}
if (mode === 'slow-75') {
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']) process.on(s, () => {});
  writeFileSync(file, String(count() + 1));
  setTimeout(() => process.exit(75), 1000);
}
if (mode === 'always-75') process.exit(75);
if (mode === 'exit-3') process.exit(3);
if (mode === 'signal') {
  const got = [];
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']) {
    process.on(s, () => {
      got.push(s);
      writeFileSync(file, got.join(','));
      if (got.length >= 2) process.exit(0);
    });
  }
  writeFileSync(file, 'ready');
  setInterval(() => {}, 1000);
}
if (mode?.startsWith('stdin-')) {
  const need = Number(mode.slice('stdin-'.length));
  const got = [];
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => {
    buf += d;
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      got.push(buf.slice(0, i));
      buf = buf.slice(i + 1);
      writeFileSync(file, got.join(','));
      if (got.filter((l) => l === 'stop').length >= need) process.exit(0);
    }
  });
  process.stdin.on('end', () => {
    writeFileSync(file, [...got, 'eof'].join(','));
    process.exit(0);
  });
  writeFileSync(file, 'ready');
}
