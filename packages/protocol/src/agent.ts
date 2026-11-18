/** Spec 09 § 2.2: who submitted a job, as the agent names itself (e.g. its session name); every client sees it. */
export const AGENT_MAX = 80;
export const AGENT_RULE = `may hold at most ${AGENT_MAX} characters: letters, digits, space and . _ : / -, not starting with - or a space, not ending with a space`;
const AGENT = /^[A-Za-z0-9 ._:/-]+$/;

/** AGENT_RULE when `value` cannot be an agent's name, else null. An empty string is "no agent" for callers, not a name. */
export function agentProblem(value: string): string | null {
  const ok = value.length <= AGENT_MAX && AGENT.test(value) && !/^[- ]/.test(value) && !value.endsWith(' ');
  return ok ? null : AGENT_RULE;
}
