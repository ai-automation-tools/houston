// The demo's welcome page: what Houston is now (an agent harness with a workbench around it),
// shown in the first tab. Static HTML, no scripts, no network: the badges are CSS, not
// shields.io images, so opening the demo calls nothing. Links go to the homepage (a source link
// can join them when the demo is published). Keep it in step with the README's features table when a feature lands.

import { docUrl } from '../shared/docs.js';
import { HOME_URL } from './page.js';

export const WELCOME_ID = 'ai-command-center/README.md';
export const WELCOME_URL = docUrl(WELCOME_ID);

const ext = 'target="_blank" rel="noopener"';

/** A two-part badge in the shields.io style. @param {string} label @param {string} value @param {string} color */
const badge = (label, value, color) =>
  `<span class="badge"><span class="badge-l">${label}</span><span class="badge-v" style="--b:${color}">${value}</span></span>`;
/** A flat tech badge. @param {string} name @param {string} color */
const tech = (name, color) => `<span class="tech" style="--b:${color}">${name}</span>`;

export const ABOUT_HTML = `<article class="demo-doc">
  <header class="hero">
    <img class="hero-logo" src="demo/icon.svg" alt="Houston, an agent harness: agents run as named identities in OS containers, and the operator approves, watches and stops them from one window" width="88" height="88">
    <h1>Houston</h1>
    <p class="tagline">Run coding agents as named identities in OS containers,<br>and approve, watch and stop them from the window you already work in.</p>
    <p class="explore"><a href="${HOME_URL}" ${ext}><strong>About Houston »</strong></a></p>
    <p class="badges">
      ${badge('demo', 'in your browser', '#2ea44f')}
      ${badge('status', 'harness build', '#8B5CF6')}
      ${badge('license', 'GPL-3.0', '#6B7280')}
    </p>
    <p class="badges">
      ${tech('Electron 45', '#47848F')}
      ${tech('Node.js 24', '#339933')}
      ${tech('Windows containers', '#0078D4')}
      ${tech('xterm.js 6', '#3f3f46')}
      ${tech('MCP', '#6B7280')}
    </p>
  </header>

  <hr>

  <aside class="callout">
    <p class="callout-title">ⓘ You're in the demo</p>
    <p>This is the app's real window running on made-up agents, files and terminal output, with a stand-in for the Core that runs the same rules. Nothing you do here runs, and nothing leaves your browser. The real thing is a Windows 11 desktop app.</p>
  </aside>

  <h2>🧪 Try it here</h2>
  <table>
    <thead><tr><th>Where</th><th>What to do</th></tr></thead>
    <tbody>
      <tr><td><b>✋ Approval card</b></td><td>About fifteen seconds in, <b>Dev Claude</b>, already working, asks to reach <code>registry.npmjs.org</code>. The card above the terminals says who, what and where; nothing happens until you answer, and no answer in two minutes is a no.</td></tr>
      <tr><td><b>🛡 Agents</b></td><td>Open the <b>Agents</b> tab and press <b>Start</b> on <b>Build shell</b>. Its tab is a contained session: try <code>curl.exe https://example.com/</code> (it asks first), <code>curl.exe https://pastebin.com/</code> (refused), <code>type .env</code> and <code>dir %USERPROFILE%</code>. <code>help</code> lists them.</td></tr>
      <tr><td><b>📜 Logs</b></td><td>The <b>Logs</b> tab is the audit log: filter by identity, session or decision, click a row for the whole event, and open a session's <b>Transcript</b>, where the key <code>type .env</code> printed is already <code>[REDACTED:…]</code>.</td></tr>
      <tr><td><b>⏹ Stop All</b></td><td>The red button at the right of the address bar ends every agent session at once (Ctrl+Shift+Backspace in the app).</td></tr>
      <tr><td><b>⚙ Settings</b></td><td>Every control under its scope (global, profile, workspace, session), what it's set to and where it's changed.</td></tr>
      <tr><td><b>💻 The workbench</b></td><td>The rest is the window around it: <code>npm test</code> in the PowerShell tab, the Run bar an MCP client gets (about six seconds in), Files, Bookmarks, Cron, Git and the chat pane.</td></tr>
    </tbody>
  </table>

  <h2>✨ What it does</h2>
  <p>Houston is a browser, terminals and your project folders in one window, grown into an agent harness. A companion process, the <b>Core</b>, owns every agent session: it starts each one in a Windows container with only the folders and hosts its identity is granted, holds anything marked <i>ask</i> until you answer, and writes what happened to a hash-chained audit log. The window only asks; the Core decides.</p>
  <table>
    <thead><tr><th>Part</th><th>What you get</th></tr></thead>
    <tbody>
      <tr><td><b>🪪 Identities</b></td><td>Each agent is a named identity with grants: folders it may read or write, hosts it may reach, allow or ask. Claude Code and Codex start from manifests, each signed in to a home of its own, never your config.</td></tr>
      <tr><td><b>📦 Containment</b></td><td>Sessions run in Windows containers without admin: your profile, the Core's data and other apps on <code>localhost</code> are out of reach, and the network goes through a per-session proxy that allows only what's granted.</td></tr>
      <tr><td><b>✋ Approvals</b></td><td>Allow once, allow for this session, or deny, from a card that names the exact request. Unanswered is denied.</td></tr>
      <tr><td><b>📜 Audit and transcripts</b></td><td>Every decision is an event with identity, session and reason. Each session's terminal is kept as a transcript, with secrets replaced before it's written.</td></tr>
      <tr><td><b>⏹ Stop All</b></td><td>One button, a hotkey and a tray item end every session in under a second.</td></tr>
      <tr><td><b>🧰 Workbench</b></td><td>Browser tabs, PowerShell terminals, Project Hub's files and bookmarks, Cronsole's tasks, Git and dev servers, a chat pane, and an MCP server whose actions wait for your click.</td></tr>
    </tbody>
  </table>
  <p>Agents reach MCP tools only through the Core's gateway, from servers you pinned, and the servers get their credentials from a vault no agent can read (the Integrations tab). Still to come: standing grants for unattended runs, profiles, and a fallback for machines without containers.</p>

  <hr>

  <p class="footer">
    <a href="${HOME_URL}" ${ext}>Houston</a> · Built with <a href="https://www.electronjs.org" ${ext}>Electron</a> · <a href="https://xtermjs.org" ${ext}>xterm.js</a> · <a href="https://github.com/ai-automation-tools/project-hub" ${ext}>Project Hub</a> · GPL-3.0-or-later
  </p>
</article>`;
