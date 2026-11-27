// Turns the app's src/renderer/index.html into the demo's index.html: the org source
// bar at the very top, the demo stylesheet, and demo/install.js (the fake window.acc)
// loaded before app.js. Module scripts run in document order, so app.js finds it.

// The source is private while the harness is built, so the bar links the homepage.
export const HOME_URL = 'https://houston.ai-automation-tools.dev/';

export const SOURCE_BAR = `<div class="src-bar">
    <p class="src-note"><strong>Demo</strong> &middot; Houston is a Windows desktop app. This is its window with made-up agents, files and terminal output; nothing here runs.</p>
    <a class="src-link" href="${HOME_URL}" target="_blank" rel="noopener">
      About Houston →
    </a>
  </div>`;

/**
 * Each anchor must be in the app's page exactly once, so a change to index.html that
 * moves one fails the build (and its test) instead of shipping a demo without the mock.
 * @param {string} html the app's index.html
 * @returns {string}
 */
export function demoHtml(html) {
  /** @type {[string, string][]} */
  const edits = [
    ['<title>Houston</title>', '<title>Houston · demo</title>\n  <link rel="icon" href="demo/icon.svg" type="image/svg+xml">'],
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
