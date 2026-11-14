# Fornax type packs

A type pack teaches the Fornax worker one kind of job. It lives on the worker PC in `<data>/types/<name>/`
(Windows `%LOCALAPPDATA%\fornax\types\`, Linux `~/.local/share/fornax/types/`) and has two halves:

- the **contract**, which the worker announces to the server: what clients may submit;
- the **implementation**, which never leaves the PC: which program runs, and how.

## Layout

```
<name>/
  type.yaml     contract + implementation
  setup.md      what to install and where, for people and for Claude
  scripts/      helper scripts
  env/          venv, models, downloads: made by setup on this PC, never copied, never committed
```

## type.yaml

```yaml
name: render                 # a-z, 0-9 and "-"; the same as the directory name
version: 1                   # a whole number; a changed contract is a new version
description: Render one frame or a frame range of a .blend scene with Cycles.
inputs:
  scene: { extensions: [.blend], max_mb: 2048 }     # required: true unless set to false
params:                      # a strict subset of JSON Schema, see below
  type: object
  additionalProperties: false
  required: [frame_start]
  properties:
    frame_start: { type: integer, minimum: 0 }
    frame_end:   { type: integer, minimum: 0 }
    samples:     { type: integer, minimum: 1, maximum: 4096, default: 128 }
    format:      { enum: [png, jpg], default: png }
max_runtime: 6h              # 30s, 10m, 6h or 2d; at most 7 days
tools: [blender]             # their paths come from worker.yaml on this PC
# setup: [...]               # optional: installs into {pack}/env
check: ["{tool.blender}", "-b", "--factory-startup", "--python", "{pack}/scripts/check.py"]
run: ["{tool.blender}", "-b", "--disable-autoexec", "{input.scene}",
      "--python", "{pack}/scripts/render.py", "--",
      "--params", "{params_json}", "--out", "{out}"]
```

The **contract** is `name`, `version`, `description`, `inputs`, `params` and `max_runtime`. The **implementation** is
`tools`, `setup`, `check` and `run`. Any other key is an error.

The tools live in the worker's `worker.yaml` (`%APPDATA%\fornax\worker.yaml` or `~/.config/fornax/worker.yaml`):

```yaml
server: https://fornax.example.com
tools:
  blender: C:\Program Files\Blender Foundation\Blender 5.0\blender.exe
  python: python
```

A tool is an executable file or a command on `PATH`; `.cmd` and `.bat` files cannot be run (there is no shell).

## Parameters

`params` is a JSON Schema with root `type: object` and `additionalProperties: false`. Properties may be `string`,
`integer`, `number`, `boolean`, `enum`, or `array` of scalar items with `maxItems`. Allowed keywords: `minimum`,
`maximum`, `minLength`, `maxLength`, `pattern` (always anchored), `default`, `description`, `required`. Anything else is
an error when the pack loads, and so are `minimum > maximum`, `minLength > maxLength`, and enum members that start
with `-` or hold control characters.

Always, for every value: a string must not start with `-` and must not contain control characters (C0, C1, U+2028,
U+2029). The server checks params when a job is submitted, and the worker checks them again against its own
`type.yaml` before running; a job whose params no longer fit the installed version fails.

## Placeholders

| Placeholder | Value |
|---|---|
| `{params.<name>}` | the checked value; a list becomes several arguments, but only as a whole element |
| `{params_json}` | path of `{work}/params.json` with all checked params, defaults included |
| `{input.<name>}` | absolute path of the downloaded input (the worker names the file); an empty argument when an optional input was not given |
| `{out}` | directory for the outputs |
| `{work}` | the job's working directory |
| `{pack}` | the pack directory |
| `{tool.<name>}` | the tool's path from `worker.yaml`; the tool must be listed in `tools` |
| `{python}` | Python of `{pack}/env` (`Scripts\python.exe` on Windows, `bin/python` on Linux) |

Rules, checked when the pack loads:

- Every element of `run` becomes exactly one argument. Placeholders may sit inside text (`--samples={params.samples}`).
- Every `{…}` is a placeholder; there is no escape for literal braces. Put such text into a script instead.
- `{params.<name>}` needs a required parameter or one with a `default`. Optional parameters without a default reach the
  tool only through `{params_json}`.
- A number that may be negative (no `minimum: 0`) cannot be a whole element, because `-1` would read as an option;
  embed it instead (`--offset={params.offset}`).
- `setup` and `check` run without a job: only `{pack}`, `{tool.<name>}` and `{python}` work there.
- Input names must not be Windows device names (`con`, `nul`, `com1`, …).

## The tool's process

- No shell. The working directory is `{work}`.
- The environment is the worker's, without any `FORNAX_*` variable (the worker token never reaches a tool), plus
  `FORNAX_JOB_ID`, `FORNAX_OUT` and `FORNAX_WORK`.
- A stdout line `{"progress": 0.4, "message": "frame 3/10"}` is progress (0 to 1, the message optional). Every other
  stdout line and all of stderr go to the job log; the last 1 MiB is kept and uploaded as `log.txt`.
- Every file in `{out}`, recursively, is an output; its path relative to `{out}`, with `/`, is its name. Names are
  letters, digits, `.`, `_` and `-`, no leading dot, no Windows device names, at most 8 levels. Links are refused, and
  so are two names that differ only in letter case, and an output named `log.txt`.
- An optional `{out}/outputs.json` adds metadata and previews:
  `{"frame_0001.png": {"meta": {"width": 1920}, "preview": "previews/frame_0001.jpg"}}`. A file named as a preview is
  not listed as an output of its own.
- `max_runtime` is enforced: the whole process tree is killed and the job fails (and may be retried).

## Exit codes

| Code | Meaning | What happens |
|---|---|---|
| 0 | done | outputs and log are uploaded, the job succeeds |
| 1 | the job failed (also out of memory) | the log is uploaded; the server retries up to 3 attempts |
| 2 | invalid input | the log is uploaded; the job fails at once |
| 3 | broken environment (no GPU, missing model) | the job goes back to the queue without losing an attempt the first time; if the same job reports 3 a second time, that counts as a failed attempt (retried later, failed after the last). The worker stops offering the type until it restarts with a passing check |
| other, killed | as 1 | |

## check and setup

- `check` runs when the worker starts and in `fornax doctor`. Exit code 0 means ready; it may take at most 120 s.
- `setup` runs once in `fornax types install`, with the pack directory as working directory. It installs into
  `{pack}/env` only; it may take at most 2 hours. If it fails, nothing stays installed.

## Tools

`tools` names the programs a pack needs; their paths come from `worker.yaml` on the PC. Give the program itself, not
a launcher that starts it and exits (on Windows e.g. `blender.exe`, not `blender-launcher.exe`): the worker follows,
times and stops the process it started, and a launcher would end at once while the real work goes on unwatched.

## Safety rules for every pack

- Never run a tool in a mode that executes the content of an input file (Blender: always `--disable-autoexec`; no
  macros, no "load and run").
- Keep parameter schemas strict: enums, bounded numbers, patterns and `maxLength`.
- Inputs reach the tool only through `{input.<name>}`; never build a file path from a parameter.
- Install only into `{pack}/env`; change nothing outside the pack directory.

## Built-in packs

`fornax types install <name>` copies one of these from the worker bundle and runs its setup:

| Pack | Does | Needs |
|---|---|---|
| `transcribe` | speech to text with faster-whisper, optional speaker labels with pyannote | NVIDIA GPU, Python 3.10+, ffmpeg |
| `render` | Blender Cycles frames with JPEG previews | Blender 4.2+, a GPU Cycles supports, a self-contained .blend (packed resources) |

Their `setup.md` files say what is installed and how to check it. Both are good examples for a new pack: `transcribe`
for a Python tool in its own environment, `render` for an installed application.
