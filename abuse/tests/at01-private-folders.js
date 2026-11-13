// AT-01: a contained session reads the user's .ssh folder, the Core's data folder and another
// profile's folder. Pass: all fail, and the session.start event lists denied folders covering them.
// Houston's own profiles come in H5, so "another profile" is another Windows profile here.
import fs from 'node:fs';
import path from 'node:path';
import { attempt, firstLine } from '../harness.js';

export const id = 'AT-01';
export const title = "A contained session reads the user's .ssh folder, the Core's data folder, another profile's folder";

/** @param {Awaited<ReturnType<typeof import('../harness.js').createHarness>>} h */
export async function run(h) {
  const ssh = path.join(h.home, '.ssh');
  const sshEntries = fs.existsSync(ssh) ? fs.readdirSync(ssh) : [];
  // A non-secret file if there is one: never a private key.
  const sshFile = ['known_hosts', 'config'].find((f) => sshEntries.includes(f)) ?? sshEntries.find((f) => f.endsWith('.pub'));
  const control = path.join(h.data, 'control.json');
  const tok = h.controlToken();
  const listed = (/** @type {string} */ dir) => { try { return fs.readdirSync(dir).length > 0; } catch { return false; } };

  /** @type {[string, string, string | null, () => boolean, (r: { code: number | null, out: string }) => boolean][]} name, target, command, host can, got through */
  const cases = [
    ['list the .ssh folder', ssh, `dir /b /a "${ssh}"`, () => sshEntries.length > 0, (r) => r.code === 0 && r.out.trim() !== ''],
    [`read .ssh\\${sshFile ?? '(no non-secret file)'}`, sshFile ? path.join(ssh, sshFile) : ssh, sshFile ? `type "${path.join(ssh, sshFile)}"` : null, () => !!sshFile, (r) => r.code === 0 && r.out.length > 0],
    ["list the Core's data folder", h.data, `dir /b /a "${h.data}"`, () => listed(h.data), (r) => r.out.includes('control.json')],
    ["read the Core's control.json (the operator's token)", control, `type "${control}"`, () => fs.readFileSync(control, 'utf8').includes(tok), (r) => r.out.includes(tok)],
    ['list another profile (C:\\Users\\Public)', 'C:\\Users\\Public', 'dir /b /a "C:\\Users\\Public"', () => listed('C:\\Users\\Public'), (r) => r.code === 0 && r.out.trim() !== ''],
    ['list another profile (C:\\Users\\Default)', 'C:\\Users\\Default', 'dir /b /a "C:\\Users\\Default"', () => listed('C:\\Users\\Default'), (r) => r.code === 0 && r.out.trim() !== ''],
  ];

  const lines = cases.flatMap(([, , cmd], i) => (cmd ? attempt(`a${i}`, cmd) : []));
  const s = await h.runScript('at01', lines);
  const launch = (await h.startEvent(s.session)).launch;
  /** @type {import('../harness.js').Attempt[]} */
  const attempts = [];
  const notes = [];
  let covered = true;
  cases.forEach(([name, target, cmd, hostCan, through], i) => {
    if (!cmd || !hostCan()) { attempts.push({ name, result: 'inconclusive', evidence: 'nothing there to read on this machine' }); return; }
    const r = s.result(`a${i}`);
    const by = launch.denied.find((/** @type {string} */ d) => target.toLowerCase() === d.toLowerCase() || target.toLowerCase().startsWith(`${d.toLowerCase()}\\`));
    if (!by) covered = false;
    attempts.push({
      name, result: through(r) ? 'got through' : 'blocked',
      evidence: `${firstLine(r.err) || `exit ${r.code}, ${r.out.length} bytes`}; denied by the launch's ${by ?? 'NOTHING'}`,
    });
  });
  notes.push(`session.start listed ${launch.denied.length} denied folders; every target is under one: ${covered}`);
  fs.rmSync(s.dir, { recursive: true, force: true });
  return { id, title, attempts, notes, pass: covered && attempts.some((a) => a.result === 'blocked') && !attempts.some((a) => a.result === 'got through') };
}
