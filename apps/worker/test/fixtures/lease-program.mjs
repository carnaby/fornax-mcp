// A program for fornax lease tests: reports what it saw, then behaves as its arguments say.
//   --report <file>  JSON {at, pid, lease, fornax: names of FORNAX_* variables}
//   --runs <file>    appends "<ms> start <pid>" now and "<ms> end <pid>" when it ends by itself
//   --tree <file>    starts a child that runs forever; JSON {parent, child}
//   --print <text> / --eprint <text>   one line to stdout / stderr
//   --sleep <ms>, --exit <code>, --forever
import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const report = arg('report');
if (report) {
  const fornax = Object.keys(process.env).filter((k) => /^fornax_/i.test(k)).sort();
  writeFileSync(report, JSON.stringify({ at: Date.now(), pid: process.pid, lease: process.env.FORNAX_LEASE ?? null, fornax }));
}
const runs = arg('runs');
if (runs) appendFileSync(runs, `${Date.now()} start ${process.pid}\n`);
const tree = arg('tree');
if (tree) {
  // Windows: Node puts a child that is not detached into a job object that ends it together with this program; a
  // detached one outlives it, as the child of a native program (e.g. a renderer) does. Linux: the same process group.
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: process.platform === 'win32' });
  writeFileSync(tree, JSON.stringify({ parent: process.pid, child: child.pid }));
}
if (arg('print') !== undefined) console.log(arg('print'));
if (arg('eprint') !== undefined) console.error(arg('eprint'));
const finish = () => {
  if (runs) appendFileSync(runs, `${Date.now()} end ${process.pid}\n`);
  process.exit(Number(arg('exit') ?? 0));
};
if (argv.includes('--forever')) setInterval(() => {}, 1000);
else setTimeout(finish, Number(arg('sleep') ?? 0));
