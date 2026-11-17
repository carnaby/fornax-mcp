// The tool of the test type pack "echo": reads params.json, writes outputs, behaves as params.mode says.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? '') : '';
};
const params = JSON.parse(readFileSync(arg('params'), 'utf8'));
const out = arg('out');
// An optional input that was not given arrives as an empty argument.
const input = arg('input');
const progress = (p, message) => console.log(JSON.stringify(message === undefined ? { progress: p } : { progress: p, message }));
const forever = () => setInterval(() => {}, 1000);

function writeResult() {
  const text = input ? readFileSync(input, 'utf8').toUpperCase() : 'NO INPUT';
  writeFileSync(join(out, 'result.txt'), text);
  mkdirSync(join(out, 'previews'), { recursive: true });
  writeFileSync(join(out, 'previews', 'result.jpg'), 'JPEG');
  writeFileSync(join(out, 'outputs.json'), JSON.stringify({ 'result.txt': { meta: { chars: text.length }, preview: 'previews/result.jpg' } }));
}

switch (params.mode) {
  case 'ok':
    console.log('working');
    progress(0.5, 'half way');
    writeResult();
    progress(1);
    break;
  case 'slow':
    progress(0.1, 'slow start');
    setTimeout(() => {
      writeResult();
      progress(1);
    }, params.ms);
    break;
  case 'exit':
    console.error('bad input: the file is empty');
    process.exitCode = params.code;
    break;
  case 'hang': {
    const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'], { stdio: 'ignore' });
    writeFileSync(params.pid_file, JSON.stringify({ parent: process.pid, child: child.pid }));
    progress(0.2, 'hanging');
    forever();
    break;
  }
  case 'env':
    writeFileSync(join(out, 'env.json'), JSON.stringify(Object.keys(process.env).filter((k) => /^(fornax_|example_token$)/i.test(k)).sort()));
    break;
  case 'interrupted':
    // Ended by the same Ctrl+C as the worker: Windows STATUS_CONTROL_C_EXIT, elsewhere SIGINT.
    writeFileSync(params.pid_file, JSON.stringify({ parent: process.pid, child: process.pid }));
    if (process.platform === 'win32') process.exit(0xc000013a);
    process.kill(process.pid, 'SIGINT');
    forever();
    break;
  case 'json-dir':
    // outputs.json that is a directory: reading it fails with an error that is not an OutputError.
    writeFileSync(join(out, 'result.txt'), 'x');
    mkdirSync(join(out, 'outputs.json'));
    break;
}
