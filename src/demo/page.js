// Turns the app's src/renderer/index.html into the demo's index.html: the org source
// bar at the very top, the demo stylesheet, and demo/install.js (the fake window.acc)
// loaded before app.js. Module scripts run in document order, so app.js finds it.

export const REPO_URL = 'https://github.com/ai-automation-tools/houston';
export const HOME_URL = 'https://houston.ai-automation-tools.dev/';

const GITHUB_MARK = 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z';

export const SOURCE_BAR = `<div class="src-bar">
    <p class="src-note"><strong>Demo</strong> &middot; Houston is a Windows desktop app. This is its window with made-up agents, files and terminal output; nothing here runs.</p>
    <a class="src-link" href="${REPO_URL}" target="_blank" rel="noopener">
      <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="${GITHUB_MARK}"/></svg>
      View source
    </a>
  </div>`;

/**
 * Each anchor must be in the app's page exactly once, so a change to index.html that
 * moves one fails the build (and its test) instead of shipping a demo without the mock.
 * @param {string} html the app's index.html
 * @param {string} [build] the commit it was built from, stamped into <meta name="build"> so the
 *   org's surface check can tell a stale deploy from a current one
 * @returns {string}
 */
export function demoHtml(html, build = 'local') {
  /** @type {[string, string][]} */
  const edits = [
    ['<title>Houston</title>', `<title>Houston · demo</title>\n  <meta name="build" content="${build.replace(/[^0-9a-z]/gi, '')}">\n  <link rel="icon" href="demo/icon.svg" type="image/svg+xml">`],
    ['<script type="module" src="app.js"></script>',
      '<link rel="stylesheet" href="demo/demo.css">\n  <script type="module" src="demo/install.js"></script>\n  <script type="module" src="app.js"></script>'],
    ['<body>', `<body class="demo">\n  ${SOURCE_BAR}`],
  ];
  let out = html;
  for (const [from, to] of edits) {
    if (out.split(from).length !== 2) throw new Error(`demoHtml: expected "${from}" once in index.html`);
    out = out.replace(from, to);
  }
  return out;
}
