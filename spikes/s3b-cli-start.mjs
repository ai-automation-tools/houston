// Spike S3, part 2a (throwaway): do the two agent CLIs start inside a container at all?
// Only `--version` is run: no sign-in, no credentials granted, no model call.
// Usage (PowerShell): node spikes/s3b-cli-start.mjs
import { mkdirSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '@microsoft/mxc-sdk/v1';

const WS = 'D:\\AI_Agents\\_maintenance\\tmp\\houston-s3\\ws';
mkdirSync(WS, { recursive: true });
const home = os.homedir();
const claudeDir = path.join(home, '.local', 'bin');
const npmGlobal = path.join(home, 'AppData', 'Roaming', 'npm');
const codexJs = path.join(npmGlobal, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
const anon = (s) => s.replaceAll(home, '%USERPROFILE%');

const CASES = [
  // Both CLIs are installed inside the user profile, so the profile cannot simply be denied.
  ['claude --version, profile denied', `"${path.join(claudeDir, 'claude.exe')}" --version`, [claudeDir], ['C:\\Users']],
  ['claude --version, its folder granted read-only', `"${path.join(claudeDir, 'claude.exe')}" --version`, [claudeDir], []],
  ['codex --version, its folder granted read-only', `node "${codexJs}" --version`, [path.join(npmGlobal, 'node_modules', '@openai')], []],
];
console.log(JSON.stringify({ claudeExe: existsSync(path.join(claudeDir, 'claude.exe')), codexJs: existsSync(codexJs) }));
for (const [name, command, readonly, denied] of CASES) {
  try {
    const r = await run({
      command, workingDirectory: WS, timeoutMs: 60_000,
      filesystem: { readwritePaths: [WS], readonlyPaths: ['C:\\Program Files\\nodejs', ...readonly], deniedPaths: denied },
      ui: { disable: false },
      containment: { type: 'processcontainer', config: { filesystem: { enumeratePaths: ['C:\\', 'D:\\'] } } },
    });
    console.log(`\n${name}\n  exit ${r.exitCode} (0x${(r.exitCode >>> 0).toString(16)}): ${anon((r.stdout + r.stderr).trim().slice(-400))}`);
  } catch (e) { console.log(`\n${name}\n  REJECTED ${e.code}: ${anon(e.message)}`); }
}
