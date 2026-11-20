# Fornax

GPU job queue served over MCP (server + worker), pnpm workspace: `apps/*`, `packages/*`. Early design: the first step is a spec and a plan.

- The repository is public: no host names, user names, machine paths, tokens or real recordings in code, tests or docs; comments in English.
- The worker must work fully on Windows and Linux.
- Keep LF line endings (`.gitattributes`).

## Memory (Tabula)
Tabula keeps this project's files that are not in git (handoff state, private specs and plans) and the global rules that apply to every project.
- This project's Tabula project is `fornax-mcp`; `.tabula.json` says which untracked files are synced.
- At session start call `recall` for `fornax-mcp` with `include_state: false` and follow the global rules. The project state is on disk (restored by the SessionStart hook).
- At session start, before anything else, read the handoff state `docs/handoff/agent-fornax-lead.md` and continue from its "Pokračuj tu"; without the file on disk (web), read it from Tabula with `read_file`.
- At handoff run `tabula push` after writing the state file.
- If the `tabula` command is not available (Claude Code on the web, claude.ai), the files are not on disk: call `recall` with `include_state: true`, read files with `read_file`, and save every new or changed synced file (spec, plan, `progress.md`, handoff state) with `write_file`.
- Never write project memories. Add a global rule only when the user explicitly asks.
