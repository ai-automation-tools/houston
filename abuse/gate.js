// The release gate: `npm run gate`. Exit 0 only if the newest saved abuse run (abuse/results/)
// was a full run of every AT-nn in harness-requirements.md, every test passed, no attempt got
// through, and it ran on the code that is checked out now, committed (the fingerprint below;
// Markdown files don't count, so a docs change needs no new run).
// It runs nothing itself: `node abuse/run.js` is the run, on a real machine, and saves the record.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** What a run is checked against: the code a test result depends on, by git object id. */
export const SOURCE_PATHS = ['core', 'src', 'abuse/tests', 'abuse/harness.js', 'abuse/run.js', 'package-lock.json'];

/**
 * @typedef {{ full: boolean, tests: { id: string, pass: boolean }[], attempts: number, through: number,
 *   source: { clean: boolean, ids: string[] } }} GateRecord
 */

/** Every abuse test the requirements define, from the AT-nn rows of their table. @param {string} md */
export const requiredTests = (md) => [...new Set([...md.matchAll(/^\| (AT-\d\d) \|/gm)].map((m) => m[1]))].sort();

/** The machine-readable line run.js puts in each results file. @param {GateRecord} r */
export const recordLine = (r) => `<!-- abuse-gate ${JSON.stringify(r)} -->`;

/** @param {string} md @returns {GateRecord | null} */
export function parseRecord(md) {
  const m = md.match(/^<!-- abuse-gate (\{.*\}) -->$/m);
  if (!m) return null;
  try {
    const r = JSON.parse(m[1]);
    return r && typeof r === 'object' && Array.isArray(r.tests) && r.source && Array.isArray(r.source.ids) ? r : null;
  } catch { return null; }
}

/**
 * Why a release may not go ahead on this record; empty when it may.
 * @param {GateRecord | null} r @param {string[]} required @param {{ clean: boolean, ids: string[] }} now
 */
export function gateProblems(r, required, now) {
  if (!r) return ['The newest results file has no gate record: run `node abuse/run.js` (all tests) again.'];
  const problems = [];
  if (!r.full) problems.push('It was not a full run: run `node abuse/run.js` with no test names.');
  const ran = new Map(r.tests.map((t) => [t.id, t.pass === true]));
  const missing = required.filter((id) => !ran.has(id));
  if (missing.length) problems.push(`Not run: ${missing.join(', ')}.`);
  const failed = r.tests.filter((t) => t.pass !== true).map((t) => t.id);
  if (failed.length) problems.push(`Failed: ${failed.join(', ')}.`);
  if (r.through !== 0) problems.push(`${r.through} attempts got through.`);
  if (!(r.attempts > 0)) problems.push('No attempts were recorded.');
  if (!r.source.clean) problems.push('It ran on uncommitted changes.');
  if (!now.clean) problems.push('The checkout has uncommitted changes to the code the suite covers.');
  if (r.source.ids.join() !== now.ids.join()) problems.push(`It ran on other code than this checkout's (${SOURCE_PATHS.join(', ')}): run it again.`);
  return problems;
}

/** Lines that aren't about a Markdown file: docs don't change what a test ran. @param {string} out */
export const codeLines = (out) => out.split('\n').map((l) => l.trimEnd()).filter((l) => l && !/\.md"?$/i.test(l));

/** The checkout's fingerprint: for each source path, a hash of HEAD's blob ids under it, and whether any has changes. */
export function sourceNow() {
  const git = (/** @type {string[]} */ args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
  return {
    clean: codeLines(git(['status', '--porcelain', '--', ...SOURCE_PATHS])).length === 0,
    ids: SOURCE_PATHS.map((p) => crypto.createHash('sha256').update(codeLines(git(['ls-tree', '-r', 'HEAD', '--', p])).join('\n')).digest('hex')),
  };
}

/**
 * The installed Electron against the lockfile's: a sentence saying how they differ, or ''.
 * A smoke or abuse run on a stale install isn't evidence for the code checked out.
 * @param {string} [dir] the checkout
 */
export function electronDrift(dir = root) {
  const read = (/** @type {string} */ file) => { try { return JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); } catch { return null; } };
  const locked = read('package-lock.json')?.packages?.['node_modules/electron']?.version;
  const installed = read(path.join('node_modules', 'electron', 'package.json'))?.version;
  if (!locked || installed === locked) return '';
  return `node_modules has Electron ${installed || '(none)'} but package-lock.json has ${locked}: close Houston and reinstall (npm ci in the real checkout).`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = path.join(root, 'abuse', 'results');
  const newest = fs.readdirSync(dir).filter((f) => /^\d{4}-\d\d-\d\d\.md$/.test(f)).sort().at(-1);
  const required = requiredTests(fs.readFileSync(path.join(root, 'docs', 'product', 'harness-requirements.md'), 'utf8'));
  const record = newest ? parseRecord(fs.readFileSync(path.join(dir, newest), 'utf8')) : null;
  const problems = gateProblems(record, required, sourceNow());
  const drift = electronDrift();
  if (drift) problems.push(drift);
  if (problems.length) {
    console.error(`Release gate: refused (${newest ?? 'no results file'}).\n${problems.map((p) => `- ${p}`).join('\n')}`);
    process.exit(1);
  }
  console.log(`Release gate: passed. ${newest}: ${record?.tests.length} tests, ${record?.attempts} attempts, none through, on this checkout's code.`);
}
