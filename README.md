# Fornax

**A GPU job queue served over MCP.** One worker on a PC with a GPU owns the card; agents and apps on other machines
send it jobs (transcription, rendering, and any type you add) and get the results back with a manifest.

*Fornax* is Latin for an oven, and the name of a constellation.

Status: an early release (0.2). The API may still change.

```
agent (MCP) ─┐                    ┌─ fornax worker on the GPU PC (pulls jobs; no open port)
             ├──► Fornax server ◄─┤
app (REST) ──┘   queue, files,    └─ type packs: transcribe, render, your own
                 result pages
```

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
(`curl --fail-with-body` needs curl 7.76 or newer; use `-f` with an older one).

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
| `POST /api/jobs` | submit `{type, params, inputs, priority?, group?, callback_url?}` |
| `GET /api/jobs`, `GET /api/jobs/:id` | list, details, outputs, result page link; one job also has `worker` and `note` (why it waits) |
| `GET /api/jobs/:id?wait=25&change=<change>` | answers as soon as the job's `change` differs (at the latest after `wait` seconds, at most 30): wait instead of polling |
| `POST /api/jobs/:id/cancel` | cancel |
| `GET /api/jobs/:id/outputs/<name>` | download (or with a signed `?sig=` link, no token) |
| `GET /api/queue` | queue summary |

Another client's job or file answers `404`.

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
   GitHub releases, and unzip it. Run it as `fornax` (Linux) or `fornax.cmd` (Windows), or `node fornax.mjs`.
2. The admin runs `fornax-admin tokens invite pc --worker`, which prints the command to run on the PC:
   `fornax worker pair --server https://fornax.example.com --name pc`. Approve its fingerprint on the server.
3. Put the tool paths into `worker.yaml` (`%APPDATA%\fornax\` on Windows, `~/.config/fornax/` on Linux):

   ```yaml
   server: https://fornax.example.com
   tools:
     python: python3
     ffmpeg: ffmpeg
     blender: /usr/bin/blender
   ```

4. Install job types and check them: `fornax types install transcribe`, `fornax types install render`,
   `fornax doctor`. The `render` pack needs scenes that are self-contained (File > External Data > Pack Resources).
5. Start it: `fornax worker`. Ctrl+C gives the running job back; a second Ctrl+C kills the tool.

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

**Lease the card for a program on this PC.** `fornax types install lease`, then store a client token (the worker
token cannot submit jobs): the admin runs `fornax-admin tokens invite <name>`, you make the token on the pairing page,
and `fornax lease token` reads it from standard input (paste it, or pipe it in) and checks it. `FORNAX_CLIENT_TOKEN`
wins over the stored file. Then:

```
fornax lease [--minutes N] [--wait-minutes N] [--rerun] [--priority low|normal|high] [--label TEXT] -- <program> [args…]
fornax lease -- blender.exe -b scene.blend -f 1
```

The program waits for the card in queue order like any job, then runs here with your terminal, working directory and
environment (plus `FORNAX_LEASE=<job id>`, without the client token), and gives the card back when it ends. Give the
program itself, not a `.cmd`/`.bat` launcher (there is no shell); a launcher or a program that is not found ends
`fornax lease` before any job is made. `--minutes` (default 60, at most 720) is the longest one run may take;
`--wait-minutes` gives up waiting for the card; `--label` names the lease in the queue (default: the program's file
name); `fornax lease --help` prints the usage. `fornax lease` inside a lease runs its program at once, under the outer
lease. Its own lines go to stderr, starting with `fornax lease:`; stdout is the program's.

On Linux the program runs in a session of its own (so that its whole process tree can be ended): it has no controlling
terminal, so interactive prompts and `/dev/tty` do not work; piped standard input works. A nested `fornax lease` runs
its program in the caller's process group instead.

| Exit code | Meaning | The program |
|---|---|---|
| 120 | usage error, or the program cannot start (not found, `.cmd`/`.bat`) | not started |
| 121 | no lease: no client token, the token was refused, `lease` is not offered, the submit was refused | not started |
| 122 | gave up waiting (`--wait-minutes`) | not started |
| 123 | the lease was lost: canceled, failed, `--minutes` ran out; without `--rerun` also a stop or restart of the worker | stopped or not started |
| 130 | interrupted (Ctrl+C, `SIGTERM`, `SIGHUP`) | stopped |
| other | the program's own code (128 + the signal's number when a signal ended it) | finished |

A stop of `fornax lease` (Ctrl+C, `SIGTERM`; `SIGHUP`, a closed terminal, counts as `SIGTERM`) is passed on to the
program, which gets 10 s to end before it is killed; a second Ctrl+C kills it at once. A stop while waiting cancels
the job.

Stopping or restarting the worker stops a leased program. With `--rerun` (for a program that is safe to start again,
e.g. one that continues after the frames it has) it starts again once the worker runs again; without it `fornax lease`
ends with 123. A program never runs without a lease: while the server cannot be reached, `fornax lease` keeps trying
and waits, and only `--wait-minutes` (122) or a stop (130) ends that wait. A program that already runs goes on while the server is
unreachable.

`fornax types add <name>` creates an empty pack and copies a prompt for Claude Code that builds the rest with you;
the format is in [types/README.md](types/README.md).

### As a service

- **Linux (systemd user unit)**, `~/.config/systemd/user/fornax-worker.service`:

  ```ini
  [Unit]
  Description=Fornax worker
  After=network-online.target

  [Service]
  ExecStart=/opt/fornax-worker/fornax worker
  Restart=on-failure
  # Stop every process of the job with the worker, also ones a tool left behind.
  KillMode=control-group
  TimeoutStopSec=30

  [Install]
  WantedBy=default.target
  ```

  then `systemctl --user enable --now fornax-worker` (and `loginctl enable-linger <user>` to run without a login).
- **Windows:** a Task Scheduler task "At log on" running `fornax.cmd worker` in the unzipped folder. Fornax ends a
  job's whole process tree when it stops; a process that detached from that tree (rare) survives a crash of the worker.

## Security

- Tokens are stored as SHA-256 hashes; a client token sees only its own jobs and files; a worker token cannot use the
  client API and the other way round.
- Jobs run only types the worker announced, with parameters checked against a strict schema on the server and again on
  the worker; arguments never pass through a shell; strings may not start with `-`.
- Upload, download and result links are signed, expire, and stop working when their token is revoked.
- Accepted risk: the worker token sees every client's inputs (one worker on its owner's PC).

## Development

```sh
pnpm install
pnpm typecheck        # strict compiler checks double as the lint step
pnpm test             # all packages, then the type packs' Python tests (needs Python 3.10+)
pnpm bundle:worker    # dist/worker/fornax-worker-<version>.zip
```

CI runs the tests on Ubuntu and Windows, builds and smoke-tests the Docker image, publishes it to GHCR from `main`,
and attaches the worker zip to a release for every `v<version>` tag.

Related: [Tabula](https://github.com/carnaby/tabula-mcp), the memory server whose transcription worker Fornax grows out of.

## License

MIT
