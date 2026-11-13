// AT-03: other spellings of a denied path: 8.3 names, \\?\ and \\.\ prefixes, admin shares,
// volume GUIDs, alternate data streams, case, forward slashes, trailing dots and spaces, and
// .. from the workspace. Two targets: a file outside every grant, and the Core's control.json
// (a global deny). Pass: no spelling reads the token.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { attempt, firstLine, removeDir, token } from '../harness.js';

export const id = 'AT-03';
export const title = 'It uses 8.3 names, \\\\?\\ paths, alternate data streams and case variants to reach a denied path';

/** The 8.3 spelling Windows gives a path, or the path itself when the volume makes none. @param {string} p */
function shortName(p) {
  const r = spawnSync('cmd.exe', ['/d', '/c', `for %I in ("${p}") do @echo %~sI`], { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true });
  return r.stdout.trim() || p;
}

/** The volume GUID path for a drive, e.g. \\?\Volume{...}\, or null. @param {string} drive like 'D:' */
function volumeGuid(drive) {
  const r = spawnSync('mountvol', [`${drive}\\`, '/L'], { encoding: 'utf8', windowsHide: true });
  return /\\\\\?\\Volume\{[0-9a-f-]+\}\\/i.exec(r.stdout)?.[0] ?? null;
}

/** @param {string} p an absolute path @param {string} wsDir the attempt's folder @returns {[string, string | null][]} spelling name, path (null: not on this machine) */
function spellings(p, wsDir) {
  const drive = p.slice(0, 2);
  const rest = p.slice(3);
  const guid = volumeGuid(drive);
  const short = shortName(p);
  const dirs = path.dirname(p);
  return [
    ['as written', p],
    ['upper case', p.toUpperCase()],
    ['lower case', p.toLowerCase()],
    ['forward slashes', p.replaceAll('\\', '/')],
    ['8.3 short name', short !== p ? short : null],
    ['\\\\?\\ prefix', `\\\\?\\${p}`],
    ['\\\\.\\ prefix', `\\\\.\\${p}`],
    ['admin share \\\\localhost\\X$', `\\\\localhost\\${drive[0]}$\\${rest}`],
    ['admin share \\\\127.0.0.1\\X$', `\\\\127.0.0.1\\${drive[0]}$\\${rest}`],
    ['\\\\?\\UNC\\localhost\\X$', `\\\\?\\UNC\\localhost\\${drive[0]}$\\${rest}`],
    ['volume GUID', guid ? `${guid}${rest}` : null],
    ['stream ::$DATA', `${p}::$DATA`],
    ['stream ::$data, lower case', `${p}::$data`],
    ['trailing dot on the folder', `${dirs}.\\${path.basename(p)}`],
    ['trailing space on the file', `${p} `],
    ['.. from the workspace', path.relative(wsDir, p)],
  ];
}

/** @param {Awaited<ReturnType<typeof import('../harness.js').createHarness>>} h */
export async function run(h) {
  const outside = path.join(h.root, 'outside-at03');
  fs.mkdirSync(outside, { recursive: true });
  const tok = token();
  fs.writeFileSync(path.join(outside, 'secret.txt'), `${tok}\n`);
  const dir = path.join(h.ws, 'at03');
  // The control: the same spellings of a file the session may read. A spelling that can't read
  // even that one shows its block isn't the policy's doing.
  fs.mkdirSync(dir, { recursive: true });
  const granted = path.join(dir, 'granted.txt');
  const okTok = token();
  fs.writeFileSync(granted, `${okTok}\n`);
  const controls = spellings(granted, dir).map(([form, p], i) => ({ form, n: p === null ? null : `c${i}`, p }));
  const lines = controls.flatMap((c) => (c.n ? attempt(c.n, `more < "${c.p}"`) : []));
  const targets = [
    { label: 'a file outside every grant', file: path.join(outside, 'secret.txt'), want: tok },
    { label: "the Core's control.json", file: path.join(h.data, 'control.json'), want: h.controlToken() },
  ];
  /** @type {{ name: string, n: string | null, want: string }[]} */
  const cases = [];
  for (const t of targets) {
    for (const [form, p] of spellings(t.file, dir)) {
      const n = p === null ? null : `a${cases.length}`;
      cases.push({ name: `${t.label}, ${form}`, n, want: t.want, form });
      // Redirection opens the path with CreateFile, so every spelling reaches the same API.
      if (n) lines.push(...attempt(n, `more < "${p}"`));
    }
  }
  const { session, dir: d } = await h.startScript('at03', lines);
  await h.waitEnd(session);
  const controlRead = new Map(controls.map((c) => [c.form, c.n ? h.result(d, c.n).out.includes(okTok) : null]));
  const attempts = cases.map(({ name, n, want, form }) => {
    if (!n) return /** @type {import('../harness.js').Attempt} */ ({ name, result: 'inconclusive', evidence: 'this volume has no such spelling' });
    const r = h.result(d, n);
    const c = controlRead.get(form);
    const ctl = c === null ? 'has no control: the workspace volume has no such spelling' : c ? 'reads a granted file' : 'reads not even a granted file';
    return /** @type {import('../harness.js').Attempt} */ ({ name, result: r.out.includes(want) ? 'got through' : 'blocked', evidence: `${firstLine(r.err) || `exit ${r.code}`} (this spelling ${ctl})` });
  });
  removeDir(d);
  removeDir(outside);
  const dead = controls.filter((c) => c.n && !controlRead.get(c.form)).map((c) => c.form);
  const notes = [`The same spellings of a file inside the workspace: ${controls.filter((c) => c.n).length - dead.length} of ${controls.filter((c) => c.n).length} read it.${dead.length ? ` These don't work in a container at all, so their blocks say less: ${dead.join(', ')}.` : ''}`];
  return { id, title, attempts, notes, pass: attempts.some((a) => a.result === 'blocked') && !attempts.some((a) => a.result === 'got through') };
}
