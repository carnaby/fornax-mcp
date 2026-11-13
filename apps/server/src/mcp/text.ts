/** What every MCP client is told on initialize (spec 8.1). */
export const SERVER_INSTRUCTIONS = [
  'Fornax is a job queue for one GPU worker: you submit jobs of the types the worker offers, it runs them one at a time, and you fetch the results.',
  'Start with list_job_types: each type has a description, a parameter schema, its inputs (allowed extensions, size limit) and a max runtime; it also says whether the worker is online.',
  'Input files never travel through MCP. For each input call create_upload with the file name: it returns a file_id and a curl command with a one-time link valid for 1 hour. Run that command with the local file path in place of <path>; in Windows PowerShell call curl.exe instead of curl (curl there is another command). If you cannot run commands (e.g. in claude.ai), give the user the command to run on their computer and wait until they say it finished. If curl reports a connection reset instead of an HTTP status, the file is most likely larger than the upload limit of the server.',
  'Then call submit_job with the type, params and inputs (input name to file_id) and poll get_job until the state is succeeded, failed or canceled. Jobs wait while others run; queue_status shows the queue.',
  'get_output returns an image output as a preview image plus a download link, a text or JSON output of up to 60 kB as text (of a longer log its last 60 kB), and anything else as a download link valid for 24 hours. get_job also gives result_url, a page the user can open in a browser.',
  'You see only your own jobs and files.',
].join('\n');

export const TOOL_DESCRIPTIONS = {
  list_job_types:
    'The job types the worker offers now: description, parameter schema (a JSON Schema subset), inputs with allowed extensions and size limits, max runtime; and whether the worker is online. Call it before submit_job.',
  create_upload:
    'A one-time upload link (valid 1 hour) for one input file. Returns file_id, the link and a ready curl command: run it with the local path in place of <path> (curl.exe in Windows PowerShell; if you cannot run commands, give it to the user), then pass file_id to submit_job.',
  submit_job:
    "Queue a job of an offered type. params must match the type's schema (defaults are filled in); inputs maps each input name to a file_id from create_upload. Returns job_id and the place in the queue.",
  get_job:
    'One of your jobs: state (queued, running, succeeded, failed, canceled), progress, error, type_unavailable; when finished, its outputs and log. result_url is a page for the user to open in a browser.',
  get_output:
    'One file of a finished job by name (an output, its preview, or the log): an image comes back as a preview image (at most 2000 px per side) plus a download link, text or JSON up to 60 kB as text (a longer log as its last 60 kB), anything else as a download link valid 24 hours.',
  list_jobs: 'Your jobs, newest first; filter by state or group.',
  cancel_job: 'Cancel one of your jobs. A queued job is canceled at once; a running one is stopped by the worker at its next heartbeat (within about 30 seconds).',
  queue_status: 'The whole queue: how many jobs wait and run, whether the worker is online, and the type and progress of the running job.',
} as const;
