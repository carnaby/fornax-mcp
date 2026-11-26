# Fornax

**A GPU job queue served over MCP.** One worker on a PC with a GPU owns the card; agents and apps on other machines
send it jobs (transcription, rendering, upscaling, and any type you add) and get the results back with a manifest.

**[What Fornax is, in one page](https://carnaby.github.io/fornax-mcp/)** — with screenshots of the tray.

*Fornax* is Latin for an oven, and the name of a constellation.

Status: 0.14, in daily use: several agents share one GPU PC through it. The API may still change.

```
agent (MCP) ─┐                    ┌─ fornax worker on the GPU PC (pulls jobs; no open port)
             ├──► Fornax server ◄─┤
app (REST) ──┘   queue, files,    └─ type packs: transcribe, render, upscale, tts, document-parse, your own
                 result pages
```

- **One job at a time, in a fair order.** Priorities `high`, `normal` and `idle` (an idle job waits until someone
  starts it); every job names the agent that sent it, and `queue_status` says who runs and who waits ahead.
- **Programs on the GPU PC take their turn too.** `fornax lease -- <program>` waits in the queue, holds the card while
  the program runs and gives it back when it ends.
- **A tray app** on the GPU PC starts the worker and shows the card, the running job, the queue (drag to reorder) and
  the history.
- **Generic.** Job types are packs on the worker PC (`types/`): a contract (inputs, a strict parameter schema) and a
  command. The server offers exactly what the worker announced; nothing else can run.
- **Safe by construction.** No shell, no arbitrary commands: arguments are built from validated values only; tools
  never run the content of an input (Blender's auto-run scripts stay off). Clients see only their own jobs and files.
- **Windows and Linux** for the worker; the server is one Docker image.

## Run the server

```sh
docker run -d --name fornax -p 127.0.0.1:3000:3000 -v fornax-data:/data \
  -e FORNAX_SECRET="$(openssl rand -base64 48)" -e PUBLIC_URL=https://fornax.example.com \
  ghcr.io/<owner>/fornax:latest
```

Configuration is environment variables only; `.env.example` lists every one with an example value, and
`compose.example.yaml` is a local starting point. The important ones:

| Variable | Default | Meaning |
|---|---|---|
| `FORNAX_SECRET` | – (required) | at least 32 random characters; signs upload, download and result links |
| `PUBLIC_URL` | `http://localhost:<PORT>` | the public address, scheme and host only |
| `DATA_DIR` | `/data` | the SQLite database `fornax.db` and the job files `files/` |
| `TRUST_PROXY` | `0` | how many reverse proxies may set `X-Forwarded-*` |
| `FORNAX_MAX_UPLOAD_MB` | `4096` | largest input file |
| `FORNAX_WEBHOOK_PREFIXES` | empty (off) | allowed `callback_url` prefixes, comma-separated, each ending with `/` |
| `TZ` | the system's (UTC in the image) | the time zone of times in sentences (job notes, the result page), e.g. `Europe/Bratislava`; data fields stay ISO 8601 in UTC |
| `FORNAX_WORKER_ZIP` | the image's `downloads/fornax-worker.zip` | the worker bundle served at `/downloads/fornax-worker.zip`; leave it empty in the image |
| `FORNAX_TRAY_MSI`, `FORNAX_TRAY_DEB` | the image's `downloads/fornax-tray.msi` and `.deb` | the tray's installers served at `/downloads/fornax-tray.msi` and `.deb`; leave them empty in the image |

The image runs as a non-root user (any UID works), writes only to `DATA_DIR` and `/tmp`, migrates its database at
start, answers `GET /healthz` (health command in the image: `node /app/dist/src/healthcheck.js`), and stops within
seconds on `SIGTERM`.

### Behind a reverse proxy

Fornax expects TLS in front of it and must be served at the root of `PUBLIC_URL`. For the proxy:

- **Do not log secrets in URLs.** These paths carry a token or a signature: `/mcp/<token>`, `/r/<signed>`,
  `/api/uploads/<signed>`, `/pair/<invite>` and any `?sig=` query. Mask them or keep them out of the access log.
  Fornax's own log never contains them.
- **Large bodies and slow requests:** allow request bodies up to `FORNAX_MAX_UPLOAD_MB` and long uploads (GBs);
  an output upload from the worker may take ~30 s while the server makes its preview.
- **Webhooks go out directly:** Node's `fetch` ignores `HTTP(S)_PROXY`, so the container needs a route to the
  callback hosts.
- Give the container ~1 GB of memory (previews of large images are decoded in memory) and a stop grace period of at
  least 15 s.

### Administration

`fornax-admin` runs inside the container (`docker exec fornax fornax-admin …`):

```
fornax-admin tokens invite <name> [--worker]   an invite link (client) or the pair command (worker), valid 24 h
fornax-admin tokens pending | list
fornax-admin tokens approve <name>             after comparing the fingerprint with its holder
fornax-admin tokens revoke <name>              also cancels the token's queued and running jobs
fornax-admin tokens uninvite <name>            removes an unused invite
fornax-admin backup <dir>                      a consistent database copy and the job files
```

`backup` is safe while the server runs. `<dir>` must be new or empty and outside `DATA_DIR/files`; a failure prints
one line and exits 1. A backup written into the data volume is lost with it, so move it out afterwards:

```sh
docker exec fornax fornax-admin backup /data/backups/2026-11-14
docker cp fornax:/data/backups/2026-11-14 ./fornax-backup-2026-11-14
docker exec fornax rm -r /data/backups/2026-11-14
```

or give the container a second mount for backups (e.g. `-v fornax-backups:/backups`, then
`fornax-admin backup /backups/2026-11-14`).

Job files are kept 14 days after a job finishes (`FORNAX_FINISHED_DAYS`); the database holds tokens and jobs.

## Connect a client

1. The admin runs `fornax-admin tokens invite alice` and sends Alice the link.
2. Alice opens it. The page makes her token **in her browser** (it is never sent anywhere) and shows:
   - for Claude Code: `claude mcp add fornax --scope user --transport http https://fornax.example.com/mcp --header "Authorization: Bearer <token>"`
   - for claude.ai and other clients without custom headers: the connector URL `https://fornax.example.com/mcp/<token>`
     (treat it like a password)
   - a fingerprint such as `7K2F-9QXA`.
3. Alice's first request registers the token as pending; the admin compares the fingerprint
   (`fornax-admin tokens pending`) and runs `fornax-admin tokens approve alice`.

MCP tools: `list_job_types`, `create_upload`, `submit_job`, `get_job`, `get_output`, `list_jobs`, `cancel_job`,
`queue_status`. Large files go through `create_upload`, which returns a one-time link and a ready `curl -T` command
(`curl --fail-with-body` needs curl 7.76 or newer; use `-f` with an older one). Agents pass `agent` with `submit_job`
(the name other agents reach them by): every client sees who runs and who waits, so whoever waits knows whom to ask.

`get_job` takes `wait_seconds` (up to 25) and the `change` of the previous answer and then answers as soon as the job
changes. While a job waits, `note` says why in one sentence (the worker is offline, the type is not offered, other
programs hold the GPU, or the jobs ahead of it).

### REST API

All with `Authorization: Bearer <token>`:

| Method and path | Purpose |
|---|---|
| `GET /api/types` | offered job types with their schemas |
| `POST /api/files?name=<file name>` | upload a file (streamed body) → `{id, name, size, …}` (`id` is the file id for `inputs`) |
| `POST /api/uploads` | a one-time upload link (`PUT /api/uploads/<signed>`, no token) |
| `POST /api/jobs` | submit `{type, params, inputs, priority?, group?, agent?, callback_url?}`; `priority` is `high`, `normal` or `idle` (`low` is taken as `normal`), without it the type's `default_priority`; `agent` is the name other agents reach you by (at most 80 characters: ASCII letters and digits, space and `. _ : / -`, not starting with `-` or a space, not ending with a space), shown to every client |
| `GET /api/jobs`, `GET /api/jobs/:id` | list, details, outputs, result page link; one job also has `worker` and `note` (why it waits) |
| `GET /api/jobs/:id?wait=25&change=<change>` | answers as soon as the job's `change` differs (at the latest after `wait` seconds, at most 30): wait instead of polling |
| `POST /api/jobs/:id/cancel` | cancel |
| `POST /api/jobs/:id/priority` | body `{"priority":"high"}` (`normal`, `idle`); a waiting job of yours, placed as if it were new |
| `POST /api/jobs/:id/requeue` | body `{"idle":false}` or `{"idle":true}`; a running job of yours back to the queue (or to Idle); it starts again from the beginning |
| `GET /api/jobs/:id/outputs/<name>` | download (or with a signed `?sig=` link, no token) |
| `GET /api/queue` | queue summary: counts, the running job (`current`, with `agent`, `owner`, `label`) and `ahead`, the waiting jobs in queue order (at most 20) with who submitted them; `?job_id=<your job>` lists only the jobs before it, and `ahead` is `null` when that job has no place in the queue (it runs, has finished, is idle or its type is not offered) |

Another client's job or file answers `404`.

The worker's token also opens the operator's routes, for whoever runs the worker (the tray uses them): they see and
order the whole queue, every client's jobs included, and none of them counts as a sign of life of the worker.

| Route | What it does |
|---|---|
| `GET /api/worker/jobs?wait=<0..30>&change=<hash>` | The paused flag, the worker, the running job, the waiting jobs in the order they run, the last 50 finished jobs. With `change` and `wait` it answers as soon as something changes. |
| `POST /api/worker/jobs/<id>/move` | Body `{"to":"top"}`, `{"to":"bottom"}`, `{"before":"<id>"}` or `{"after":"<id>"}`; only waiting jobs move (409 otherwise). |
| `POST /api/worker/jobs/<id>/cancel` | Cancels a job of any client. |
| `POST /api/worker/jobs/<id>/priority` | Body `{"priority":"high"}` (`normal`, `idle`): a waiting job of any client gets a new priority. |
| `POST /api/worker/jobs/<id>/requeue` | Body `{"idle":false}` or `{"idle":true}`: a running job of any client goes back to the queue (Requeue) or to Idle (Pause). |
| `POST /api/worker/idle/start` | Start all: every idle job becomes normal, at the end of the normal ones. |
| `PUT /api/worker/pause` | Body `{"paused":true}` or `{"paused":false}`. While paused the running job finishes and no other starts; `GET /api/queue` and `queue_status` show `paused`. |

Priorities are `high`, `normal` and `idle`. A new job joins the queue right after the last waiting job of its priority
or higher, so without moves high jobs run first in the order they came, then normal ones. An idle job never starts by
itself: the worker's operator starts it (the tray's Idle block, `fornax queue start-idle`) or its client sets normal or
high. A job submitted without a priority gets its type's `default_priority` (`upscale`: idle). A job that ran and comes
back (the worker stopped, an attempt failed) goes to the top; a job put back with Requeue goes right after the waiting
jobs of a higher priority, and Pause puts it at the top of Idle.

### Webhooks

With `callback_url` (allowed by `FORNAX_WEBHOOK_PREFIXES`), Fornax posts `{"job_id": "…", "state": "succeeded"}`
when a job ends, signed with a key derived from your token:

```js
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

const key = Buffer.from(hkdfSync('sha256', token, Buffer.alloc(0), 'fornax-webhook', 32));
function verified(headers, rawBody) {
  const expected = `sha256=${createHmac('sha256', key).update(`${headers['x-fornax-timestamp']}.${rawBody}`).digest('hex')}`;
  const got = String(headers['x-fornax-signature'] ?? '');
  return got.length === expected.length && timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}
```

Deliveries are **at least once** (attempts at once, after 1 and after 5 more minutes; redirects are never
followed): deduplicate on `job_id`, and read the job's state from the API instead of trusting the body.

## Run the worker

On the PC with the GPU (Windows or Linux, Node.js 22 or newer):

1. Download the worker from your server (`https://fornax.example.com/downloads/fornax-worker.zip`) or from the
   GitHub releases, unzip it and install it: `node fornax-worker/fornax.mjs install`. It goes to
   `%LOCALAPPDATA%\fornax\app` (Linux: `~/.local/share/fornax/app`, with the command `~/.local/bin/fornax`) and
   `fornax` is put on your PATH: open a new terminal. The unzipped folder can be deleted.

   On Windows the folder is added to your user Path, which keeps its registry kind (`REG_EXPAND_SZ`) and its `%VAR%`
   entries as they were. On Linux `~/.local/bin/fornax` is a link to the installed `fornax`; when `~/.local/bin` is
   not on your PATH yet, `install` says how to add it.
2. The admin runs `fornax-admin tokens invite pc --worker`, which prints the command to run on the PC:
   `fornax worker pair --server https://fornax.example.com --name pc`. Approve its fingerprint on the server.
3. Put the tool paths into `worker.yaml` (`%APPDATA%\fornax\` on Windows, `~/.config/fornax/` on Linux):

   ```yaml
   server: https://fornax.example.com
   tools:
     python: python3
     ffmpeg: ffmpeg
     ffprobe: ffprobe
     blender: /usr/bin/blender
   ```

4. Install job types and check them: `fornax types install transcribe`, `fornax types install render`,
   `fornax types install upscale` (needs ffprobe in `worker.yaml`), `fornax types install tts`, `fornax types install document-parse`, `fornax doctor`. The `render` pack (Cycles or Eevee) needs scenes
   that are self-contained (File > External Data > Pack Resources); Eevee needs a worker in a signed-in user's session.
5. Start it: `fornax worker`. Ctrl+C gives the running job back; a second Ctrl+C kills the tool.

Some types download models that need an account's token (`transcribe`'s speaker recognition needs a Hugging Face
token): store it with `fornax secrets set HF_TOKEN` (it asks without showing what you type, except in Git Bash's own
window, which cannot hide it: use Windows Terminal or PowerShell there; `--from-file <path>` reads a file), then run the setup again with the worker stopped: `fornax types setup transcribe`. Secrets live in
`<config>/secrets/`, only the setup of a pack that asks for one gets it, and they never reach the server.
`fornax secrets list` shows the names, `fornax secrets remove <NAME>` deletes one.

### Watching and ordering the queue

On the worker's PC (it uses the worker's token) `fornax queue` shows the whole queue: whether it is paused, the
running job with its time and progress, the waiting jobs in the order they will run, the last finished ones.

- `fornax queue move <id> --top` (or `--bottom`, `--before <id>`, `--after <id>`) changes the order of waiting jobs.
- `fornax queue cancel <id>` cancels a job of any client.
- `fornax queue priority <id> high|normal|idle` changes the priority of a waiting job; `fornax queue start-idle` starts
  every idle job; `fornax queue requeue <id>` stops the running job and puts it back in the queue (`--idle`: into Idle).
  All three take `--json` like pause and resume.
- `fornax queue pause` lets the running job finish and starts no other; `fornax queue resume` goes on. With `--json`
  both print the queue the server answered with, like `fornax queue --json`.
- `fornax queue --json` prints the same as one line of JSON (`"ok": true` and the fields of `GET /api/worker/jobs`;
  `paused_at` says since when the queue is paused).
- `fornax queue --watch` prints the queue again after every change (with `--json`, one line each; with `--json` it
  also ends when its standard input closes, which is how a program that reads it stops it).

`fornax worker --events` runs the worker for a program that controls it (the tray): standard output carries only JSON
lines (`{"event":"started","version","pid"}`, `{"event":"log","line"}`,
`{"event":"types","types":[{"name","state","reason"}]}` with the state `offered`, `waiting` (for the card) or
`unavailable`, `{"event":"restarting"}`, `{"event":"stopped","code"}`), and a line `stop` on standard input stops it
like Ctrl+C (a second one at once; closing standard input is one stop).

### Updating

`fornax update` installs the version your server offers (`fornax doctor` and the worker say when it differs). It
checks the download's size and SHA-256 against what the server announces; on a mismatch nothing is changed. It
brings the installed built-in types up to date (their `env/` stays; a type's setup runs again only when the type
changed what it installs) and mentions new built-in types (`fornax types install <name>`); types installed with
`--from` are left alone. A running `fornax worker` finishes its job and restarts on the new version in the same
window when it was started from the installed copy (a worker started from the unzipped folder prints what to do
instead): it restarts between jobs, so a running job or lease finishes first, and an idle worker restarts within about
25 s.

`--force` installs the offered version again even when you have it (the worker does not restart for the same
version); `--server <url>` asks that server instead of the one in `worker.yaml`. `fornax update` refuses a version
older than 0.3.0, which could not restart into a newer one: install such a version by hand from
`<server>/downloads/fornax-worker.zip`.

The server's image also carries the tray's installers of its version: `<server>/downloads/fornax-tray.msi` and `.deb`,
described by `<server>/downloads/fornax-tray.json` (version, SHA-256 and size of each); `fornax tray install` and the
tray's update use them.

To uninstall, delete the `app` folder and remove it from your Path (Linux: `~/.local/bin/fornax`).

### Your own job types

`fornax types add <name>` creates an empty pack and copies a prompt for Claude Code that builds the rest with you;
the format is in [types/README.md](types/README.md).

### The GPU belongs to the queue

**Check the card before each job.** With `gpu.max_used_mib` in `worker.yaml` the worker reads the whole card's memory
in use (`nvidia-smi`) before it takes a job, and takes none while more than that is in use (another program on the
card, e.g. Blender started by hand) or while the card cannot be read; `queue_status` then says why nothing runs. The
key has no default: without it nothing is checked. `fornax doctor` shows the card and suggests a value (what is in use
now plus some room):

```yaml
gpu:
  max_used_mib: 2048
```

A worker that starts while the card cannot be read (an external GPU attached after sign-in) waits for it before it
checks its job types, and checks them again whenever the card comes back, so the types that need the card are
offered without a restart. Meanwhile the server keeps the types the worker offered last and takes jobs for them.

**Lease the card for a program on this PC.** `fornax types install lease`, then store a client token (the worker
token cannot submit jobs):

1. The admin runs `fornax-admin tokens invite <name>`; you make the token on the pairing page.
2. `fornax lease token` reads it from standard input (paste it, or pipe it in) and checks it with the server. A new
   token waits for approval, so this first check only registers it and nothing is saved.
3. The admin compares the fingerprint (`fornax-admin tokens pending`) and runs `fornax-admin tokens approve <name>`.
4. Run `fornax lease token` again: now the token is saved.

`FORNAX_CLIENT_TOKEN` wins over the stored file. Then:

```
fornax lease [--minutes N] [--wait-minutes N] [--rerun] [--priority high|normal|idle] [--label TEXT] [--agent NAME] -- <program> [args…]
fornax lease -- blender.exe -b scene.blend -f 1
```

The program waits for the card in queue order like any job, then runs here with your terminal, working directory and
environment (plus `FORNAX_LEASE=<job id>`, without the client token), and gives the card back when it ends. Give the
program itself, not a `.cmd`/`.bat` launcher (there is no shell); a launcher or a program that is not found ends
`fornax lease` before any job is made. `--minutes` (default 60, at most 720) is the longest one run may take;
`--wait-minutes` gives up waiting for the card; `--label` names the lease in the queue (default: the program's file
name). `--agent` (or the variable `FORNAX_AGENT`, which the program keeps) names who asks for the lease; every client
sees it next to the job. Its own lines go to stderr and start with `fornax lease:` (a usage error is followed by the usage);
`fornax lease --help` prints the usage to stdout. Everything else on stdout is the program's.

`fornax lease` inside a lease runs its program at once, under the outer lease. It needs the stored client token
(`fornax lease token`): `FORNAX_CLIENT_TOKEN` is removed from the program's environment, so it does not reach a nested
`fornax lease` either.

On Windows, `fornax.cmd` passes the arguments through `cmd`, which interprets unquoted `&`, `|`, `<`, `>` and `^`, and
a Ctrl+C there asks "Terminate batch job (Y/N)?". In scripts, and for arguments with such characters, call Node
directly: `node %LOCALAPPDATA%\fornax\app\fornax.mjs lease -- …`.

On Linux the program runs in a session of its own (so that its whole process tree can be ended), so it has no
controlling terminal: whatever opens `/dev/tty` (password prompts of `sudo`, `ssh` or `getpass`), job control
(Ctrl+Z) and terminal resize signals do not work; reading the standard input it inherits works. A nested
`fornax lease` runs its program in the caller's process group instead. If `fornax lease` itself is killed on Linux
(`kill -9`, the out-of-memory killer), its program goes on running, and the lease ends about 60 s later while the
program may still use the card.

| Exit code | Meaning | The program |
|---|---|---|
| 120 | usage error, or the program cannot start (not found, `.cmd`/`.bat`) | not started |
| 121 | no lease: no client token, a bad `FORNAX_CLIENT_TOKEN`, a missing or invalid `worker.yaml`, the token was refused, `lease` is not offered, the submit was refused, the lease files cannot be written | not started |
| 122 | gave up waiting (`--wait-minutes`) | not started |
| 123 | the lease was lost: canceled, failed, `--minutes` ran out; without `--rerun` also a stop or restart of the worker | stopped or not started |
| 130 | interrupted (Ctrl+C, `SIGTERM`, `SIGHUP`, `SIGQUIT`) | stopped |
| other | the program's own code (128 + the signal's number when a signal ended it) | finished |

`fornax lease` stops on Ctrl+C, `SIGTERM`, `SIGHUP` (a closed terminal) and `SIGQUIT` (Ctrl+\) alike. On Linux the
signal itself is passed on to the program (its session does not get the terminal's signals); on Windows the program
gets Ctrl+C from the same console. The program has 10 s to end before it is killed; a second Ctrl+C kills it at once.
A stop while waiting cancels the job (a second Ctrl+C then waits up to 3 s for that cancel).

Stopping or restarting the worker stops a leased program. With `--rerun` (for a program that is safe to start again,
e.g. one that continues after the frames it has) it starts again once the worker runs again; without it `fornax lease`
ends with 123. A program never starts without a lease: while the server cannot be reached, `fornax lease` keeps
trying and waits, and only `--wait-minutes` (122) or a stop (130) ends that wait. A program that already runs goes on
while the server is unreachable, but only for so long: after 10 minutes without the worker the server takes the job
back (it returns to the queue, or fails), and once the server can be reached again `fornax lease` stops the program
(123, or with `--rerun` it starts again when the lease returns).

### As a service

- **Linux (systemd user unit)**, `~/.config/systemd/user/fornax-worker.service`:

  ```ini
  [Unit]
  Description=Fornax worker
  After=network-online.target

  [Service]
  ExecStart=%h/.local/bin/fornax worker
  Restart=on-failure
  KillMode=mixed
  TimeoutStopSec=30

  [Install]
  WantedBy=default.target
  ```

  `KillMode=mixed`: systemd sends SIGTERM to `fornax worker` only, which passes it on to the worker once (with
  `control-group` the worker would get it twice and quit at once instead of giving its job back); whatever is still
  running after the stop timeout is killed. The same holds outside systemd: a signal sent to both processes at once
  (`killall`, `pkill -f fornax`) counts as two stops and quits at once. When `fornax worker` itself is killed, the
  worker stops by itself as after a first Ctrl+C.

  Then `systemctl --user enable --now fornax-worker` (and `loginctl enable-linger <user>` to run without a login).
- **Windows:** a Task Scheduler task "At log on" running `%LOCALAPPDATA%\fornax\app\fornax.cmd worker`. Fornax ends a
  job's whole process tree when it stops; a process that detached from that tree (rare) survives a crash of the worker.

## Tray app

On the worker's PC the tray app starts the worker and shows the card and the whole queue. The header shows the
worker's state (with Pause queue and Start/Stop worker), the GPU strip the card's memory, load and temperature and who
holds it (a job, a lease, or programs outside Fornax, with when the next job starts), Running the job with its
progress and time left (or the lease, with Revoke), Waiting the jobs in the order they will run (drag them, or use ⤒
and ⤓ on hover), and the tabs History (today's and yesterday's finished jobs, their result page and error) and Worker
log. The arrow next to the tabs hides their content (a click on a tab shows it again), and the window becomes as high
as what it still shows; the window remembers its size, its place and whether the tabs are open (`tray-window.json` in
`%LOCALAPPDATA%ornax` or `~/.local/share/fornax`). Pause queue lets
the running job finish and starts no other; Stop worker gives the running job back to the queue. It tells you when a
job fails, and when jobs wait while the worker is stopped or the queue is paused. The footer lists the job types the
worker offers, the ones waiting for the card (dimmed) and the ones whose check failed (red, click for the reason); the
icon turns orange while the worker waits for the card and violet while a lease holds it. The card is read with
`nvidia-smi` while the window is open.

1. Install `fornax` 0.5.0 or newer and pair this PC (see [Run the worker](#run-the-worker)); the tray runs the
   installed `fornax.mjs` with Node.js 22 or newer.
2. Install it with `fornax tray install` (fornax 0.7.0 or newer): it downloads the installer of your server's version
   (the `.msi` on Windows, the `.deb` on Ubuntu), checks it and runs it (Windows asks through UAC, Ubuntu for your
   password). Or download it from the GitHub release: the `.msi` (it is not signed: SmartScreen asks, choose More info,
   Run anyway), the `.deb` or the `.AppImage` on Ubuntu (they need `libwebkit2gtk-4.1-0` and
   `libayatana-appindicator3-1`, the `.AppImage` also `libfuse2`, on Ubuntu 24.04 `libfuse2t64`; GNOME shows tray
   icons with the AppIndicator extension, which Ubuntu enables).
3. Start it once and tick Start at sign-in in its menu. At sign-in it starts without its window and starts the
   worker. A worker you started yourself in a terminal shows as "Worker runs outside the tray"; stop it there if the
   tray should own it.

Settings, all optional, go in `tray.json` next to `worker.yaml` (`%APPDATA%\fornax\tray.json` on Windows,
`~/.config/fornax/tray.json` on Linux): `{"node": "<path to node>", "start_worker": true}`. The menu item Start
worker with the tray writes `start_worker`.

The window shows the versions of the tray, of `fornax` and of the server. When the server is newer it offers
**Update to …** (in the window and the menu): the tray pauses the queue, lets the running job finish, runs
`fornax update`, then `fornax tray install --wait-pid <its pid> --relaunch <its path>` installs the new tray once the old
one has quit and starts it again (also when the installation was cancelled); the new tray says how it went and resumes
the queue. When only `fornax` is older it offers **Update fornax to …**. A tray from the AppImage updates only `fornax`;
get a new AppImage from the GitHub release.

Quit stops the worker first; its running job goes back to the queue. A tray started by the Windows installer starts
itself once more through Explorer, so that tools installed through folder links (scoop) work for the worker. To remove
the tray, uninstall Fornax tray in the Windows settings, or `sudo apt remove fornax-tray`.

## Security

- Tokens are stored as SHA-256 hashes; a client token sees only its own jobs and files; a worker token cannot use the
  client API and the other way round.
- Jobs run only types the worker announced, with parameters checked against a strict schema on the server and again on
  the worker; arguments never pass through a shell; strings may not start with `-`.
- Upload, download and result links are signed, expire, and stop working when their token is revoked.
- Worker secrets (`fornax secrets`) stay on the worker PC: only the setup of a pack that declares one gets it, no tool
  inherits a variable of that name, and its value is masked in the setup's output.
- Accepted risk: the worker token sees every client's inputs (one worker on its owner's PC).

## Development

```sh
pnpm install
pnpm typecheck        # strict compiler checks double as the lint step
pnpm test             # all packages, then the type packs' Python tests (needs Python 3.10+)
pnpm bundle:worker    # dist/worker/fornax-worker-<version>.zip
pnpm --filter @fornax/tray test:rust   # the tray's window build and Rust tests
```

`pnpm test` also checks the landing page in `site/` (`scripts/site.test.mjs`: files, anchors, README links, image
sizes, nothing private). Its screenshots come from invented data only: `node scripts/site-shots.mjs` photographs the
tray preview (`pnpm --filter @fornax/tray preview` running) and the link-preview image, and
`FORNAX_SITE_SHOT=1 pnpm --filter @fornax/server exec vitest run test/site-shot.test.ts` the result page of an
invented job. GitHub Pages publishes `site/` from `main` (`.github/workflows/pages.yml`).

`pnpm test` leaves the tray out; its check, `pnpm --filter @fornax/tray test:rust`, needs Rust 1.90+ and, on Linux,
the Tauri packages listed in `.github/workflows/ci.yml`.

CI runs the tests on Ubuntu and Windows, builds and smoke-tests the Docker image, tests the tray and builds its
installers on Windows and Ubuntu 22.04, publishes the image to GHCR from `main`, and attaches the worker zip and the
tray installers to a release for every `v<version>` tag.

Related: [Tabula](https://github.com/carnaby/tabula-mcp), the memory server whose transcription worker Fornax grows out of.

## License

MIT
