// The window's side of the Core's approval inbox: ask the Core what's waiting and pass the
// operator's answer back. The Core holds each request and decides when it runs out; the
// window only shows the card, so a closed window means a denied ask, never an allowed one.

import { isAnswer } from '../shared/approvals.js';
import { core } from './core.js';

/**
 * @param {(channel: string, ...args: unknown[]) => void} send
 * @param {number} [intervalMs]
 */
export function watchApprovals(send, intervalMs = 1500) {
  /** @type {import('../shared/approvals.js').Approval[]} */
  let list = [];
  let last = '[]';
  const refresh = async () => {
    // No Core, or not Windows: nothing can be waiting.
    let now = [];
    if (process.platform === 'win32') {
      try { now = await core.call('approval.list', {}, 3000); } catch { /* not running */ }
    }
    const text = JSON.stringify(now);
    if (text === last) return;
    last = text;
    list = now;
    send('approvals:changed', list);
  };
  // ponytail: polls the pipe; a push stream like session.attach if 1.5 s ever feels slow.
  const timer = setInterval(() => void refresh(), intervalMs);
  timer.unref?.();
  void refresh();

  return {
    list: () => list,
    /** @param {unknown} id @param {unknown} answer once, session or deny */
    async decide(id, answer) {
      if (typeof id !== 'string' || !id || id.length > 100) throw new Error('id is an approval id');
      if (!isAnswer(answer)) throw new Error('answer is once, session or deny');
      const r = await core.call('approval.decide', { id, answer });
      await refresh();
      return r;
    },
    stop: () => clearInterval(timer),
  };
}
