/** Spec 13 § 5: MCP answers carry outputs in pages; a render of 120 frames would otherwise cost an agent ~25 000 tokens. */
export const OUTPUTS_PAGE = 20;

type WithOutputs = { outputs: { size: number }[] | null };

const bytesOf = (outputs: { size: number }[]): number => outputs.reduce((sum, o) => sum + o.size, 0);

/** The view with only outputs [offset, offset + limit), the counts of all of them and where the next page starts. */
export function pageOutputs<T extends WithOutputs>(view: T, offset: number, limit: number) {
  const all = view.outputs;
  return {
    ...view,
    outputs: (all === null ? null : all.slice(offset, offset + limit)) as T['outputs'],
    outputs_total: all === null ? null : all.length,
    outputs_bytes: all === null ? null : bytesOf(all),
    outputs_next_offset: all !== null && offset + limit < all.length ? offset + limit : null,
  };
}

/** The view without its output list, with the counts (list_jobs). */
export function outputsSummary<T extends WithOutputs>(view: T) {
  const { outputs, ...rest } = view;
  return { ...rest, outputs_total: outputs === null ? null : outputs.length, outputs_bytes: outputs === null ? null : bytesOf(outputs) };
}
