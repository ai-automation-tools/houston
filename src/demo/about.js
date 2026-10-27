// The demo's welcome page: what Houston is, shown in the first tab in the
// style of the repo's README. Static HTML, no scripts, no network: the badges are CSS,
// not shields.io images, so opening the demo calls nothing. Keep it in step with the
// README's "What works today" table when a feature lands.

import { docUrl } from '../shared/docs.js';
import { REPO_URL } from './page.js';

export const WELCOME_ID = 'ai-command-center/README.md';
export const WELCOME_URL = docUrl(WELCOME_ID);

const ISSUES = `${REPO_URL}/issues`;
const ext = 'target="_blank" rel="noopener"';

/** A two-part badge in the shields.io style. @param {string} label @param {string} value @param {string} color */
const badge = (label, value, color) =>
  `<span class="badge"><span class="badge-l">${label}</span><span class="badge-v" style="--b:${color}">${value}</span></span>`;
/** A flat tech badge. @param {string} name @param {string} color */
const tech = (name, color) => `<span class="tech" style="--b:${color}">${name}</span>`;

export const ABOUT_HTML = `<article class="demo-doc">
  <header class="hero">
    <img class="hero-logo" src="demo/icon.svg" alt="Houston, a desktop app that puts a browser, terminals and your project folders in one window an agent can drive" width="88" height="88">
    <h1>Houston</h1>
    <p class="tagline">A browser, PowerShell terminals and every project folder you work in,<br>in one window that Claude can drive.</p>
    <p class="explore"><a href="${REPO_URL}#readme" ${ext}><strong>Explore the docs »</strong></a></p>
    <p class="nav-row">
      <a href="${REPO_URL}" ${ext}>View source</a> ·
      <a href="${ISSUES}" ${ext}>Report Bug</a> ·
      <a href="${ISSUES}" ${ext}>Request Feature</a>
    </p>
    <p class="badges">
      ${badge('demo', 'in your browser', '#2ea44f')}
      ${badge('status', 'public', '#F59E0B')}
      ${badge('license', 'GPL-3.0', '#8B5CF6')}
    </p>
    <p class="badges">
      ${tech('Electron 45', '#47848F')}
      ${tech('Node.js 24', '#339933')}
      ${tech('xterm.js 6', '#3f3f46')}
      ${tech('PowerShell 7', '#5391FE')}
      ${tech('MCP', '#6B7280')}
    </p>
  </header>

  <hr>

  <aside class="callout">
    <p class="callout-title">ⓘ You're in the demo</p>
    <p>This is the app's real shell UI running on made-up files, bookmarks and terminal output. Nothing you do here runs, and nothing leaves your browser. The real thing is a Windows 11 desktop app.</p>
  </aside>

  <h2>🧪 Try it here</h2>
  <table>
    <thead><tr><th>Where</th><th>What to do</th></tr></thead>
    <tbody>
      <tr><td><b>💻 Terminal</b></td><td>Type <code>npm test</code> in the panel below. One test fails on purpose. <code>git status</code>, <code>ls</code> and <code>help</code> answer too.</td></tr>
      <tr><td><b>✋ Confirm bar</b></td><td>About six seconds in, an agent asks to run <code>npm test</code>. Nothing happens until you click <b>Run</b>.</td></tr>
      <tr><td><b>📁 Sidebar</b></td><td>Open a folder under Files, search across files and bookmarks, then look at the <b>MCP</b> log, <b>Cron</b> and <b>Git</b> tabs, and the chat pane on the right.</td></tr>
      <tr><td><b>🗂️ Tabs</b></td><td>Type an address and press Enter. Tabs, back, forward and Recent all work, though there's no browser engine behind the page.</td></tr>
    </tbody>
  </table>

  <h2>✨ What it does</h2>
  <p>The sidebar comes from <a href="https://github.com/ai-automation-tools/project-hub" ${ext}>Project Hub</a>, a small local server that already scans your workspaces and reads your browser bookmarks, so the app doesn't rescan the disk. An MCP server and a chat panel let an agent work the window the way you do.</p>
  <table>
    <thead><tr><th>Area</th><th>What you get</th></tr></thead>
    <tbody>
      <tr><td><b>🌐 Browser</b></td><td>Tabs and an address bar that takes URLs, <code>D:\\</code> paths, <code>localhost</code> or a search. Links open as tabs, sign-in pop-ups as small windows, and Chrome Web Store extensions install in a tab.</td></tr>
      <tr><td><b>💻 Terminal</b></td><td>PowerShell 7 in tabs along the bottom, or Windows PowerShell, Command Prompt and Git Bash. "Terminal here" on a sidebar folder opens one in that folder.</td></tr>
      <tr><td><b>📁 Files</b></td><td>Every workspace Project Hub knows about. Click a file and it opens in a tab: Markdown rendered, code as code, images inline. Right-click for VS Code, Explorer or Copy path.</td></tr>
      <tr><td><b>🔖 Bookmarks</b></td><td>Your Chrome, Edge or Brave bookmarks, read straight from disk, or Hub's own favorites.</td></tr>
      <tr><td><b>🔍 Search</b></td><td>One box across files, bookmarks, and the pages, files and terminals you opened lately.</td></tr>
      <tr><td><b>🤖 MCP server</b></td><td>Tools that look (<code>list_tabs</code>, <code>read_tab</code>, <code>sidebar_search</code>, <code>terminal_read</code>) and tools that act (<code>open_tab</code>, <code>open_file</code>, <code>terminal_run</code>, <code>cron_run</code>). Anything that runs waits for your click, and every call lands in the MCP log.</td></tr>
      <tr><td><b>💬 Chat</b></td><td>Claude in a pane on the right (💬 or Ctrl+Shift+L), using the same tools. <b>+ page</b> and <b>+ terminal</b> hand it what a tab or a terminal is showing. Replies stream, and the conversation is still there after a restart.</td></tr>
      <tr><td><b>⏱️ Cron</b></td><td><a href="https://github.com/ai-automation-tools/cronsole" ${ext}>Cronsole</a>'s scheduled tasks: next run, paused or failed at a glance, and its full UI in a pinned tab. An agent can start a task once you click Run.</td></tr>
    </tbody>
  </table>

  <h2>🚀 Get it</h2>
  <p>You need Windows 11, Node.js 24, PowerShell 7 and a running Project Hub. Without Hub the browser and terminals still work; the Files and Bookmarks panels just wait for it.</p>
  <pre><code><span class="c"># 1. Clone and install (node-pty ships prebuilt, no compiler needed)</span>
git clone ${REPO_URL}
cd houston
npm install

<span class="c"># 2. Run it</span>
npm start</code></pre>

  <h2>🤖 Let Claude Code drive it</h2>
  <p>Register the app's MCP server once, and <code>claude</code> in any terminal can open tabs, read pages and put commands on the Run bar while the app runs:</p>
  <pre><code>claude mcp add --scope user houston -- node &lt;houston&gt;\\scripts\\mcp-stdio.js</code></pre>
  <p>Settings, the chat key, Cronsole setup and the rest are in the <a href="${REPO_URL}#readme" ${ext}>README on GitHub</a>.</p>

  <hr>

  <p class="footer">
    Built with <a href="https://www.electronjs.org" ${ext}>Electron</a> · <a href="https://xtermjs.org" ${ext}>xterm.js</a> · <a href="https://github.com/ai-automation-tools/project-hub" ${ext}>Project Hub</a> · <a href="${REPO_URL}/blob/main/LICENSE" ${ext}>GPL-3.0-or-later</a>
  </p>
</article>`;
