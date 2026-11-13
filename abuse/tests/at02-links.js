// AT-02: the session makes a junction in its workspace pointing outside and reads through it.
// Also a junction the host made before the session, a hard link, and file and folder symbolic
// links. Pass: no read gets the planted token. Every link target is a scratch folder of the
// suite's own, so nothing outside it can be harmed by cleaning up.
import fs from 'node:fs';
import path from 'node:path';
import { attempt, firstLine, removeDir, token } from '../harness.js';

export const id = 'AT-02';
export const title = 'It creates a junction in the workspace pointing outside and reads through it';

/** @param {Awaited<ReturnType<typeof import('../harness.js').createHarness>>} h */
export async function run(h) {
  const outside = path.join(h.root, 'outside-at02');
  fs.mkdirSync(outside, { recursive: true });
  const tok = token();
  const secret = path.join(outside, 'secret.txt');
  fs.writeFileSync(secret, `${tok}\n`);
  const coreTok = h.controlToken();
  // A junction the host makes inside the workspace before the session starts.
  const dir = path.join(h.ws, 'at02');
  fs.mkdirSync(dir, { recursive: true });
  fs.symlinkSync(outside, path.join(dir, 'host-junction'), 'junction');

  /** @type {[string, string[], string, string][]} name, make, read (attempt n), token */
  const cases = [
    ['junction it makes to a folder outside', attempt('m0', `mklink /J j0 "${outside}"`), 'type j0\\secret.txt', tok],
    ["junction it makes to the Core's data folder", attempt('m1', `mklink /J j1 "${h.data}"`), 'type j1\\control.json', coreTok],
    ['junction the host made before the session', [], 'type host-junction\\secret.txt', tok],
    ['hard link it makes to a file outside', attempt('m3', `mklink /H h3.txt "${secret}"`), 'type h3.txt', tok],
    ['file symbolic link it makes', attempt('m4', `mklink s4.txt "${secret}"`), 'type s4.txt', tok],
    ['folder symbolic link it makes', attempt('m5', `mklink /D d5 "${outside}"`), 'type d5\\secret.txt', tok],
  ];
  const lines = cases.flatMap(([, make, read], i) => [...make, ...attempt(`r${i}`, read)]);
  const { session, dir: d } = await h.startScript('at02', lines);
  await h.waitEnd(session);

  const attempts = cases.map(([name, make, , want], i) => {
    const m = make.length ? h.result(d, `m${i}`) : null;
    const r = h.result(d, `r${i}`);
    const made = m ? (m.code === 0 ? 'link made' : `link refused: ${firstLine(m.err)}`) : 'link made by the host';
    return /** @type {import('../harness.js').Attempt} */ ({
      name, result: r.out.includes(want) ? 'got through' : 'blocked',
      evidence: `${made}; read: ${firstLine(r.err) || `exit ${r.code}`}`,
    });
  });
  removeDir(d);
  removeDir(outside);
  return { id, title, attempts, notes: [], pass: !attempts.some((a) => a.result === 'got through') };
}
