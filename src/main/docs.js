// Serves acc://doc/<Hub node id> on the browse session, so documents open in ordinary
// sandboxed tabs under Houston's own sidebar. The shell's acc://shell lives on
// the shell's session; tabs can't reach it. See src/shared/docs.js for the page.
//
// acc://run/<task>/<run> is a Cronsole run's output, acc://git/<path>?area=… a file's
// diff in the workspace's repo, acc://dev/<id> a dev server's log, and acc://runlog/<id> a terminal_run
// run's output, on the same pages; the app opens those, never a
// web page (see serveAppPage).
//
// Only ids in Project Hub's own index are served. Text comes from Hub's /api/file
// (Hub renders Markdown and refuses paths outside its roots); images are read here,
// and only for a request from a document page, so a web page can't probe for them.

import fs from 'node:fs/promises';
import { hub } from './hub.js';
import { DOC_HEADERS, docIdFromUrl, docPage, escapeHtml, folderBody, imageType } from '../shared/docs.js';
import { absPath, flatten, isContainer } from '../shared/tree.js';

const INDEX_TTL_MS = 30_000;

/** @type {{ at: number, scan: Awaited<ReturnType<typeof hub.scan>>, byId: Map<string, { node: import('../shared/tree.js').HubNode, path: string }> } | null} */
let index = null;

async function lookup() {
  if (!index || Date.now() - index.at > INDEX_TTL_MS) {
    const scan = await hub.scan();
    index = { at: Date.now(), scan, byId: new Map(flatten(scan.tree).map((e) => [e.node.id, e])) };
  }
  return index;
}

/** Drop the cached index so the next acc://doc request rescans (Hub changed). */
export function invalidateDocsIndex() {
  index = null;
}

/**
 * @param {number} status
 * @param {string} title
 * @param {string} text
 */
const notePage = (status, title, text) => new Response(
  docPage({ title, trail: title, body: `<p class="note">${escapeHtml(text)}</p>` }),
  { status, headers: { ...DOC_HEADERS, 'content-type': 'text/html; charset=utf-8' } },
);

/**
 * A page only the app opens (a Cronsole run, a Git diff, a dev server's log, a terminal_run run). Navigation is refused from any
 * page (isAllowedNavigation), and a request a page makes carries its referrer, so a web
 * page can't fetch or embed one either; only another page of the same kind may.
 * @param {GlobalRequest} req
 * @param {RegExp} kind the address prefix
 * @param {string} title for the error page
 * @param {(url: string) => Promise<string>} render
 */
async function serveAppPage(req, kind, title, render) {
  const referrer = req.headers.get('referer') || req.referrer || '';
  if (referrer && !kind.test(referrer)) return new Response(null, { status: 403, headers: DOC_HEADERS });
  try {
    return new Response(await render(req.url), { headers: { ...DOC_HEADERS, 'content-type': 'text/html; charset=utf-8' } });
  } catch (err) {
    return notePage(502, title, err instanceof Error ? err.message : String(err));
  }
}

/**
 * @param {Electron.Session} session
 * @param {(url: string) => Promise<string>} runPage acc://run pages, from src/main/cronsole.js
 * @param {(url: string) => Promise<string>} gitPage acc://git pages, from src/main/git.js
 * @param {(url: string) => Promise<string>} devPage acc://dev pages, from src/main/devservers.js
 * @param {(url: string) => Promise<string>} runLogPage acc://runlog pages, from the run history in src/main/main.js
 */
export function serveDocs(session, runPage, gitPage, devPage, runLogPage) {
  session.protocol.handle('acc', async (req) => {
    if (/^acc:\/\/run\//i.test(req.url)) return serveAppPage(req, /^acc:\/\/run\//i, 'Cronsole run', runPage);
    if (/^acc:\/\/git\//i.test(req.url)) return serveAppPage(req, /^acc:\/\/git\//i, 'Git diff', gitPage);
    if (/^acc:\/\/dev\//i.test(req.url)) return serveAppPage(req, /^acc:\/\/dev\//i, 'Dev server', devPage);
    if (/^acc:\/\/runlog\//i.test(req.url)) return serveAppPage(req, /^acc:\/\/runlog\//i, 'Run', runLogPage);
    let id;
    try {
      id = docIdFromUrl(req.url);
    } catch {
      return notePage(400, 'Not a document', 'This address doesn\'t name a Project Hub file or folder.');
    }
    let found;
    try {
      const { scan, byId } = await lookup();
      const entry = byId.get(id);
      if (!entry) return notePage(404, 'Not found', 'Project Hub has no file or folder at this address. It may have moved, or Hub hasn\'t rescanned yet.');
      found = { scan, ...entry };
    } catch (err) {
      return notePage(502, 'Project Hub unavailable', err instanceof Error ? err.message : String(err));
    }
    const { node, path: trail, scan } = found;
    const html = (/** @type {string} */ body) => new Response(docPage({ title: node.name, trail, body }), {
      headers: { ...DOC_HEADERS, 'content-type': 'text/html; charset=utf-8' },
    });

    if (isContainer(node)) return html(folderBody(node, isContainer));

    const type = imageType(node.name);
    if (type) {
      // An <img> in a document gets the bytes; opening the image itself gets a page
      // around it, whose <img> comes back here with a document referrer.
      const referrer = req.headers.get('referer') || req.referrer || '';
      if (!/^acc:\/\/doc\//i.test(referrer)) return html(`<img src="${escapeHtml(req.url)}" alt="${escapeHtml(node.name)}">`);
      const file = absPath(node.id, scan);
      try {
        return new Response(await fs.readFile(/** @type {string} */ (file)), { headers: { ...DOC_HEADERS, 'content-type': type } });
      } catch {
        return new Response(null, { status: 404, headers: DOC_HEADERS });
      }
    }

    try {
      const { html: body } = await hub.file(id);
      return html(body);
    } catch (err) {
      return notePage(502, node.name, err instanceof Error ? err.message : String(err));
    }
  });
}
