// Houston's own document view: acc://doc/<Hub node id> in an ordinary sandboxed
// tab, and the same page around a Cronsole run's output (acc://run). Project Hub renders the file (its /api/file); this wraps the result in a plain
// page with no scripts, or lists a folder's children. URL paths mirror Hub ids, so a
// README's relative links and images resolve the way they do on disk.

import { hubIdArg } from './tools.js';

export const DOC_PREFIX = 'acc://doc/';

/** Image types served as bytes, by extension. */
export const IMAGE_TYPES = /** @type {Record<string, string>} */ ({
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml',
});

/** No scripts, frames or forms; images from documents and the web (README badges). */
export const DOC_HEADERS = {
  'content-security-policy': "default-src 'none'; img-src acc: https: data:; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store',
};

/** @param {string} id */
export function docUrl(id) {
  return DOC_PREFIX + id.split('/').map(encodeURIComponent).join('/');
}

/**
 * The Hub node id an acc://doc URL names. Throws for anything that isn't one.
 * @param {string} url
 */
export function docIdFromUrl(url) {
  const u = new URL(url);
  if (u.protocol !== 'acc:' || u.host !== 'doc') throw new Error('not a document URL');
  let id;
  try {
    id = u.pathname.slice(1).replace(/\/+$/, '').split('/').map(decodeURIComponent).join('/');
  } catch {
    throw new Error('badly encoded document URL');
  }
  return hubIdArg(id);
}

/** @param {string} url */
export const isDocUrl = (url) => url.toLowerCase().startsWith(DOC_PREFIX);

/** @param {string} name */
export function imageType(name) {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? '';
  return IMAGE_TYPES[ext] ?? null;
}

/** @param {string} s */
export function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

/**
 * A folder's children: folders first, then by name.
 * @param {import('./tree.js').HubNode} node
 * @param {(n: import('./tree.js').HubNode) => boolean} isFolder
 */
export function folderBody(node, isFolder) {
  const kids = [...(node.children || [])].sort((a, b) => Number(isFolder(b)) - Number(isFolder(a)) || a.name.localeCompare(b.name));
  if (!kids.length) return '<p class="note">This folder is empty.</p>';
  const rows = kids.map((k) => `<li><a href="${escapeHtml(docUrl(k.id))}">${isFolder(k) ? '📁' : '📄'} ${escapeHtml(k.name)}</a></li>`);
  return `<ul class="listing">${rows.join('')}</ul>`;
}

/**
 * The whole page. `body` is Hub's rendered HTML or a body built here; the title and
 * trail are escaped.
 * @param {{ title: string, trail: string, body: string }} doc
 */
export function docPage({ title, trail, body }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="color-scheme" content="dark light">
<title>${escapeHtml(title)}</title><style>${CSS}</style></head>
<body><header class="trail">${escapeHtml(trail)}</header><main class="doc">${body}</main></body></html>`;
}

/**
 * A Cronsole run's output as a page (acc://run, src/main/cronsole.js). All of it is
 * another program's output, escaped and shown as text.
 * @param {{ task: string, run: import('./cronsole.js').CronRun, output: string | null, error?: string | null }} p
 */
export function runPage({ task, run, output, error = null }) {
  const facts = [run.status, run.triggeredAt, run.durationMs !== null && `${run.durationMs} ms`].filter(Boolean).join(' · ');
  const body = [
    `<h1>${escapeHtml(task)}</h1>`,
    `<p class="note">${escapeHtml(facts)}</p>`,
    error && `<p class="note">Couldn't get the platform's output: ${escapeHtml(error)}</p>`,
    output ? `<pre>${escapeHtml(output)}</pre>` : '<p class="note">Cronsole recorded no output for this run.</p>',
  ].filter(Boolean).join('');
  return docPage({ title: `${task} · run`, trail: `Cronsole › ${task} › ${run.triggeredAt || run.id}`, body });
}

/**
 * One file's diff as a page (acc://git, src/main/git.js): each line escaped and classed
 * so additions and removals are coloured. Read-only; nothing on it acts.
 * @param {{ repo: string, branch: string, file: import('./git.js').GitFile, area: import('./git.js').DiffArea, lines: { cls: string, text: string }[], truncated: boolean }} p
 */
export function gitDiffPage({ repo, branch, file, area, lines, truncated }) {
  const name = repo.split(/[\\/]/).filter(Boolean).pop() || repo;
  const what = { staged: 'Staged changes', unstaged: 'Changes not staged', untracked: 'New file, not tracked yet' }[area];
  const body = [
    `<h1>${escapeHtml(file.path)}</h1>`,
    `<p class="note">${escapeHtml([what, file.from && `renamed from ${file.from}`, branch && `on ${branch}`].filter(Boolean).join(' · '))}</p>`,
    lines.length
      ? `<pre class="diff">${lines.map((l) => `<span class="${l.cls}">${escapeHtml(l.text) || ' '}</span>`).join('')}</pre>`
      : '<p class="note">No textual difference (a mode change, or a binary file).</p>',
    truncated && '<p class="note">Cut off after 5,000 lines.</p>',
  ].filter(Boolean).join('');
  return docPage({ title: `${file.path} · diff`, trail: `Git › ${name} › ${file.path}`, body });
}

/**
 * A dev server's output as a page (acc://dev, src/main/devservers.js), escaped like a
 * run's. Reload the tab for newer output.
 * @param {{ script: string, folder: string, command: string, state: string, url: string, output: string }} p
 */
export function devLogPage({ script, folder, command, state, url, output }) {
  const name = folder.split(/[\\/]/).filter(Boolean).pop() || folder;
  const body = [
    `<h1>${escapeHtml(`${name} · ${script}`)}</h1>`,
    `<p class="note">${escapeHtml([state, url, command, folder].filter(Boolean).join(' · '))}</p>`,
    output ? `<pre>${escapeHtml(output)}</pre>` : '<p class="note">No output yet.</p>',
  ].join('');
  return docPage({ title: `${script} · log`, trail: `Dev servers › ${name} › ${script}`, body });
}

/**
 * A terminal_run run's acc://runlog page: the command, how it ended, the files it
 * changed and its output, all as text.
 * @param {{ run: number, command: string, cwd: string, state: string, started: string, took: string | null, changed: string[] | null, output: string }} r
 */
export function runLogPage({ run, command, cwd, state, started, took, changed, output }) {
  const files = changed === null
    ? '<p class="note">Changed files: not a Git repository, or not known yet.</p>'
    : changed.length
      ? `<h2>Changed files (${changed.length})</h2><ul>${changed.map((f) => `<li><code>${escapeHtml(f)}</code></li>`).join('')}</ul>`
      : '<p class="note">Changed files: none.</p>';
  const body = [
    `<h1><code>${escapeHtml(command)}</code></h1>`,
    `<p class="note">${escapeHtml([`Run ${run}`, state, cwd, `started ${started}`, took && `took ${took}`].filter(Boolean).join(' · '))}</p>`,
    files,
    output ? `<pre>${escapeHtml(output)}</pre>` : '<p class="note">No output.</p>',
  ].join('');
  return docPage({ title: `Run ${run} · ${command.slice(0, 60)}`, trail: `Runs › ${run}`, body });
}

const CSS = `
:root { --bg: #0b0d10; --panel: #111418; --line: #262b33; --text: #e4e4e7; --text-2: #a1a1aa; --accent: #38bdf8; }
@media (prefers-color-scheme: light) { :root { --bg: #ffffff; --panel: #f4f4f5; --line: #e4e4e7; --text: #18181b; --text-2: #52525b; --accent: #0369a1; } }
html { background: var(--bg); color: var(--text); font: 15px/1.6 "Segoe UI", system-ui, sans-serif; }
body { margin: 0; }
.trail { position: sticky; top: 0; padding: 8px 24px; background: var(--panel); border-bottom: 1px solid var(--line); color: var(--text-2); font-size: 12px; }
.doc { max-width: 920px; margin: 0 auto; padding: 24px; overflow-wrap: anywhere; }
a { color: var(--accent); }
img { max-width: 100%; }
h1, h2 { border-bottom: 1px solid var(--line); padding-bottom: .3em; }
pre, code { font-family: "Cascadia Mono", Consolas, monospace; font-size: 13px; }
pre { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 12px; overflow-x: auto; }
:not(pre) > code { background: var(--panel); padding: 1px 5px; border-radius: 4px; }
table { border-collapse: collapse; } th, td { border: 1px solid var(--line); padding: 4px 10px; }
blockquote { margin: 0; padding: 0 1em; border-left: 3px solid var(--line); color: var(--text-2); }
.listing { list-style: none; padding: 0; } .listing li { padding: 3px 0; } .listing a { text-decoration: none; }
.note { color: var(--text-2); }
pre.diff span { display: block; } pre.diff .add { color: #4ade80; background: #4ade8014; } pre.diff .del { color: #f87171; background: #f8717114; }
pre.diff .hunk { color: var(--accent); } pre.diff .meta { color: var(--text-2); }
@media (prefers-color-scheme: light) { pre.diff .add { color: #15803d; } pre.diff .del { color: #b91c1c; } }
`;
