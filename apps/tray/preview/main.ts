// The tray window without the tray (spec 06e § 4): ?fixture=<name> picks a snapshot of fixtures.ts; clicks only go to
// the console. Run: pnpm --filter @fornax/tray preview, then open http://127.0.0.1:1422/preview/?fixture=main
import { setBridge } from '../src/bridge';
import type { Snapshot } from '../src/types';
import { FIXTURES } from './fixtures';

const fixtures: Record<string, () => Snapshot> = FIXTURES;
const name = new URLSearchParams(location.search).get('fixture') ?? 'main';
const fixture = fixtures[name] ?? FIXTURES.main;
setBridge({
  invoke: async <T>(command: string, args?: Record<string, unknown>) => {
    if (command === 'snapshot') return fixture() as T;
    console.info('command', command, args ?? {});
    return undefined as T;
  },
  listen: () => {},
});
document.title = `Fornax · ${name}`;
await import('../src/main');
