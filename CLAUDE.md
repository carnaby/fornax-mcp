# Fornax

GPU job queue served over MCP (server + worker), pnpm workspace: `apps/*`, `packages/*`. Early design: the first step is a spec and a plan.

- The repository is public: no host names, user names, machine paths, tokens or real recordings in code, tests or docs; comments in English.
- The worker must work fully on Windows and Linux.
- Keep LF line endings (`.gitattributes`).

## Handoff state (read at session start)
- Handoff state (gitignored, kept in Tabula): `docs/handoff/fornax-mcp-agent.md`
- Agent knowledge (gitignored, kept in Tabula): `docs/agents/fornax-mcp-agent.md`

The last session's handoff is imported below. Read it before answering anything, continue from its "Pokračuj tu"
section and check its "Overený stav" against reality before relying on it.

@docs/handoff/fornax-mcp-agent.md

If the import above is empty (Claude Code on the web, a fresh clone), the file is not on disk: before anything else
call `recall` for `fornax-mcp` with `include_state: true`, which returns it.

## Memory (Tabula)
Tabula keeps this project's files that are not in git (handoff state, private specs and plans) and the global rules
that apply to every project. This project's Tabula project is `fornax-mcp`; `.tabula.json` says which untracked files
are synced.
- At session start call `recall` for `fornax-mcp` and follow the global rules. With the files on disk (the
  SessionStart hook ran `tabula pull`) pass `include_state: false`.
- Without the `tabula` command (Claude Code on the web, claude.ai): read synced files with `read_file` and save every
  new or changed one (spec, plan, `progress.md`, handoff state) with `write_file`.
- At handoff run `tabula push` after writing the state file.
- Never write project memories. Add a global rule only when the user explicitly asks.
