import { AGENT_RULE } from '@fornax/protocol';
import { expect, test } from 'vitest';
import { agentOf } from '../src/commands/lease.js';

test('--agent wins over FORNAX_AGENT; a blank one is none (spec 09 § 2.3)', () => {
  expect(agentOf('agent-a', { FORNAX_AGENT: 'agent-b' })).toEqual({ agent: 'agent-a' });
  expect(agentOf(undefined, { FORNAX_AGENT: 'agent-b' })).toEqual({ agent: 'agent-b' });
  expect(agentOf(undefined, {})).toEqual({ agent: null });
  expect(agentOf('', { FORNAX_AGENT: 'agent-b' })).toEqual({ agent: null });
  expect(agentOf(undefined, { FORNAX_AGENT: '  ' })).toEqual({ agent: null });
});

test('a bad name names where it came from', () => {
  expect(agentOf('a;b', {})).toEqual({ problem: `--agent ${AGENT_RULE}` });
  expect(agentOf(undefined, { FORNAX_AGENT: '-x' })).toEqual({ problem: `FORNAX_AGENT ${AGENT_RULE}` });
});
