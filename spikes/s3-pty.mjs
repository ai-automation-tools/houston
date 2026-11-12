// Spike S3, part 1 (throwaway): a contained process on an SDK pseudo-terminal. Checks that it
// is a real TTY, resize arrives, Ctrl+C arrives, colour codes survive, and 10 MB of output
// comes through whole. Headless: the bytes are checked here, not drawn in xterm.js.
// Usage (PowerShell): node spikes/s3-pty.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnWithPty } from '@microsoft/mxc-sdk/v1';

const ROOT = 'D:\\AI_Agents\\_maintenance\\tmp\\houston-s3';
const WS = path.join(ROOT, 'ws');
mkdirSync(WS, { recursive: true });
const BURST_LINES = 131072; // x 80 bytes = 10 MiB

writeFileSync(path.join(WS, 'tty.mjs'), `
import readline from 'node:readline';
const size = () => process.stdout.columns + 'x' + process.stdout.rows;
console.log('TTY=' + process.stdout.isTTY + ' SIZE=' + size());
process.stdout.on('resize', () => console.log('RESIZED=' + size()));
console.log('\\x1b[31mRED\\x1b[0m \\x1b[1;32mGREEN\\x1b[0m');
if (process.argv[2] === 'raw') { // how agent CLIs read keys: raw mode, Ctrl+C is the byte 0x03
  process.stdin.setRawMode(true);
  process.stdin.on('data', (d) => { if (d.includes(3)) console.log('GOT_RAW_03'); if (d.includes(113)) process.exit(0); });
}
const rl = readline.createInterface({ input: process.stdin });
process.on('SIGINT', () => console.log('GOT_SIGINT'));
rl.on('line', (l) => {
  if (l === 'burst') { const line = 'x'.repeat(78) + '\\r\\n'; let i = 0;
    const pump = () => { while (i < ${BURST_LINES}) { i++; if (!process.stdout.write(line)) return process.stdout.once('drain', pump); } console.log('BURST_DONE'); }; pump(); }
  if (l === 'exit') process.exit(0);
});
console.log('READY');
`);

const term = await spawnWithPty({
  command: process.argv.includes('--rawmode') ? 'node tty.mjs raw' : 'node tty.mjs',
  workingDirectory: WS, timeoutMs: 120_000,
  filesystem: { readwritePaths: [WS], readonlyPaths: ['C:\\Program Files\\nodejs'], deniedPaths: ['C:\\Users'] },
  ui: { disable: false },
  containment: { type: 'processcontainer', config: { filesystem: { enumeratePaths: ['C:\\', 'D:\\'] } } },
}, { size: { rows: 24, columns: 80 } });

let buf = ''; let head = ''; let xCount = 0; let bytes = 0;
term.output.on('data', (c) => { const s = c.toString('latin1'); bytes += c.length; xCount += (s.match(/x/g) ?? []).length; buf = (buf + s).slice(-200_000); if (head.length < 1500) head += s; });
const until = (re, ms = 20_000) => new Promise((res) => { const t0 = Date.now(); const iv = setInterval(() => { if (re.test(buf) || Date.now() - t0 > ms) { clearInterval(iv); res(re.test(buf)); } }, 50); });
const result = {};
try {
  result.ready = await until(/READY/);
  result.isTty = /TTY=true/.test(buf);
  result.initialSize = buf.match(/SIZE=(\d+x\d+)/)?.[1];
  // The terminal layer rewrites sequences (1;32 becomes 32 then 1), so match loosely.
  result.colourCodesIntact = /\x1b\[31mRED/.test(buf) && /\x1b\[32m(\x1b\[1m)?GREEN/.test(buf);
  result.resizeSequenceSeen = false;
  term.resize({ rows: 40, columns: 132 });
  result.resize = (await until(/RESIZED=132x40/, 5000)) ? '132x40 seen' : `not seen (${buf.match(/RESIZED=\S+/)?.[0] ?? 'no event'})`;
  result.resizeSequenceSeen = buf.includes('\x1b[8;40;132t'); // the terminal announcing its new size
  const t = performance.now();
  term.input.write('burst\r');
  result.burstDone = await until(/BURST_DONE/, 90_000);
  result.burstSeconds = +((performance.now() - t) / 1000).toFixed(1);
  result.burstPayloadBytes = xCount; // counts only the payload 'x' characters
  result.burstExpected = BURST_LINES * 78;
  result.burstComplete = xCount >= BURST_LINES * 78;
  result.totalBytesReceived = bytes;
  // Ctrl+C last: after the handler prints, Windows' default handler may still end the process.
  term.input.write('\x03');
  await until(/GOT_SIGINT|GOT_RAW_03/, 5000);
  result.ctrlC = buf.match(/GOT_SIGINT|GOT_RAW_03/)?.[0] ?? 'not delivered';
  term.input.write('exit\r'); term.input.write('q');
  result.afterCtrlC = await Promise.race([term.wait(), new Promise((r) => setTimeout(() => r('still running after 5 s'), 5000))]);
} finally {
  if (process.argv.includes('--raw')) console.log('FIRST BYTES:', JSON.stringify(head.slice(0, 900)), '\nLAST BYTES:', JSON.stringify(buf.slice(-300)));
  try { term.kill(); } catch {}
  term.dispose();
}
console.log(JSON.stringify(result, null, 2));
process.exit(0);
