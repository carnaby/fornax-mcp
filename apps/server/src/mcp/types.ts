/** A content block of a tool answer. */
export type Block = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
export type ToolResult = { content: Block[]; isError?: boolean };
