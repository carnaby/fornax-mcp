/** What every MCP client is told on initialize (spec 8.1). */
export const SERVER_INSTRUCTIONS = [
  'Fornax is a job queue for one GPU worker: you submit jobs of the types the worker offers, it runs them one at a time, and you fetch the results.',
  'Start with list_job_types: each type has a description, a parameter schema, its inputs (allowed extensions, size limit), a max runtime and its environment (what the worker runs it with, e.g. the Blender version: build inputs for that version, e.g. a .blend saved with the same Blender or bpy); it also says whether the worker is online.',
  'Input files never travel through MCP. For each input call create_upload with the file name: it returns a file_id and a curl command with a one-time link valid for 1 hour. Run that command with the local file path in place of <path>; in Windows PowerShell call curl.exe instead of curl (curl there is another command). If you cannot run commands (e.g. in claude.ai), give the user the command to run on their computer and wait until they say it finished. If curl reports a connection reset instead of an HTTP status, the file is most likely larger than the upload limit of the server. If curl says --fail-with-body is unknown (curl older than 7.76), use -f instead.',
  'Then call submit_job with the type, params and inputs (input name to file_id) and follow the job with get_job until the state is succeeded, failed or canceled: pass change from the previous answer and wait_seconds (up to 25), and get_job answers as soon as the job changes, instead of you asking again and again. While a job waits, note says why in one sentence (e.g. the worker is offline: then asking again changes nothing). Jobs wait while others run; queue_status shows the queue.',
  'Pass agent with submit_job: the name other agents reach you by (e.g. your session name). Every client sees it next to the job, so whoever waits knows whom to ask; queue_status shows who runs and who waits ahead.',
  'get_output returns an image output as a preview image plus a download link, a text or JSON output of up to 60 kB as text (of a longer log its last 60 kB), and anything else as a download link valid for 24 hours. get_job also gives result_url, a page the user can open in a browser.',
  'You see only your own jobs and files.',
].join('\n');

export const TOOL_DESCRIPTIONS = {
  list_job_types:
    "The job types the worker offers now: description, parameter schema (a JSON Schema subset), inputs with allowed extensions and size limits, max runtime, default priority (idle jobs wait until the worker's operator starts them), environment (what the worker runs the type with, e.g. the Blender version, or null: match your inputs to it); and whether the worker is online. Call it before submit_job.",
  create_upload:
    'A one-time upload link (valid 1 hour) for one input file. Returns file_id, the link and a ready curl command: run it with the local path in place of <path> (curl.exe in Windows PowerShell; if you cannot run commands, give it to the user), then pass file_id to submit_job.',
  submit_job:
    "Queue a job of an offered type. params must match the type's schema (defaults are filled in); inputs maps each input name to a file_id from create_upload. Returns job_id, the place in the queue, the worker's state, and note: one sentence why the job waits (e.g. the worker is offline). Use high for work someone is waiting for right now (it runs next, in order of submission); idle for batches the operator starts by hand; leave it out for the type's default. An idle job answers with a warning.",
  get_job:
    'One of your jobs: state (queued, running, succeeded, failed, canceled), progress, error, type_unavailable; when finished, its outputs and log. result_url is a page for the user to open in a browser. While the job waits, note says why and worker whether the worker is online. To follow a job, pass `change` from the previous answer and `wait_seconds` to wait for the next change instead of asking again and again.',
  get_output:
    'One file of a finished job by name (an output, its preview, or the log): an image comes back as a preview image (at most 2000 px per side) plus a download link, text or JSON up to 60 kB as text (a longer log as its last 60 kB), anything else as a download link valid 24 hours.',
  list_jobs: 'Your jobs, newest first; filter by state or group.',
  cancel_job: 'Cancel one of your jobs. A queued job is canceled at once; a running one is stopped by the worker at its next heartbeat (within a few seconds).',
  set_job_priority:
    "Change the priority of one of your waiting jobs: high (runs next, after the high jobs already waiting), normal, or idle (waits until the worker's operator starts it, or until you set normal or high again). The job is placed as if it were new; setting the priority it has changes nothing.",
  requeue_job:
    'Stop one of your running jobs and put it back in the queue (with idle: true, back as idle). It stops within a few seconds and later starts again from the beginning; the run does not count as an attempt. Leases cannot go back; cancel them instead.',
  queue_status:
    "The whole queue: how many jobs wait (queued), wait as idle until the worker's operator starts them (idle) and run, whether the worker is online, whether the worker's operator paused the queue (paused: the running job finishes, no other starts), and the running job (current): its type, label, who submitted it (agent, else the token's name in owner), progress and start time. ahead lists the waiting jobs in queue order (at most 20) with who submitted them, so you know whom to ask; with job_id, only the jobs before that job of yours, and ahead is null when that job has no place in the queue (it runs, has finished, is idle or its type is not offered). worker.waiting explains why nothing runs while jobs wait (e.g. other programs hold the GPU); its message says it in one sentence.",
} as const;

/** Spec 13 § 3: create_upload says how long the server keeps an upload no job uses (FORNAX_ORPHAN_UPLOAD_HOURS). */
export function createUploadDescription(orphanUploadMs: number): string {
  const hours = Math.round(orphanUploadMs / 3_600_000);
  return `${TOOL_DESCRIPTIONS.create_upload} A file that no job uses is deleted after ${hours} ${hours === 1 ? 'hour' : 'hours'}.`;
}

/** Short names clients show for the tools. */
export const TOOL_TITLES = {
  list_job_types: 'List job types',
  create_upload: 'Create upload link',
  submit_job: 'Submit job',
  get_job: 'Get job',
  get_output: 'Get output',
  list_jobs: 'List jobs',
  cancel_job: 'Cancel job',
  set_job_priority: 'Set job priority',
  requeue_job: 'Requeue job',
  queue_status: 'Queue status',
} as const satisfies Record<keyof typeof TOOL_DESCRIPTIONS, string>;
