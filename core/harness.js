// `harness run --grant <id>`: what a scheduled task runs (H4, ADR-004). The schedule is
// Cronsole's; this asks the running Core to start one unattended session under the standing
// grant (standing.js), waits for it to end, prints its transcript (already redacted, plain text)
// and exits with the session's own exit code, or one of EXIT when it never ran or was cut short.
//   node core/harness.js run --grant nightly-docs        or   npm run harness -- run --grant nightly-docs
// It acts as the operator (it reads the Core's control.json), so it runs as the operator's own
// scheduled task. The Core decides; this passes on only the grant's id.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachSession, callControl, dataDir } from './client.js';

/** Exit codes for a run that didn't happen or didn't finish by itself. A session's own code in this range becomes 1. */
export const EXIT = {
  usage: 64,
  /** The Core isn't running, or its control file can't be read. */
  unavailable: 69,
  /** Stopped (Stop All, the operator), lost, or the Core went away mid-run. */
  stopped: 70,
  /** Ended at the standing grant's budget. */
  timeout: 71,
  /** Refused: no such grant, revoked, the identity's grants changed, or the runner said no. */
  denied: 72,
  expired: 73,
  /** A run under the same grant is still going. */
  overlap: 74,
  /** Paused, by the operator or by Stop All. */
  paused: 75,
};
const OURS = Object.values(EXIT);

/** @param {string | undefined} code standing.run's error code, or a connection error's */
export function refusalExit(code) {
  if (code === 'expired') return EXIT.expired;
  if (code === 'overlap') return EXIT.overlap;
  if (code === 'paused') return EXIT.paused;
  if (code === 'ENOENT' || code === 'ECONNREFUSED' || code === 'unauthorized' || code === 'unknown_method') return EXIT.unavailable;
  return EXIT.denied;
}

/** @param {{ reason: string, exitCode: number | null }} end how the session ended */
export function sessionExit({ reason, exitCode }) {
  if (reason === 'timeout') return EXIT.timeout;
  if (exitCode === null || exitCode === undefined) return EXIT.stopped;
  // Negative: the command never started (the SDK's -1). A task would see 4294967295.
  return OURS.includes(exitCode) || exitCode < 0 ? 1 : exitCode;
}

/**
 * How a session ended, from its `session.end` audit event: for one that finished before this
 * could attach. Null while it hasn't.
 * @param {any} e
 * @returns {{ reason: string, exitCode: number | null } | null}
 */
export function endFromEvent(e) {
  if (!e) return null;
  const code = e.outcome?.error_code;
  if (e.outcome?.status === 'ok') return { reason: 'exit 0', exitCode: 0 };
  return /^-?\d+$/.test(String(code)) ? { reason: `exit ${code}`, exitCode: Number(code) } : { reason: String(code ?? 'ended'), exitCode: null };
}

/** @param {string[]} argv */
export function parseArgs(argv) {
  const [verb, ...rest] = argv;
  let grant = null;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--grant' && rest[i + 1]) grant = rest[++i];
    else if (rest[i].startsWith('--grant=')) grant = rest[i].slice(8);
    else return null;
  }
  return verb === 'run' && grant ? { grant } : null;
}

/** @returns {Promise<number>} the exit code */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.error('usage: node core/harness.js run --grant <id>   (a standing grant: npm run ctl -- standing.list)');
    return EXIT.usage;
  }
  const dir = dataDir();
  let s;
  try {
    s = await callControl(dir, 'standing.run', { id: args.grant }, { timeoutMs: 120_000 });
  } catch (e) {
    const err = /** @type {Error & { code?: string }} */ (e);
    const code = refusalExit(err.code);
    const why = err.code === 'unknown_method' ? 'the Houston Core runs older code than this script; restart it (the Restart-Houston task)'
      : code === EXIT.unavailable ? `the Houston Core isn't reachable (${err.message})` : err.message;
    console.error(`harness: ${args.grant} did not run: ${why}`);
    return code;
  }
  console.error(`harness: ${args.grant} started session ${s.id} as ${s.identity} in ${s.workspace}`);

  /** @type {{ reason: string, exitCode: number | null }} */
  let end;
  try {
    end = await new Promise((resolve, reject) => {
      attachSession(dir, s.id, { onData: () => {}, onEnd: resolve }).catch(reject);
    });
  } catch {
    // It ended before the attach: its session.end event says how.
    const found = await callControl(dir, 'audit.query', { type: 'session.end', session_id: s.id, limit: 1 }).catch(() => null);
    end = endFromEvent(found?.events?.[0]) ?? { reason: 'unknown', exitCode: null };
  }

  const t = await callControl(dir, 'transcript.get', { id: s.id }).catch(() => null);
  if (t) process.stdout.write(t.text.endsWith('\n') ? t.text : `${t.text}\n`);
  const code = sessionExit(end);
  console.error(`harness: session ${s.id} ended (${end.reason}); exit ${code}`);
  return code;
}

// Run as a script, not when a test imports it.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, (e) => { console.error(`harness: ${e instanceof Error ? e.message : e}`); process.exitCode = EXIT.stopped; });
}
