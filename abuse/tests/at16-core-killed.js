// AT-16: the Core is killed mid-session. Pass: the session's container ends (by the time the
// Core is back up at the latest) and the restart marks the session interrupted.
// The other way a Core dies, a crash right after a spawn, is checked by spikes/h1-dead-core.mjs:
// it needs a Core that crashes on cue, which the real entry point doesn't do.
import { AGENT, sleep } from '../harness.js';

export const id = 'AT-16';
export const title = 'The Core is killed mid-session';

/** @param {Awaited<ReturnType<typeof import('../harness.js').createHarness>>} h */
export async function run(h) {
  const s = await h.call('session.start', { identity: AGENT, workspace: h.ws, command: 'cmd.exe /d /c start "" /b cmd.exe /d /q /k & cmd.exe /d /q /k' });
  await sleep(3000);
  const before = h.sessionProcesses([s.id]);
  await h.killCore();
  await sleep(3000);
  const afterKill = h.alive(before);
  await h.startCore();
  const end = (await h.call('audit.query', { type: 'session.end', session_id: s.id })).events[0];
  await sleep(1000);
  const afterRestart = h.alive(before);
  /** @type {import('../harness.js').Attempt[]} */
  const attempts = [
    { name: 'the session outlives a killed Core', result: afterRestart.length ? 'got through' : 'blocked', evidence: `${before.length} processes before the kill, ${afterKill.length} alive 3 s after it, ${afterRestart.length} after the restart` },
    { name: 'the restart records the session as interrupted', result: end?.outcome?.error_code === 'interrupted' ? 'blocked' : 'got through', evidence: end ? `session.end ${end.outcome.error_code}: ${end.decision.reasons?.[0] ?? ''}` : 'no session.end event' },
  ];
  return { id, title, attempts, notes: [], pass: before.length > 0 && !attempts.some((a) => a.result === 'got through') };
}
