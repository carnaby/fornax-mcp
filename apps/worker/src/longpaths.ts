// Windows long paths (deferred 0.14.1): PYTHONPYCACHEPREFIX (spec 12 § 5.8) puts a pack's bytecode under
// <pack>/env/pycache/<full source path>, which doubles the path's depth. Without LongPathsEnabled, Python cannot write
// the deepest .pyc files (about 260 characters) and compiles those modules again on every job.
import { execFile } from 'node:child_process';

const KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem';

/** Whether `reg query <KEY> /v LongPathsEnabled` says 1; a missing value is off, as Windows reads it. */
export function longPathsOf(regOutput: string): boolean {
  return /LongPathsEnabled\s+REG_DWORD\s+0x0*1\b/i.test(regOutput);
}

/** On Windows whether long paths are on; null elsewhere or when reg cannot be run. */
export function windowsLongPaths(): Promise<boolean | null> {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('reg', ['query', KEY, '/v', 'LongPathsEnabled'], { windowsHide: true, timeout: 5000 }, (error, stdout) => {
      // reg exits 1 when the value does not exist: then Windows treats long paths as off.
      if (error && typeof error.code !== 'number') resolve(null);
      else resolve(longPathsOf(String(stdout)));
    });
  });
}

/** The command that turns long paths on (as administrator; programs started afterwards see it). */
export const LONG_PATHS_ON = `reg add ${KEY} /v LongPathsEnabled /t REG_DWORD /d 1 /f`;
