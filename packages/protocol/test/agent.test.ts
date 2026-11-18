import { expect, test } from 'vitest';
import { AGENT_MAX, AGENT_RULE, agentProblem } from '../src/agent.js';

test('ASCII letters and digits, space and . _ : / -, at most 80 characters (spec 09 § 2.2)', () => {
  for (const ok of ['agent-station-1', 'Agent-Main', 'mc/main:2', 'a b', 'x'.repeat(AGENT_MAX), 'a.b_c']) {
    expect(agentProblem(ok), ok).toBeNull();
  }
});

test('anything else is refused with the one rule', () => {
  for (const bad of ['x'.repeat(AGENT_MAX + 1), 'a;b', 'agent"x', '-agent', ' agent', 'agent ', '', 'a\tb', 'ágent']) {
    expect(agentProblem(bad), JSON.stringify(bad)).toBe(AGENT_RULE);
  }
  expect(AGENT_RULE).toBe('may hold at most 80 characters: ASCII letters and digits, space and . _ : / -, not starting with - or a space, not ending with a space');
});
