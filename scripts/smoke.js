// Launch the real app on a throwaway profile, run its checks, save screenshots, quit.
// Usage: npm run smoke [-- <url>] [--install <id>,<id>] [--live] [--profile]
//          --live     also count the checks that need Project Hub and Cronsole running
//          --profile  use the real profile in %APPDATA%\ai-command-center instead
//        npm run spike:extensions   (installs LastPass and Rakuten, then loads a shop page)
// Screenshots and summary.json land in .smoke/ (gitignored). Exits 1 when a check fails,
// or when the app quit without running them (another instance on the same profile).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, '.smoke');
const args = process.argv.slice(2);
const flag = (/** @type {string} */ name) => { const i = args.indexOf(name); if (i >= 0) args.splice(i, 1); return i >= 0; };
const at = args.indexOf('--install');
const install = at >= 0 ? args.splice(at, 2)[1] : '';
const live = flag('--live');
const realProfile = flag('--profile');
const url = args[0];

const env = { ...process.env, ACC_SMOKE_DIR: dir };
if (url) env.ACC_SMOKE_URL = url;
if (live) env.ACC_SMOKE_LIVE = '1';
if (install) { env.ACC_SMOKE_INSTALL = install; env.ACC_SMOKE_WAIT_MS = '25000'; }

// A short temp path: past Windows' 260-character limit, IndexedDB fails to open.
const profile = realProfile ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'acc-smoke-'));
if (profile) {
  env.ACC_USER_DATA = profile;
  // settings.json only (the Hub address and quick links): nothing signed in, no history.
  const settings = path.join(process.env.APPDATA || '', 'ai-command-center', 'settings.json');
  /** @type {Record<string, unknown>} */
  let copied = {};
  try { copied = JSON.parse(fs.readFileSync(settings, 'utf8')); } catch { /* none, or not JSON: defaults */ }
  // The News tab reads one local Markdown source, so the run needs no network for it.
  const news = path.join(profile, 'smoke-news.md');
  fs.writeFileSync(news, '## 2026-10-30\n- [Smoke headline](https://example.com/smoke-news)\n');
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ ...copied, newsSources: [{ label: 'Smoke digest', url: news }] }));
  // An old single-conversation chat.json, so the run checks it moves into the conversation list.
  fs.writeFileSync(path.join(profile, 'chat.json'), JSON.stringify([
    { role: 'user', content: 'Smoke: how do I ship acme-api?' },
    { role: 'assistant', content: [{ type: 'text', text: 'Merge to main; the release workflow builds it.' }] },
  ]));
  env.ACC_SMOKE_SEEDED = '1';
}

const summaryFile = path.join(dir, 'summary.json');
fs.rmSync(summaryFile, { force: true });
const child = spawn(/** @type {string} */ (/** @type {unknown} */ (electron)), ['.'], { cwd: root, stdio: 'inherit', env });
const timer = setTimeout(() => { console.error('[smoke] timed out after 120 s'); child.kill(); }, 120_000);
child.on('exit', (code) => {
  clearTimeout(timer);
  if (profile) fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  if (!fs.existsSync(summaryFile)) {
    console.error('[smoke] FAILED: the app exited without running the checks (is it already running on this profile?)');
    process.exit(1);
  }
  process.exit(code ?? 1);
});
