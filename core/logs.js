// Log retention and export (LOG-04, H7). One cap for transcripts and the audit log together:
// transcripts go first, oldest finished one first, and only then the oldest audit segments.
// Export copies the audit log and the transcripts into a new folder under <data>/exports, which
// sits in the data folder every session is denied; nothing names a path from outside.

import fs from 'node:fs';
import path from 'node:path';
import { LOG_CAP } from './transcripts.js';

/**
 * Bring the logs under their cap: transcripts first, the audit log last.
 * @param {{ audit: { prune: (p: { bytes: number }) => string[] }, transcripts?: { capBytes: number, rotate: () => void, bytes: () => number } }} logs
 * @returns {string[]} audit segments deleted
 */
export function retainLogs({ audit, transcripts }) {
  // The transcripts' rotate already keeps room for the audit log; what's left over the cap is the audit log's.
  transcripts?.rotate();
  return audit.prune({ bytes: (transcripts?.capBytes ?? LOG_CAP) - (transcripts?.bytes() ?? 0) });
}

/**
 * Write the audit log (as JSON lines) and the transcripts into exports\logs-<time>\, with a
 * manifest of what it holds and what it's missing.
 * @param {{ dir: string, audit: { exportTo: (dest: string, o: { since?: string }) => { events: number, breaks: object[], pruned: number } }, transcripts?: { copyTo: (dest: string, o: { since?: string }) => number } }} core
 * @param {{ since?: string, now?: Date }} [p] since: an ISO time; only what's newer goes
 */
export function exportLogs({ dir, audit, transcripts }, { since, now = new Date() } = {}) {
  const folder = path.join(dir, 'exports', `logs-${now.toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(folder, { recursive: true });
  const a = audit.exportTo(path.join(folder, 'audit.jsonl'), { since });
  const count = transcripts ? transcripts.copyTo(path.join(folder, 'transcripts'), { since }) : 0;
  const manifest = { created: now.toISOString(), since: since ?? null, events: a.events, breaks: a.breaks, prunedThrough: a.pruned, transcripts: count };
  fs.writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { folder, ...manifest };
}
