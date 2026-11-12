// Spike S1 helper (throwaway): one command under the S1 policy, print the result.
// Usage: node spikes/s1-probe.mjs <variant> <command...>
//   variants: base (no ui) | ui | enum (ui + enumerate on parent folders) | learn | deny (enum + deniedPaths on a canary)
import { run } from '@microsoft/mxc-sdk/v1';

const [variant, ...cmd] = process.argv.slice(2);
const ROOT = 'D:\\AI_Agents\\_maintenance\\tmp\\houston-s1';
const req = {
  command: cmd.join(' '),
  workingDirectory: `${ROOT}\\ws`,
  environment: { TEMP: `${ROOT}\\tmp`, TMP: `${ROOT}\\tmp` },
  inheritDefaultEnvironment: true,
  timeoutMs: 60_000,
  filesystem: { readwritePaths: [`${ROOT}\\ws`, `${ROOT}\\tmp`], readonlyPaths: ['C:\\Program Files\\Git', 'C:\\Program Files\\nodejs', 'C:\\Python312'] },
  network: { egress: { default: 'allow' } },
  containment: { type: 'processcontainer' },
};
if (variant !== 'base') req.ui = { disable: false };
if (variant === 'enum' || variant === 'deny') {
  req.containment = { type: 'processcontainer', config: { filesystem: { enumeratePaths: ['C:\\', 'C:\\Program Files', 'D:\\', 'D:\\AI_Agents', 'D:\\AI_Agents\\_maintenance', 'D:\\AI_Agents\\_maintenance\\tmp', ROOT] } } };
}
if (variant === 'deny') req.filesystem.deniedPaths = [`${ROOT}\\ws\\canary`];
if (variant === 'denyusers') {
  // Enumerate only the drive roots and the tool parent, then deny the user profile and the documents tree.
  req.containment = { type: 'processcontainer', config: { filesystem: { enumeratePaths: ['C:\\', 'D:\\'] } } };
  req.filesystem.deniedPaths = ['C:\\Users', 'D:\\AI_Agents\\Documents'];
}
if (variant === 'denyparent') {
  // Is a granted workspace still usable when one of its parent folders is denied?
  req.containment = { type: 'processcontainer', config: { filesystem: { enumeratePaths: ['C:\\', 'D:\\'] } } };
  req.filesystem.deniedPaths = ['D:\\AI_Agents\\_maintenance'];
}
if (variant === 'learn') req.containment = { type: 'processcontainer', config: { learningMode: true } };
try {
  const r = await run(req);
  console.log(JSON.stringify({ variant, cmd: req.command, exit: r.exitCode, hex: '0x' + (r.exitCode >>> 0).toString(16), out: (r.stdout + r.stderr).trim().slice(-700), warnings: r.warnings, meta: r.outputMetadata }));
} catch (e) {
  console.log(JSON.stringify({ variant, cmd: req.command, error: e.code, message: e.message }));
}
