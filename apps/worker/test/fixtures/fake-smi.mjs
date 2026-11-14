// A stand-in for nvidia-smi in tests: the first argument says how to behave; the rest must be the real query.
const [mode, ...query] = process.argv.slice(2);
if (query.join(' ') !== '--query-gpu=memory.used,memory.total --format=csv,noheader,nounits') {
  console.error(`unexpected arguments: ${query.join(' ')}`);
  process.exit(9);
}
switch (mode) {
  case 'one':
    console.log('1130, 16311');
    break;
  case 'two':
    console.log('5120, 16311\r\n800, 8192');
    break;
  case 'empty':
    break;
  case 'text':
    console.log('[N/A], [N/A]');
    break;
  case 'fail':
    console.error('NVIDIA-SMI has failed');
    process.exit(9);
    break;
  case 'hang':
    setInterval(() => {}, 1000);
    break;
  default:
    process.exit(2);
}
