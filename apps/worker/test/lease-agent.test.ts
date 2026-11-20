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

test('inside a lease the inherited FORNAX_AGENT is not read; a typed --agent is; a blank FORNAX_LEASE is no lease (deferred 09 #2)', () => {
  expect(agentOf(undefined, { FORNAX_LEASE: '01JTESTLEASE', FORNAX_AGENT: '-x' })).toEqual({ agent: null });
  expect(agentOf('a;b', { FORNAX_LEASE: '01JTESTLEASE' })).toEqual({ problem: `--agent ${AGENT_RULE}` });
  expect(agentOf(undefined, { FORNAX_LEASE: '  ', FORNAX_AGENT: '-x' })).toEqual({ problem: `FORNAX_AGENT ${AGENT_RULE}` });
});

test('FORNAX_AGENT is trimmed: `set FORNAX_AGENT=agent-a ` in cmd.exe keeps the space (final review #3)', () => {
  expect(agentOf(undefined, { FORNAX_AGENT: 'agent-a ' })).toEqual({ agent: 'agent-a' });
  expect(agentOf(undefined, { FORNAX_AGENT: ' agent-a' })).toEqual({ agent: 'agent-a' });
  // A flag is what the user typed on purpose: checked as it is.
  expect(agentOf('agent-a ', {})).toEqual({ problem: expect.stringContaining('--agent ') });
});
