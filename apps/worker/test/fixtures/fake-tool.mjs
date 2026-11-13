// A stand-in for a real tool (Blender, Python) in the process tests. The first argument picks the behaviour.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const [mode, ...rest] = process.argv.slice(2);
const forever = () => setInterval(() => {}, 1000);

switch (mode) {
  case 'talk':
    console.log('starting');
    console.log(JSON.stringify({ progress: 0.5, message: 'half' }));
    console.log('{"progress": 2}');
    console.error('a warning');
    console.log(JSON.stringify({ progress: 1 }));
    process.exitCode = Number(rest[0] ?? 0);
    break;
  case 'argv':
    console.log(JSON.stringify(rest));
    break;
  case 'env':
    console.log(JSON.stringify(Object.keys(process.env).filter((k) => /^fornax_/i.test(k)).sort()));
    break;
  case 'cwd':
    console.log(process.cwd());
    break;
  case 'sleep':
    forever();
    break;
  case 'tree': {
    // A grandchild that ignores SIGTERM: only SIGKILL of the group (Linux) or taskkill /T (Windows) ends it.
    const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'], { stdio: 'ignore' });
    writeFileSync(rest[0], JSON.stringify({ parent: process.pid, child: child.pid }));
    forever();
    break;
  }
  case 'orphan': {
    // Leaves a grandchild that ignores SIGTERM behind and exits 0 at once.
    const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'], { stdio: 'ignore' });
    child.unref();
    writeFileSync(rest[0], JSON.stringify({ parent: process.pid, child: child.pid }));
    break;
  }
  default:
    console.error(`unknown mode ${mode}`);
    process.exitCode = 99;
}
