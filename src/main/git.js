// The Git changes view's git calls, read-only: the active workspace's repo, its status,
// and one file's diff as an acc://git page. Every command line is fixed in
// src/shared/git.js and runs through execFile, never a shell; a file path is used only
// when it's in the status git just reported.

import { execFile } from 'node:child_process';
import { ROOT_ARGS, STATUS_ARGS, diffAreas, diffArgs, diffLines, gitFromUrl, parseStatus } from '../shared/git.js';
import { gitDiffPage } from '../shared/docs.js';
import { childEnv, onPath } from './env.js';

const TIMEOUT_MS = 15_000;
const MAX_OUTPUT = 16 * 1024 * 1024;

/** git's full path (see onPath); null when git isn't installed. @type {string | null | undefined} */
let gitPath;
function findGit() {
  if (gitPath === undefined) gitPath = process.platform === 'win32' ? onPath('git.exe') : 'git';
  return gitPath;
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @param {{ okExit1?: boolean }} [opts] okExit1: `diff --no-index` exits 1 when the files differ
 * @returns {Promise<string>}
 */
function run(cwd, args, { okExit1 = false } = {}) {
  const git = findGit();
  if (!git) return Promise.reject(new Error("Git isn't installed, or isn't on PATH."));
  return new Promise((resolve, reject) => {
    execFile(git, args, { cwd, env: childEnv(process.env), timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT, windowsHide: true }, (err, stdout, stderr) => {
      if (!err || (okExit1 && err.code === 1)) return resolve(stdout);
      if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return reject(new Error("Git isn't installed, or isn't on PATH."));
      const line = String(stderr).split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('warning:'));
      reject(new Error(line || err.message));
    });
  });
}

/** @typedef {Awaited<ReturnType<typeof status>>} GitStatus */

/**
 * The repo the folder is in, and its status. No folder (the Default workspace) or no
 * repo comes back as `repo: null` with the reason, not as an error.
 * @param {string | null} folder
 */
export async function status(folder) {
  if (!folder) return { repo: null, noFolder: true, reason: 'Open a folder as a workspace to see its Git changes.' };
  let repo;
  try {
    repo = (await run(folder, ROOT_ARGS)).trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { repo: null, reason: /not a git repository/i.test(msg) ? `${folder} isn't in a Git repository.` : msg };
  }
  return { repo, ...parseStatus(await run(repo, STATUS_ARGS)) };
}

/**
 * The acc://git/<path>?area=… page for the workspace's repo: refused unless git lists
 * that file with that kind of change right now.
 * @param {string | null} folder
 * @param {string} url
 */
export async function diffPage(folder, url) {
  const want = gitFromUrl(url);
  if (!want) throw new Error("This address doesn't name a changed file.");
  const st = await status(folder);
  if (!st.repo || !('files' in st)) throw new Error(st.reason || 'No repository.');
  const file = st.files.find((f) => f.path === want.path);
  if (!file || !diffAreas(file).includes(want.area)) throw new Error(`${want.path} has no ${want.area} changes now. Refresh the Git tab.`);
  const out = await run(st.repo, diffArgs(want.area, file.path), { okExit1: want.area === 'untracked' });
  return gitDiffPage({ repo: st.repo, branch: st.branch, file, area: want.area, ...diffLines(out) });
}
