// `npm run smoke`: the end-to-end run scripts/smoke.js drives. Kept out of main.js so
// the main process stays thin; main.js calls it only when ACC_SMOKE_DIR is set.
// Each observation is a named check. Checks that need Project Hub or Cronsole count only
// with ACC_SMOKE_LIVE=1 (npm run smoke -- --live); without it they're reported, not
// failed. The verdict goes to <dir>/summary.json and the process exit code.

import { app } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { installExtension } from 'electron-chrome-web-store';
import { listExtensions } from './extensions.js';
import { cleanOutput } from '../shared/output.js';
import { docsTasks } from '../shared/cronsole.js';

/** @typedef {import('./tabs.js').Tabs} Tabs */
/** @typedef {import('./terminal.js').Terminals} Terminals */

/**
 * `npm run smoke`: forward the shell's console to stdout, open one page, and save
 * screenshots of the shell and the page, then quit. See scripts/smoke.js.
 * @param {string} dir
 * @param {Electron.WebContents} wc the shell view's webContents
 * @param {Tabs} tabs
 * @param {Terminals} terminals
 * @param {Electron.Session} browseSession
 */
export function smoke(dir, wc, tabs, terminals, browseSession) {
  const live = process.env.ACC_SMOKE_LIVE === '1';
  /** @type {{ name: string, result: 'pass' | 'fail' | 'skip' | 'warn', detail?: string }[]} */
  const results = [];
  /**
   * @param {string} name
   * @param {unknown} ok
   * @param {unknown} [detail]
   * @param {{ live?: boolean, warnOnly?: boolean }} [opts] live: needs Hub or Cronsole; warnOnly: flaky, never fails the run
   */
  const check = (name, ok, detail, { live: needsLive = false, warnOnly = false } = {}) => {
    const result = ok ? 'pass' : warnOnly ? 'warn' : needsLive && !live ? 'skip' : 'fail';
    results.push({ name, result, ...(detail !== undefined && { detail: String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 300) }) });
    console.log(`[smoke] ${result.toUpperCase()} ${name}${ok ? '' : ` (${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 200)})`}`);
  };
  /** A screenshot, which can fail on a hidden or locked display; never fails the run. @param {string} file @param {Electron.WebContents} from */
  const shot = async (file, from) => {
    try {
      fs.writeFileSync(path.join(dir, file), (await from.capturePage()).toPNG());
    } catch (err) {
      check(`screenshot ${file}`, false, err instanceof Error ? err.message : err, { warnOnly: true });
    }
  };
  const finish = () => {
    const failed = results.filter((r) => r.result === 'fail').length;
    const summary = { live, passed: results.filter((r) => r.result === 'pass').length, failed, skipped: results.filter((r) => r.result === 'skip').length, warnings: results.filter((r) => r.result === 'warn').length, checks: results };
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
    console.log(`[smoke] ${failed ? 'FAILED' : 'passed'}: ${summary.passed} passed, ${failed} failed, ${summary.skipped} skipped (live checks need --live), ${summary.warnings} warnings. ${path.join(dir, 'summary.json')}`);
    process.exitCode = failed ? 1 : 0;
    app.quit();
  };
  wc.on('console-message', (e) => console.log(`[shell:${e.level}] ${e.message}`));
  wc.on('preload-error', (_e, p, err) => console.log(`[shell:preload-error] ${p}: ${err.message}`));
  // Extension service workers log here, not to any page; the extension spike needs it.
  browseSession.serviceWorkers.on('console-message', (_e, d) => console.log(`[sw:${d.level}] ${d.sourceUrl}:${d.lineNumber} ${String(d.message).slice(0, 300)}`));
  wc.once('did-finish-load', async () => {
    try {
      await run();
    } catch (err) {
      check('the run finished', false, err instanceof Error ? err.stack || err.message : err);
    }
    finish();
  });

  async function run() {
    const wait = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
    await wait(4000);
    // ACC_SMOKE_INSTALL=<id>,<id>: install Web Store extensions first (the extension spike).
    for (const id of (process.env.ACC_SMOKE_INSTALL || '').split(',').filter(Boolean)) {
      try {
        const ext = await installExtension(id, { session: browseSession });
        console.log(`[smoke] installed ${id}: ${ext?.name} ${ext?.version} (MV${ext?.manifest?.manifest_version})`);
      } catch (err) {
        console.log(`[smoke] install ${id} FAILED: ${err instanceof Error ? err.message : err}`);
      }
    }
    const tab = tabs.create(process.env.ACC_SMOKE_URL || 'https://example.com');
    await wait(Number(process.env.ACC_SMOKE_WAIT_MS || 16000));
    // Drive the sidebar the way a person would: expand the first root, then search.
    const checks = await wc.executeJavaScript(`(async () => {
      const first = document.querySelector('#panel-files .row');
      first?.click();
      const expanded = document.querySelectorAll('#panel-files .row').length;
      const s = document.getElementById('search');
      s.value = 'README';
      s.dispatchEvent(new Event('input'));
      await new Promise((r) => setTimeout(r, 500));
      const results = document.querySelectorAll('#panel-search .row').length;
      const groups = [...document.querySelectorAll('#panel-search .group-title')].map((g) => g.textContent);
      const terminals = document.querySelectorAll('.term-tab').length;
      return { expandedRows: expanded, searchResults: results, groups, terminals, hubDot: document.getElementById('hub-status').className };
    })()`);
    console.log(`[smoke] shell checks=${JSON.stringify(checks)}`);
    check('a terminal opened at start', checks.terminals >= 1, checks);
    check('Hub: the Files tree loads and expands', checks.expandedRows > 1 && /ok/.test(checks.hubDot), checks, { live: true });
    check('Hub: the search box finds README files', checks.searchResults > 0, checks, { live: true });
    fs.mkdirSync(dir, { recursive: true });
    await shot('tab.png', tab.view.webContents);
    console.log(`[smoke] tab url=${tab.view.webContents.getURL()} title=${tab.view.webContents.getTitle()}`);
    if (!process.env.ACC_SMOKE_URL) check('a tab loads example.com', /^https:\/\/example\.com/.test(tab.view.webContents.getURL()) && /Example/.test(tab.view.webContents.getTitle()), tab.view.webContents.getURL());
    console.log(`[smoke] tab bounds=${JSON.stringify(tab.view.getBounds())}`);
    console.log(`[smoke] extensions=${JSON.stringify(listExtensions(browseSession))}`);
    // The MCP server as a client would find it: no token must fail, the file's token must work.
    try {
      const { url, token } = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'mcp.json'), 'utf8'));
      const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
      const without = (await fetch(url, { method: 'POST', body })).status;
      const withToken = (await fetch(url, { method: 'POST', body, headers: { Authorization: `Bearer ${token}` } })).status;
      console.log(`[smoke] mcp ${url} without-token=${without} with-token=${withToken}`);
      check('MCP refuses a call without the token and answers with it', without === 401 && withToken === 200, { without, withToken });
      const call = (/** @type {string} */ name, /** @type {object} */ args) => fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }),
      }).then((r) => r.json()).then((r) => r.result?.structuredContent ?? r);
      const opened = await call('open_tab', { url: 'example.org', background: true });
      console.log(`[smoke] mcp open_tab=${JSON.stringify(opened)}`);
      check('open_tab opens a tab', Number.isInteger(opened?.id) && /example\.org/.test(opened?.url), opened);
      const listed = await call('list_tabs', {});
      const found = await call('sidebar_search', { query: 'README', limit: 5 });
      const recent = await call('recent', { limit: 3 });
      console.log(`[smoke] mcp list_tabs=${JSON.stringify(listed)}`);
      check('list_tabs lists the opened tab', listed?.tabs?.some((/** @type {any} */ t) => t.id === opened?.id), listed);
      check('sidebar_search answers', Array.isArray(found?.bookmarks) && Array.isArray(found?.recent), found?.errors);
      check('Hub: sidebar_search finds files', found?.files?.length > 0, found?.errors, { live: true });
      console.log(`[smoke] mcp sidebar_search files=${found.files?.length} bookmarks=${found.bookmarks?.length} recent=${found.recent?.length} errors=${JSON.stringify(found.errors)}`);
      console.log(`[smoke] mcp recent items=${recent.items?.length}`);
      // terminal_run waits on the confirm bar; click Run the way a person would.
      // Prints the URL the terminal was given, so shell.png shows ACC_MCP_URL arrived.
      const ran = call('terminal_run', { command: 'Write-Output "acc-smoke $env:ACC_MCP_URL"' });
      await wait(500);
      const shown = await wc.executeJavaScript(`(() => {
        const bar = document.getElementById('confirm-bar');
        const text = bar.hidden ? null : document.getElementById('confirm-cmd').textContent;
        document.getElementById('confirm-run').click();
        return text;
      })()`);
      const ranOut = await ran;
      console.log(`[smoke] mcp terminal_run bar=${JSON.stringify(shown)} result=${JSON.stringify(ranOut)}`);
      check('terminal_run shows the exact command on the bar and runs on Run', shown === 'Write-Output "acc-smoke $env:ACC_MCP_URL"' && ranOut?.ran === true, { shown, ranOut });
      // The loop closed: the terminal's output and the page's text, read back.
      // Wait for the output: a fresh PowerShell can take several seconds to print on a busy
      // machine. Polled from the buffer directly, so the MCP log gets one terminal_read.
      const printed = /acc-smoke http:\/\/127\.0\.0\.1:\d+\/mcp/;
      for (let i = 0; i < 30 && !printed.test(cleanOutput(terminals.read(ranOut?.terminal)?.raw || '')); i++) await wait(500);
      const output = await call('terminal_read', { lines: 5 });
      const sessions = await call('list_terminals', {});
      console.log(`[smoke] mcp list_terminals=${JSON.stringify(sessions)}`);
      console.log(`[smoke] mcp terminal_read terminal=${output.terminal} text=${JSON.stringify(output.text?.slice(-200))}`);
      check('terminal_read reads back what the command printed, with the MCP address it was given', output.terminal === ranOut?.terminal && /acc-smoke http:\/\/127\.0\.0\.1:\d+\/mcp/.test(output.text || ''), output.text?.slice(-200));
      check('list_terminals shows the new terminal as active', sessions?.terminals?.some((/** @type {any} */ s) => s.id === ranOut?.terminal && s.active), sessions);
      // Managed runs: the run ends with its session, and its exit code is the result.
      // One that succeeds (the one above), one that fails with a code, one cancelled by
      // closing its terminal. Each needs a Run click, given the way a person would.
      const settle = async (/** @type {number} */ run) => {
        let s = null;
        for (let i = 0; i < 60; i++) {
          s = await call('run_status', { run, lines: 5 });
          if (s?.state && s.state !== 'running') break;
          await wait(250);
        }
        return s;
      };
      const clickRun = () => wc.executeJavaScript(`(() => { const b = document.getElementById('confirm-run'); const shown = !document.getElementById('confirm-bar').hidden; b.click(); return shown; })()`);
      const ok = await settle(ranOut?.run);
      const failing = call('terminal_run', { command: 'Write-Output ("about to " + "fail"); cmd /c exit 3' });
      await wait(500);
      await clickRun();
      const failed = await settle((await failing)?.run);
      const slow = call('terminal_run', { command: 'Start-Sleep -Seconds 60' });
      await wait(500);
      await clickRun();
      const slowRun = await slow;
      await wait(1500);
      const before = await call('run_status', { run: slowRun?.run });
      // The run tab's ×, the way a person cancels it.
      await wc.executeJavaScript(`[...document.querySelectorAll('#term-tabs .term-tab.run')].pop()?.querySelector('.close')?.click()`);
      const cancelled = await settle(slowRun?.run);
      const runRun = { ok, failed, before: before?.state, cancelled };
      console.log(`[smoke] runs=${JSON.stringify(runRun)}`);
      check('terminal_run returns a run id; run_status reports success, a failure\'s exit code, and a cancel from closing the terminal',
        ok?.state === 'succeeded' && ok.exitCode === 0 && /acc-smoke http:\/\/127\.0\.0\.1:\d+\/mcp/.test(ok.output)
        && failed?.state === 'failed' && failed.exitCode === 3 && /about to fail/.test(failed.output)
        && before?.state === 'running' && cancelled?.state === 'cancelled' && cancelled.exitCode === null, runRun);
      // The same three in the MCP panel's Agent work, newest first, each with how it ended.
      const work = await wc.executeJavaScript(`[...document.querySelectorAll('#panel-mcp .row.work')].slice(0, 3).map((r) => [r.className.split(' ').pop(), r.querySelector('.name').textContent, r.querySelector('.sub').textContent])`);
      console.log(`[smoke] work=${JSON.stringify(work)}`);
      check('the MCP panel lists each run under Agent work: what was asked and how it ended',
        JSON.stringify(work.map((/** @type {string[]} */ w) => w[0])) === '["cancelled","failed","succeeded"]'
        && work[0][1] === 'Start-Sleep -Seconds 60' && work[1][2] === 'failed (exit 3)' && work[2][2] === 'finished (exit 0)', work);
      // Run history: searching the MCP panel finds the failing run by its output (its
      // command builds the text, so only the output has it whole), and a click opens its
      // log as a script-free page. runs.json has all three.
      const history = await wc.executeJavaScript(`(async () => {
        const pause = (ms) => new Promise((r) => setTimeout(r, ms));
        const box = document.getElementById('runs-search');
        box.value = 'about to fail';
        box.dispatchEvent(new Event('input'));
        await pause(600);
        const rows = [...document.querySelectorAll('#mcp-list .row.run')].map((r) => [r.querySelector('.name').textContent, r.querySelector('.sub').textContent]);
        document.querySelector('#mcp-list .row.run')?.click();
        box.value = '';
        box.dispatchEvent(new Event('input'));
        return { rows };
      })()`);
      for (let i = 0; i < 40 && !tabs.list().some((t) => t.url.startsWith('acc://runlog/')); i++) await wait(250);
      const runTab = tabs.list().find((t) => t.url.startsWith('acc://runlog/'));
      const runView = runTab && tabs.tabs.get(runTab.id);
      if (runView) {
        for (let i = 0; i < 40 && runView.view.webContents.isLoading(); i++) await wait(100);
        history.page = await runView.view.webContents.executeJavaScript(`({ url: location.href, h1: document.querySelector('h1')?.textContent, note: document.querySelector('.note')?.textContent, text: document.querySelector('pre')?.textContent ?? '', scripts: document.scripts.length })`);
        tabs.close(runTab.id);
      }
      const saved = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'runs.json'), 'utf8'));
      history.saved = saved.map((/** @type {any} */ r) => r.state);
      console.log(`[smoke] history=${JSON.stringify(history)}`);
      check('the MCP panel\'s run search finds a run by its output, and a click opens its log as a page; runs.json keeps the runs',
        history.rows.length === 1 && history.rows[0][0].includes('cmd /c exit 3') && /about to fail/.test(history.rows[0][1])
        && history.page?.url === `acc://runlog/${failed?.run}` && /failed \(exit 3\)/.test(history.page.note || '') && /about to fail/.test(history.page.text) && history.page.scripts === 0
        && JSON.stringify(history.saved.slice(-3)) === '["succeeded","failed","cancelled"]', history);
      console.log(`[smoke] terminal raw tail=${JSON.stringify(terminals.read()?.raw?.slice(-400))}`);
      const page = await call('read_tab', { tab: tab.view.webContents.id });
      console.log(`[smoke] mcp read_tab title=${JSON.stringify(page.title)} chars=${page.text?.length} truncated=${page.truncated} start=${JSON.stringify(page.text?.slice(0, 60))}`);
      if (!process.env.ACC_SMOKE_URL) check('read_tab reads the page text', /Example Domain/.test(page.title || '') && page.text?.length > 0, page.title);
      // cron_tasks answers with the list, or says what to set when Cronsole isn't configured.
      const cronOut = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'cron_tasks', arguments: {} } }),
      }).then((r) => r.json());
      console.log(`[smoke] mcp cron_tasks tasks=${cronOut.result?.structuredContent?.tasks?.length ?? null} error=${JSON.stringify(cronOut.result?.isError ? cronOut.result.content?.[0]?.text?.slice(0, 80) : null)}`);
      check('cron_tasks answers with a list or says what to set', Array.isArray(cronOut.result?.structuredContent?.tasks) || cronOut.result?.isError === true, cronOut.error);
      check('Cronsole: cron_tasks lists tasks', cronOut.result?.structuredContent?.tasks?.length > 0, cronOut.result?.content?.[0]?.text?.slice(0, 120), { live: true });
      // Find in page on example.com: type a word and read the match count.
      tabs.activate(tab.id);
      const finder = await wc.executeJavaScript(`(async () => {
        document.getElementById('find-form').hidden = false;
        const i = document.getElementById('find-input');
        i.value = 'domain';
        i.dispatchEvent(new Event('input'));
        await new Promise((r) => setTimeout(r, 800));
        const count = document.getElementById('find-count').textContent;
        document.getElementById('find-close').click();
        return { count, hidden: document.getElementById('find-form').hidden };
      })()`);
      console.log(`[smoke] find=${JSON.stringify(finder)}`);
      if (!process.env.ACC_SMOKE_URL) check('find in page counts matches and closes', /^[1-9]\d*\/[1-9]\d*$/.test(finder.count) && finder.hidden, finder);
      // Browser actions on example.com, attached the way its right-click menu would: a field
      // added for the check (pinned on top: the page's own script draws over its middle),
      // filled, then the page's link clicked, each after Run on the bar.
      if (!process.env.ACC_SMOKE_URL) {
        const page = tab.view.webContents;
        const unattached = await call('tab_elements', {});
        tabs.setAgentTab(tab.id);
        await page.executeJavaScript(`document.body.insertAdjacentHTML('afterbegin', '<input aria-label="smoke field" style="position:fixed;top:8px;left:8px;z-index:2147483647">')`);
        const listed = await call('tab_elements', {});
        const field = listed?.elements?.find((/** @type {any} */ e) => e.label === 'smoke field');
        const link = listed?.elements?.find((/** @type {any} */ e) => e.tag === 'a');
        const shotOut = await fetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'tab_screenshot', arguments: {} } }),
        }).then((r) => r.json());
        const image = shotOut.result?.content?.[0];
        /** Answer the bar with Run and say what it showed. */
        const runBar = () => wc.executeJavaScript(`(() => {
          const shown = document.getElementById('confirm-bar').hidden ? null : [document.getElementById('confirm-cmd').textContent, document.getElementById('confirm-where').textContent];
          document.getElementById('confirm-run').click();
          return shown;
        })()`);
        const filling = call('tab_fill', { ref: field?.ref, text: 'hello smoke' });
        await wait(500);
        const fillBar = await runBar();
        const filled = await filling;
        const value = await page.executeJavaScript(`document.querySelector('input[aria-label="smoke field"]')?.value`);
        const clicking = call('tab_click', { ref: link?.ref });
        await wait(500);
        const clickBar = await runBar();
        const clicked = await clicking;
        for (let i = 0; i < 40 && /^https:\/\/example\.com/.test(page.getURL()); i++) await wait(250);
        const after = page.getURL();
        console.log(`[smoke] tab actions unattached=${JSON.stringify(unattached?.result?.content?.[0]?.text ?? unattached)} elements=${JSON.stringify(listed?.elements)} image=${image?.type}:${image?.data?.length} fill=${JSON.stringify([fillBar, filled, value])} click=${JSON.stringify([clickBar, clicked])} after=${after}`);
        check('tab_elements needs an attached tab, then lists its field and link; tab_screenshot gives an image',
          /attached/.test(String(unattached?.result?.content?.[0]?.text)) && field?.fillable === true && link && image?.type === 'image' && image.data.length > 1000, { unattached, field, link, image: image?.type });
        check('tab_fill and tab_click show the element and host on the bar, then type and click for real',
          fillBar?.[0] === 'type "hello smoke" into text field "smoke field"' && /example\.com/.test(fillBar?.[1]) && filled?.filled === true && value === 'hello smoke'
          && /^click link /.test(clickBar?.[0]) && clicked?.clicked === true && !/^https:\/\/example\.com/.test(after), { fillBar, filled, value, clickBar, clicked, after });
        tabs.setAgentTab(null);
        page.navigationHistory.goBack();
        for (let i = 0; i < 40 && !/^https:\/\/example\.com/.test(page.getURL()); i++) await wait(250);
        await wait(1000);
      }
    } catch (err) {
      check('the MCP checks ran', false, err instanceof Error ? err.message : err);
    }
    // The shell menu's profiles, a non-PowerShell session, and a Files click landing
    // on a document page (the right-click menu itself is native and needs a person).
    const shellChecks = await wc.executeJavaScript(`(async () => {
      const shells = (await window.acc.info()).shells.map((s) => s.id);
      const cmd = await window.acc.term.create({ shell: 'cmd' });
      await window.acc.term.kill(cmd.id);
      const md = [...document.querySelectorAll('#panel-search .row')].find((r) => /\\.md$/i.test(r.querySelector('.name')?.textContent || ''));
      md?.click();
      return { shells, cmd: [cmd.shell, cmd.powershell], clicked: md?.querySelector('.name')?.textContent ?? null };
    })()`);
    // Hub renders the file first; give it up to 10 s rather than a fixed wait.
    for (let i = 0; i < 40 && !tabs.list().some((t) => t.url.startsWith('acc://doc/')); i++) await wait(250);
    await wait(1000);
    console.log(`[smoke] shells=${JSON.stringify(shellChecks)} tabs=${JSON.stringify(tabs.list().map((t) => t.url))}`);
    check('the shell menu offers PowerShell 7, and Command Prompt starts as not-PowerShell', shellChecks.shells.includes('pwsh') && shellChecks.cmd[1] === false, shellChecks);
    const doc = tabs.list().find((t) => t.url.startsWith('acc://doc/'));
    const docTab = doc && tabs.tabs.get(doc.id);
    if (docTab) {
      const page = await docTab.view.webContents.executeJavaScript(
        `({ title: document.title, headings: document.querySelectorAll('h1, h2').length, images: [...document.images].map((i) => [i.src.slice(0, 60), i.naturalWidth]).slice(0, 3), sidebar: Boolean(document.querySelector('aside, nav#sidebar')) })`);
      console.log(`[smoke] doc page=${JSON.stringify(page)}`);
      check('Hub: a Markdown file opens as a document page without a second sidebar', page.headings > 0 && !page.sidebar, page, { live: true });
      await shot('doc.png', docTab.view.webContents);
    } else {
      check('Hub: a Markdown file opens as a document page', false, 'no acc://doc tab', { live: true });
    }
    // The MCP calls above, in the sidebar's MCP panel and at the end of mcp.log.
    const panel = await wc.executeJavaScript(`[...document.querySelectorAll('#panel-mcp .row .name')].map((n) => n.textContent.split(' ')[0]).slice(0, 20)`);
    const logged = fs.readFileSync(path.join(app.getPath('userData'), 'logs', 'mcp.log'), 'utf8').trim().split('\n').slice(-20)
      .map((l) => { const e = JSON.parse(l); return `${e.tool || e.method}:${e.ok ? 'ok' : e.status || 'err'}`; });
    console.log(`[smoke] mcp log panel=${JSON.stringify(panel)} file=${JSON.stringify(logged)}`);
    check('MCP calls show in the panel and in mcp.log', panel.includes('terminal_run') && logged.some((/** @type {string} */ l) => l.startsWith('terminal_run:')), { panel, logged });
    // The Chat tab: what it tells the user (model and missing variables only; the key never leaves main).
    // + page reads the active tab, so make that example.com rather than whatever an earlier check left.
    const example = tabs.list().find((t) => /^https:\/\/example\.com/.test(t.url));
    if (example) tabs.activate(example.id);
    await wait(300);
    const chatPanel = await wc.executeJavaScript(`(async () => {
      const s = document.getElementById('search');
      s.value = '';
      s.dispatchEvent(new Event('input'));
      await new Promise((r) => setTimeout(r, 300));
      // The chat pane opens on the right, beside the sidebar, and the browser area gives up its width.
      const contentBefore = document.getElementById('content').getBoundingClientRect().width;
      if (document.getElementById('app').classList.contains('no-chat')) document.getElementById('chat-toggle').click();
      await new Promise((r) => setTimeout(r, 300));
      const pane = {
        width: Math.round(document.getElementById('chat-pane').getBoundingClientRect().width),
        shrunk: Math.round(contentBefore - document.getElementById('content').getBoundingClientRect().width),
        filesShown: !document.getElementById('panel-files').hidden && !document.getElementById('app').classList.contains('no-sidebar'),
        pressed: document.getElementById('chat-toggle').getAttribute('aria-pressed'),
      };
      // + page reads the active tab into the context tray; the row says what it is and
      // holds the exact text that would go; ✕ takes it out.
      const tray = document.getElementById('chat-tray');
      document.getElementById('chat-attach-page').click();
      for (let i = 0; i < 150 && tray.hidden; i++) await new Promise((r) => setTimeout(r, 100));
      const row = tray.querySelector('.tray-item');
      const shownRow = row && {
        label: row.querySelector('.tray-label').textContent,
        detail: row.querySelector('.tray-detail').textContent,
        exact: row.querySelector('pre').textContent.slice(0, 80),
        dest: document.getElementById('chat-tray-dest').textContent,
      };
      row?.querySelector('.tray-remove').click();
      return { info: await window.acc.chat.info(), pane, shownRow, removed: tray.hidden, shown: document.getElementById('chat-log').textContent.slice(-200) };
    })()`);
    console.log(`[smoke] chat=${JSON.stringify(chatPanel)}`);
    check('the Chat panel never gets the key', Array.isArray(chatPanel.info?.missing) && !('apiKey' in (chatPanel.info || {})), chatPanel.info);
    const pn = chatPanel.pane;
    check('💬 opens the chat pane on the right beside Files, and the browser area narrows to make room',
      pn.width >= 260 && Math.abs(pn.shrunk - pn.width - 4) <= 2 && pn.filesShown && pn.pressed === 'true', pn);
    const tr = chatPanel.shownRow;
    check('+ page puts the tab in the context tray with its exact text and destination, and ✕ removes it',
      Boolean(tr && tr.label.startsWith('Page: ') && /characters/.test(tr.detail) && tr.exact.startsWith('{') && /api\.anthropic\.com/.test(tr.dest) && chatPanel.removed), tr);
    // Conversations: scripts/smoke.js seeds an old chat.json, which should arrive as the
    // first listed conversation; then search, rename, New, open it again, delete it.
    if (process.env.ACC_SMOKE_SEEDED === '1') {
      const convRun = await wc.executeJavaScript(`(async () => {
        const pause = (ms) => new Promise((r) => setTimeout(r, ms));
        const $ = (id) => document.getElementById(id);
        const names = () => [...document.querySelectorAll('#chat-conv-list .conv-row .conv-name')].map((e) => e.textContent);
        const search = async (q) => { $('chat-conv-search').value = q; $('chat-conv-search').dispatchEvent(new Event('input')); await pause(400); };
        $('chat-conv-title').click();
        await pause(400);
        const migrated = names();
        await search('RELEASE ship');
        const hit = { names: names(), snippet: document.querySelector('#chat-conv-list .conv-snippet')?.textContent || '' };
        await search('nothing-like-this');
        const miss = names().length;
        const { list } = await window.acc.chat.list('');
        await window.acc.chat.rename(list[0].id, 'Shipping notes');
        await search('');
        const renamed = names();
        $('chat-new').click();
        await pause(400);
        const fresh = { title: $('chat-conv-title').textContent, users: document.querySelectorAll('#chat-log .chat-msg.user').length };
        $('chat-conv-title').click();
        await pause(400);
        document.querySelector('#chat-conv-list .conv-row').click();
        await pause(400);
        const reopened = { title: $('chat-conv-title').textContent, log: $('chat-log').textContent.includes('how do I ship acme-api') };
        $('chat-conv-title').click();
        await pause(400);
        const del = document.querySelector('#chat-conv-list .conv-delete');
        del.click();
        const armed = del.textContent;
        del.click();
        await pause(500);
        const after = { names: names(), title: $('chat-conv-title').textContent };
        $('chat-conv-title').click();
        return { migrated, hit, miss, renamed, fresh, reopened, armed, after };
      })()`);
      const dataDir = app.getPath('userData');
      const files = { legacy: fs.existsSync(path.join(dataDir, 'chat.json')), index: fs.existsSync(path.join(dataDir, 'chats', 'default', 'index.json')) };
      console.log(`[smoke] conversations=${JSON.stringify(convRun)} files=${JSON.stringify(files)}`);
      check('an old chat.json becomes the first conversation; search, rename, New, reopen and delete work',
        convRun.migrated[0] === 'Smoke: how do I ship acme-api?' && convRun.hit.names.length === 1 && /release/i.test(convRun.hit.snippet) && convRun.miss === 0
        && convRun.renamed[0] === 'Shipping notes' && /^New conversation/.test(convRun.fresh.title) && convRun.fresh.users === 0
        && /^Shipping notes/.test(convRun.reopened.title) && convRun.reopened.log && convRun.armed === 'Delete?'
        && convRun.after.names.length === 0 && /^New conversation/.test(convRun.after.title) && !files.legacy && files.index, { convRun, files });
    }
    // The Cron tab (Cronsole's tasks through its MCP server, when ACC_CRONSOLE_MCP is set):
    // the first task with recorded runs unfolds them and its newest opens as an acc://run
    // page; then Open Cronsole twice: one pinned tab, first in the strip, reused.
    const cronPanel = await wc.executeJavaScript(`(async () => {
      document.querySelector('.side-tabs [data-panel="cron"]').click();
      for (let i = 0; i < 60 && /Asking/.test(document.getElementById('cron-list').textContent); i++) await new Promise((r) => setTimeout(r, 500));
      const docs = document.getElementById('cron-docs');
      docs.click();
      const docsRows = [...document.querySelectorAll('#cron-list .row.task')].map((r) => r.querySelector('.name').textContent);
      docs.click();
      const rows = [...document.querySelectorAll('#cron-list .row.task')];
      let runs = [];
      let runsNote = null;
      for (const row of rows.filter((r) => /Last run:/.test(r.title)).slice(0, 8)) {
        row.click();
        for (let i = 0; i < 40 && /Asking/.test(row.nextElementSibling?.textContent || ''); i++) await new Promise((r) => setTimeout(r, 250));
        runs = [...(row.nextElementSibling?.querySelectorAll('.row.run') || [])];
        if (runs.length) break;
        runsNote ??= row.nextElementSibling?.textContent.slice(0, 120) ?? null;
        row.click();
      }
      runs[0]?.click();
      await new Promise((r) => setTimeout(r, 2000));
      document.getElementById('cron-open').click();
      await new Promise((r) => setTimeout(r, 1500));
      document.getElementById('cron-open').click();
      await new Promise((r) => setTimeout(r, 500));
      const pinned = document.querySelectorAll('#tab-list .tab.pinned');
      return {
        info: await window.acc.cronsole.info(),
        tasks: rows.length,
        docsRows,
        docsPressed: docs.getAttribute('aria-pressed'),
        list: rows.length ? await window.acc.cronsole.tasks() : [],
        first: rows.slice(0, 3).map((r) => r.querySelector('.name').textContent + ' · ' + r.querySelector('.sub').textContent),
        note: rows.length ? null : document.getElementById('cron-list').textContent.slice(0, 200),
        runs: runs.slice(0, 2).map((r) => r.querySelector('.name').textContent),
        runsNote: runs.length ? null : runsNote,
        pinnedTabs: pinned.length,
        pinnedFirst: document.querySelector('#tab-list .tab') === pinned[0],
        badge: document.querySelector('.side-tabs [data-panel="cron"] .tab-badge')?.textContent ?? '0',
        failedActive: rows.filter((r) => r.classList.contains('failed') && /Status: ACTIVE/.test(r.title)).length,
      };
    })()`);
    console.log(`[smoke] cronsole=${JSON.stringify({ ...cronPanel, list: cronPanel.list.length })} tabs=${JSON.stringify(tabs.list().map((t) => t.url))}`);
    check('Cronsole: the Cron tab lists tasks and Open Cronsole keeps one pinned tab first', cronPanel.tasks > 0 && cronPanel.pinnedTabs === 1 && cronPanel.pinnedFirst, cronPanel.note ?? cronPanel.info, { live: true });
    const docsNames = docsTasks(cronPanel.list).map((t) => t.name);
    check('Cronsole: the Docs button shows only the docs upkeep tasks, and again all of them', cronPanel.tasks > 0 && cronPanel.docsPressed === 'false'
      && JSON.stringify(cronPanel.docsRows) === JSON.stringify(docsNames), { docsRows: cronPanel.docsRows, docsNames }, { live: true });
    check('Cronsole: the Cron tab\'s label counts the active tasks whose last run failed', cronPanel.tasks > 0 && cronPanel.badge === String(cronPanel.failedActive), { badge: cronPanel.badge, failedActive: cronPanel.failedActive }, { live: true });
    const run = tabs.list().find((t) => t.url.startsWith('acc://run/'));
    const runTab = run && tabs.tabs.get(run.id);
    if (runTab) {
      const page = await runTab.view.webContents.executeJavaScript(
        `({ title: document.title, facts: document.querySelector('.note')?.textContent, output: document.querySelector('pre')?.textContent.length ?? null, none: /no output/.test(document.body.textContent) })`);
      console.log(`[smoke] run page=${JSON.stringify(page)}`);
      check('Cronsole: a run opens as a page', Boolean(page.title), page, { live: true });
    }
    // The command palette: Ctrl+K's menu action opens it, typing filters, Enter runs the pick.
    wc.send('shortcut', 'palette');
    await wait(500);
    await shot('palette.png', wc);
    const pal = await wc.executeJavaScript(`(async () => {
      const dlg = document.getElementById('palette');
      const input = document.getElementById('palette-input');
      const open = dlg.open;
      const all = document.querySelectorAll('#palette-list .pal-row').length;
      const kinds = [...document.querySelectorAll('#palette-list .pal-row .icon')].map((i) => i.textContent);
      input.value = 'show recent';
      input.dispatchEvent(new Event('input'));
      const first = document.querySelector('#palette-list .pal-row.active .name')?.textContent;
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise((r) => setTimeout(r, 200));
      return { open, all, tabs: kinds.filter((k) => k === '🌐').length, terminals: kinds.filter((k) => k === '>_').length, first, closed: !dlg.open,
        panel: document.querySelector('.side-tabs [aria-selected="true"]')?.dataset.panel };
    })()`);
    console.log(`[smoke] palette=${JSON.stringify(pal)}`);
    check('Ctrl+K opens the palette with tabs and terminals, and Enter runs the top match', pal.open && pal.tabs === tabs.list().length && pal.terminals > 0
      && pal.first === 'Show Recent' && pal.closed && pal.panel === 'recent', pal);
    // Connections: the status dot opens it, every row has a state, and Retry rechecks one row.
    const conn = await wc.executeJavaScript(`(async () => {
      const wait = async (ok) => { for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 100)); };
      const dlg = document.getElementById('connections');
      document.getElementById('hub-status').click();
      // Each group fills in on its own; Cronsole's (listing every task) is the slow one.
      const settled = () => dlg.querySelector('.conn-row') && !dlg.querySelector('.conn-row.checking');
      for (let i = 0; i < 300 && !settled(); i++) await new Promise((r) => setTimeout(r, 100));
      const rows = [...dlg.querySelectorAll('.conn-row')].map((r) => r.dataset.id + ':' + r.className.replace('conn-row ', ''));
      dlg.querySelector('.conn-row[data-id="mcp"] .conn-retry')?.click();
      await new Promise((r) => setTimeout(r, 50));
      await wait(settled);
      const mcpAfter = dlg.querySelector('.conn-row[data-id="mcp"]')?.className;
      const open = dlg.open;
      document.getElementById('connections-close').click();
      return { open, rows, mcpAfter, closed: !dlg.open };
    })()`);
    console.log(`[smoke] connections=${JSON.stringify(conn)}`);
    const ids = conn.rows.map((/** @type {string} */ r) => r.split(':').slice(0, -1).join(':'));
    check('the status dot opens Connections: Hub, Cronsole, each shell, chat and MCP, and Retry rechecks a row',
      conn.open && conn.closed && ['hub', 'cronsole', 'shell:pwsh', 'chat', 'mcp'].every((id) => ids.includes(id))
      && conn.rows.includes('mcp:ok') && conn.mcpAfter === 'conn-row ok', conn);
    // A workspace round trip: its own tabs and terminal, and everything back on return.
    const spaceRun = await wc.executeJavaScript(`(async () => {
      const seen = () => ({
        tabs: document.querySelectorAll('#tab-list .tab').length,
        terms: [...document.querySelectorAll('#term-tabs .term-tab')].filter((t) => !t.hidden).map((t) => t.title),
      });
      // Poll rather than guess: a fresh shell can take a few seconds to start on a busy machine.
      const settle = async (/** @type {(s: any) => boolean} */ done) => {
        for (let i = 0; i < 100 && !done(seen()); i++) await new Promise((r) => setTimeout(r, 100));
        await new Promise((r) => setTimeout(r, 500));
        return seen();
      };
      const before = seen();
      const added = await window.acc.workspace.add({ folder: ${JSON.stringify(os.tmpdir())}, name: 'Smoke space' });
      const inside = { active: added.active, ...(await settle((s) => s.tabs === 0 && s.terms.length > 0)), button: document.getElementById('workspace').textContent };
      await window.acc.workspace.switch('default');
      const back = await settle((s) => s.tabs === before.tabs && s.terms.length === before.terms.length);
      const left = (await window.acc.workspace.remove(added.active)).list.length;
      return { before, inside, back, left };
    })()`);
    console.log(`[smoke] workspace=${JSON.stringify(spaceRun)} sessions=${terminals.listSessions().length}`);
    check('a workspace switch swaps the tabs and terminals, and switching back restores them',
      spaceRun.inside.active === 'smoke-space' && spaceRun.inside.tabs === 0 && spaceRun.inside.terms.length === 1 && spaceRun.inside.terms[0] === os.tmpdir()
      && /Smoke space/.test(spaceRun.inside.button) && spaceRun.back.tabs === spaceRun.before.tabs
      && spaceRun.back.terms.length === spaceRun.before.terms.length && spaceRun.left === 1
      && terminals.listSessions().length === spaceRun.before.terms.length + 1, spaceRun);
    // The Git tab on a throwaway repo: one staged, one unstaged and one untracked file,
    // opened as a workspace; a click opens the diff as an acc://git page. The repo sits in
    // the throwaway profile, which scripts/smoke.js deletes once the app has quit (Windows
    // won't let it go while the app runs); with --profile it falls back to the temp folder.
    const repo = process.env.ACC_USER_DATA
      ? fs.mkdtempSync(path.join(app.getPath('userData'), 'git-'))
      : fs.mkdtempSync(path.join(os.tmpdir(), 'acc-git-'));
    let gitRun = null;
    try {
      const g = (/** @type {string[]} */ ...a) => execFileSync('git', ['-c', 'user.name=smoke', '-c', 'user.email=smoke@example.invalid', ...a], { cwd: repo, stdio: 'pipe' });
      g('init', '-q', '-b', 'smoke-branch');
      fs.writeFileSync(path.join(repo, 'staged.txt'), 'one\n');
      fs.writeFileSync(path.join(repo, 'edited.txt'), 'before\n');
      g('add', '.');
      g('commit', '-q', '-m', 'first');
      fs.writeFileSync(path.join(repo, 'staged.txt'), 'one\ntwo\n');
      g('add', 'staged.txt');
      fs.writeFileSync(path.join(repo, 'edited.txt'), 'after <b>\n');
      fs.writeFileSync(path.join(repo, 'new.txt'), 'brand new\n');
      gitRun = await wc.executeJavaScript(`(async () => {
        const pause = (ms) => new Promise((r) => setTimeout(r, ms));
        const added = await window.acc.workspace.add({ folder: ${JSON.stringify(repo)}, name: 'Git smoke' });
        await pause(1500);
        document.querySelector('.side-tabs [data-panel="git"]').click();
        for (let i = 0; i < 50 && !document.querySelector('#git-list .git-file'); i++) await pause(100);
        const rows = [...document.querySelectorAll('#git-list .git-file')].map((r) => r.querySelector('.icon').textContent + ' ' + r.querySelector('.name').textContent);
        const groups = [...document.querySelectorAll('#git-list .git-group')].map((g) => g.textContent);
        const branch = document.getElementById('git-branch').textContent;
        [...document.querySelectorAll('#git-list .git-file')].find((r) => r.textContent.includes('edited.txt'))?.click();
        return { ws: added.active, rows, groups, branch };
      })()`);
      for (let i = 0; i < 40 && !tabs.list().some((t) => t.url.startsWith('acc://git/')); i++) await wait(250);
      const gitTab = tabs.list().find((t) => t.url.startsWith('acc://git/'));
      const view = gitTab && tabs.tabs.get(gitTab.id);
      if (view) {
        for (let i = 0; i < 40 && view.view.webContents.isLoading(); i++) await wait(100);
        gitRun.page = await view.view.webContents.executeJavaScript(
          `({ url: location.href, title: document.title, add: [...document.querySelectorAll('pre.diff .add')].map((e) => e.textContent), del: [...document.querySelectorAll('pre.diff .del')].map((e) => e.textContent), scripts: document.scripts.length })`);
      }
      await wc.executeJavaScript(`(async () => { await window.acc.workspace.switch('default'); await window.acc.workspace.remove(${JSON.stringify('git-smoke')}); })()`).catch(() => {});
    } catch (err) {
      gitRun = { error: err instanceof Error ? err.message : String(err) };
    } finally {
      // The workspace opened a shell in the repo; it holds the folder until it's gone.
      const held = terminals.listSessions().filter((s) => s.ws === 'git-smoke');
      for (const s of held) terminals.kill(s.id);
      console.log(`[smoke] git: closed ${held.length} terminal(s) in the repo`);
      if (!process.env.ACC_USER_DATA) {
        try {
          fs.rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
        } catch (err) {
          console.warn(`[smoke] couldn't remove ${repo}: ${err instanceof Error ? err.message : err}`);
        }
      }
    }
    console.log(`[smoke] git=${JSON.stringify(gitRun)}`);
    const gp = gitRun?.page;
    check('the Git tab lists a repo\'s staged, unstaged and untracked files, and a click opens the diff as a script-free page',
      Boolean(gitRun?.branch?.includes('smoke-branch') && gitRun.rows.includes('M staged.txt') && gitRun.rows.includes('M edited.txt') && gitRun.rows.includes('? new.txt')
        && gp && /edited\.txt\?area=unstaged$/.test(gp.url) && gp.add.includes('+after <b>') && gp.del.includes('-before') && gp.scripts === 0), gitRun);
    // The Dev tab on a throwaway package: `npm run dev` starts a tiny server that prints
    // its address. Start from the row, wait for ready, fetch it, open the log page, then
    // Stop and check the port is closed. Same folder rules as the Git check.
    const pkg = process.env.ACC_USER_DATA
      ? fs.mkdtempSync(path.join(app.getPath('userData'), 'dev-'))
      : fs.mkdtempSync(path.join(os.tmpdir(), 'acc-dev-'));
    /** @type {any} */
    let devRun = null;
    try {
      fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'dev-smoke', private: true, scripts: { dev: 'node server.js', build: 'echo no' } }));
      fs.writeFileSync(path.join(pkg, 'server.js'), "require('http').createServer((q, r) => r.end('acc-dev-smoke')).listen(0, '127.0.0.1', function () { console.log('  Local: http://127.0.0.1:' + this.address().port + '/'); });\n");
      devRun = await wc.executeJavaScript(`(async () => {
        const pause = (ms) => new Promise((r) => setTimeout(r, ms));
        await window.acc.workspace.add({ folder: ${JSON.stringify(pkg)}, name: 'Dev smoke' });
        await pause(1500);
        document.querySelector('.side-tabs [data-panel="dev"]').click();
        for (let i = 0; i < 50 && !document.querySelector('#dev-list .dev-server'); i++) await pause(100);
        const scripts = [...document.querySelectorAll('#dev-list .dev-server .name')].map((n) => n.textContent);
        [...document.querySelectorAll('#dev-list .dev-server .acts button')].find((b) => b.textContent === 'Start')?.click();
        let s = null;
        for (let i = 0; i < 150 && s?.state !== 'ready'; i++) { await pause(200); s = (await window.acc.dev.info()).servers[0]; }
        await pause(300);
        const row = document.querySelector('#dev-list .dev-server');
        [...row.querySelectorAll('.acts button')].find((b) => b.textContent === 'Log')?.click();
        return { scripts, server: s, sub: row.querySelector('.sub').textContent, buttons: [...row.querySelectorAll('.acts button')].map((b) => b.textContent) };
      })()`);
      if (devRun.server?.url) devRun.body = await fetch(devRun.server.url).then((r) => r.text(), (e) => `fetch failed: ${e.message}`);
      for (let i = 0; i < 40 && !tabs.list().some((t) => t.url.startsWith('acc://dev/')); i++) await wait(250);
      const logTab = tabs.list().find((t) => t.url.startsWith('acc://dev/'));
      const view = logTab && tabs.tabs.get(logTab.id);
      if (view) {
        for (let i = 0; i < 40 && view.view.webContents.isLoading(); i++) await wait(100);
        devRun.page = await view.view.webContents.executeJavaScript(`({ url: location.href, text: document.querySelector('pre')?.textContent ?? '', scripts: document.scripts.length })`);
      }
      devRun.after = await wc.executeJavaScript(`(async () => {
        const pause = (ms) => new Promise((r) => setTimeout(r, ms));
        const first = (await window.acc.dev.info()).servers[0];
        await window.acc.dev.restart(first.id);
        let s = null;
        for (let i = 0; i < 150 && !(s?.state === 'ready' && s.pid !== first.pid); i++) { await pause(200); s = (await window.acc.dev.info()).servers[0]; }
        const restarted = { state: s?.state, newPid: Boolean(s?.pid && s.pid !== first.pid), sameId: s?.id === first.id };
        await window.acc.dev.stop(first.id);
        for (let i = 0; i < 100 && s?.state !== 'stopped'; i++) { await pause(100); s = (await window.acc.dev.info()).servers[0]; }
        return { ...s, restarted };
      })()`);
      if (devRun.after?.url) devRun.closed = await fetch(devRun.after.url).then(() => false, () => true);
      await wc.executeJavaScript(`(async () => { await window.acc.workspace.switch('default'); await window.acc.workspace.remove('dev-smoke'); })()`).catch(() => {});
    } catch (err) {
      devRun = { error: err instanceof Error ? err.message : String(err) };
    } finally {
      for (const s of terminals.listSessions().filter((t) => t.ws === 'dev-smoke')) terminals.kill(s.id);
      if (!process.env.ACC_USER_DATA) {
        try {
          fs.rmSync(pkg, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
        } catch (err) {
          console.warn(`[smoke] couldn't remove ${pkg}: ${err instanceof Error ? err.message : err}`);
        }
      }
    }
    console.log(`[smoke] dev=${JSON.stringify(devRun)}`);
    check('the Dev tab starts a package.json dev script, shows its address once it\'s up, opens its log, and Restart and Stop work',
      Boolean(devRun?.scripts?.join() === 'dev' && devRun.server?.state === 'ready' && /^http:\/\/127\.0\.0\.1:\d+\/$/.test(devRun.server.url)
        && devRun.sub === devRun.server.url && devRun.buttons.includes('Stop') && devRun.body === 'acc-dev-smoke'
        && devRun.page && /^acc:\/\/dev\/\d+$/.test(devRun.page.url) && devRun.page.text.includes('Local: http://127.0.0.1:') && devRun.page.scripts === 0
        && devRun.after?.restarted?.state === 'ready' && devRun.after.restarted.newPid && devRun.after.restarted.sameId
        && devRun.after.state === 'stopped' && devRun.closed === true), devRun);
    // Last, so it shows terminal_run's output in the terminal.
    await wait(1500);
    await shot('shell.png', wc);
    console.log(`[smoke] screenshots in ${dir}`);
  }
}
