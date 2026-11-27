// `npm run smoke`: the end-to-end run scripts/smoke.js drives. Kept out of main.js so
// the main process stays thin; main.js calls it only when ACC_SMOKE_DIR is set.
// Each observation is a named check. Checks that need Project Hub or Cronsole count only
// with ACC_SMOKE_LIVE=1 (npm run smoke -- --live); without it they're reported, not
// failed. The verdict goes to <dir>/summary.json and the process exit code.

import { app, Menu } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installExtension } from 'electron-chrome-web-store';
import { callControl, dataDir } from '../../core/client.js';
import { onPath } from './env.js';
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
 * @param {(() => Promise<string>) | null} [saveDiagnostics] View › Save diagnostics bundle, without the Explorer window
 */
export function smoke(dir, wc, tabs, terminals, browseSession, saveDiagnostics = null) {
  const live = process.env.ACC_SMOKE_LIVE === '1';
  /** @type {{ name: string, result: 'pass' | 'fail' | 'skip' | 'warn', detail?: string }[]} */
  const results = [];
  /**
   * Write summary.json as it stands. After every check, with `complete: false`, so a run the
   * launcher's time limit kills still leaves each check it reached (AT-13 reads its own); at the end, `complete: true`.
   * @param {boolean} complete
   */
  const writeSummary = (complete) => {
    const count = (/** @type {string} */ r) => results.filter((x) => x.result === r).length;
    const summary = { live, complete, passed: count('pass'), failed: count('fail'), skipped: count('skip'), warnings: count('warn'), checks: results };
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
    return summary;
  };
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
    writeSummary(false);
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
    const summary = writeSummary(true);
    const { failed } = summary;
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

      // AT-13: a web page in a tab asks for the harness's control surfaces. The page is the real
      // example.com, so this runs with a web origin's rights. Nothing may come back readable.
      // The gateway comes in H3; the Control API is a named pipe whose token sits in the Core's
      // operator-only data folder, so the page tries that file, the MCP server and Houston's own pages.
      if (!process.env.ACC_SMOKE_URL) {
        const controlFile = `file:///${path.join(dataDir(), 'control.json').replaceAll('\\', '/')}`;
        const at13 = await tab.view.webContents.executeJavaScript(`(async () => {
          const read = async (u, init) => {
            try {
              const r = await fetch(u, init);
              // An opaque no-cors answer has status 0 and no body: the page learned nothing.
              return r.type === 'opaque' ? 'opaque' : 'read ' + r.status + ': ' + (await r.text()).slice(0, 60);
            } catch (e) { return 'refused: ' + e.message; }
          };
          const rpc = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
          return {
            mcp: await read(${JSON.stringify(url)}, { method: 'POST', body: rpc, headers: { 'content-type': 'application/json' } }),
            mcpNoCors: await read(${JSON.stringify(url)}, { method: 'POST', body: rpc, mode: 'no-cors' }),
            controlFile: await read(${JSON.stringify(controlFile)}),
            settings: await read('acc://settings/'),
            transcript: await read('acc://transcript/00000000-0000-0000-0000-000000000000'),
          };
        })()`);
        // Last: try to navigate the tab to an app page; it must stay on the web page.
        await tab.view.webContents.executeJavaScript(`location.href = 'acc://settings/'`).catch(() => {});
        await wait(1500);
        at13.navigated = tab.view.webContents.getURL();
        console.log(`[smoke] at13=${JSON.stringify(at13)}`);
        check('AT-13: a web page can\'t read the MCP server, the Core\'s control file or Houston\'s own pages, nor navigate to one',
          [at13.mcp, at13.mcpNoCors, at13.controlFile, at13.settings, at13.transcript].every((r) => !String(r).startsWith('read'))
            && /^https:\/\/example\.com/.test(at13.navigated), at13);
      }
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
    if (process.env.ACC_SMOKE_SEEDED) {
      const news = await wc.executeJavaScript(`(async () => {
        document.getElementById('search').value = '';
        document.getElementById('search').dispatchEvent(new Event('input'));
        document.querySelector('.side-tabs [data-panel="news"]').click();
        for (let i = 0; i < 40 && !document.querySelector('#news-list .row'); i++) await new Promise((r) => setTimeout(r, 100));
        const rows = [...document.querySelectorAll('#news-list .row')];
        rows[0]?.click();
        await new Promise((r) => setTimeout(r, 800));
        document.querySelector('.side-tabs [data-panel="files"]').click();
        return { shown: rows.map((r) => r.querySelector('.name').textContent), sources: document.getElementById('news-sources').textContent };
      })()`);
      // The tab lists its address once the page commits, which on a slow network can take seconds.
      const isOpen = () => tabs.list().some((t) => t.url === 'https://example.com/smoke-news');
      for (let i = 0; i < 50 && !isOpen(); i++) await wait(100);
      const opened = isOpen();
      check('the News tab lists a local Markdown source\'s headline, and a click opens it as a tab',
        news.shown[0] === 'Smoke headline' && news.sources === '1 source' && opened, { ...news, opened });
    }
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
    // Address-bar suggestions: example.com is in Recent by now; typing lists it, the
    // arrow highlights it, Escape closes the list without navigating.
    if (!process.env.ACC_SMOKE_URL) {
      const sug = await wc.executeJavaScript(`(async () => {
        const input = document.getElementById('address');
        const box = document.getElementById('address-suggest');
        input.focus();
        input.value = 'example';
        input.dispatchEvent(new Event('input'));
        const urls = [...box.querySelectorAll('.pal-row .sub')].map((s) => s.textContent);
        const shown = !box.hidden && input.getAttribute('aria-expanded') === 'true';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        const active = box.querySelector('.pal-row.active .sub')?.textContent;
        const described = input.getAttribute('aria-activedescendant');
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        const closed = box.hidden && input.getAttribute('aria-expanded') === 'false';
        input.blur();
        return { shown, urls, active, described, closed };
      })()`);
      console.log(`[smoke] suggest=${JSON.stringify(sug)}`);
      check('typing in the address bar suggests Recent pages; the arrow highlights one and Escape closes the list',
        sug.shown && sug.urls.some((/** @type {string} */ u) => /^https:\/\/example\.com/.test(u)) && sug.active === sug.urls[0] && sug.described === 'sug-0' && sug.closed, sug);
    }
    // Terminal search: with a terminal focused, Ctrl+F searches its buffer instead of the page.
    await wc.executeJavaScript(`document.querySelector('#term-host .term-pane:not([hidden]) textarea')?.focus()`);
    wc.send('shortcut', 'find');
    await wait(300);
    const tfind = await wc.executeJavaScript(`(async () => {
      const input = document.getElementById('find-input');
      const placeholder = input.placeholder;
      // A word the terminal shows: a shell's prompt or a run's output, whichever is active. A new shell may not have printed yet.
      const rows = () => document.querySelector('#term-host .term-pane:not([hidden]) .xterm-rows')?.textContent.trim() ?? '';
      for (let i = 0; i < 50 && !/[A-Za-z]{4,}/.test(rows()); i++) await new Promise((r) => setTimeout(r, 100));
      const shown = rows().slice(0, 80);
      input.value = shown.match(/[A-Za-z]{4,}/)?.[0] ?? 'nothing-shown';
      input.dispatchEvent(new Event('input'));
      await new Promise((r) => setTimeout(r, 300));
      const count = document.getElementById('find-count').textContent;
      const marks = document.querySelectorAll('#term-host .xterm-find-result-decoration, #term-host .xterm-find-active-result-decoration').length;
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise((r) => setTimeout(r, 100));
      return { shown, word: input.value, placeholder, count, marks, closed: document.getElementById('find-form').hidden, refocused: document.activeElement?.closest('#term-host') !== null };
    })()`);
    console.log(`[smoke] terminal find=${JSON.stringify(tfind)}`);
    check('Ctrl+F in a focused terminal searches its output, counts the matches, and Escape returns focus to it',
      tfind.placeholder === 'Find in terminal' && /^[1-9]\d*\/[1-9]\d*$/.test(tfind.count) && tfind.closed && tfind.refocused, tfind);
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
    check('the status dot opens Connections: the Core, Hub, Cronsole, each shell, chat and MCP, and Retry rechecks a row',
      conn.open && conn.closed && ['core', 'hub', 'cronsole', 'shell:pwsh', 'chat', 'mcp'].every((id) => ids.includes(id))
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
    // The Agents tab against a throwaway Core, never the operator's: an identity with a write
    // grant on a folder outside the profile (sessions are denied the profile), Start from its
    // row, type into the contained shell, then Stop from the session row. Windows only.
    if (process.platform === 'win32') {
      /** @type {any} */
      let agentRun = null;
      const root = path.join(fileURLToPath(new URL('../../.test-tmp/', import.meta.url)), `smoke-agents-${process.pid}`);
      const coreDir = path.join(root, 'core');
      const ws = path.join(root, 'ws');
      const saved = process.env.HOUSTON_CORE_DATA;
      /** @type {import('node:child_process').ChildProcess | null} */
      let coreProc = null;
      try {
        fs.mkdirSync(ws, { recursive: true });
        const node = onPath('node.exe');
        if (!node) throw new Error('node.exe is not on PATH, so no Core can start');
        // src/main/core.js reads this at every call, so the window talks to this Core.
        process.env.HOUSTON_CORE_DATA = coreDir;
        coreProc = spawn(node, [fileURLToPath(new URL('../../core/main.js', import.meta.url))], {
          env: { ...process.env, HOUSTON_SESSION_TEMP: path.join(root, 'sessions') }, stdio: 'ignore', windowsHide: true,
        });
        for (let i = 0; i < 150 && !fs.existsSync(path.join(coreDir, 'control.json')); i++) await wait(100);
        const ctl = (/** @type {string} */ m, /** @type {object} */ p) => callControl(coreDir, m, p);
        await ctl('identity.create', { id: 'local:smoke-shell', kind: 'ai-agent', displayName: 'Smoke shell' });
        await ctl('grant.add', { identity: 'local:smoke-shell', resource: `file:${ws.replaceAll('\\', '/')}/**`, permission: 'write' });
        // Two hosts the operator is asked about: one gets Deny, the other Allow for this session.
        for (const host of ['example.org:443', 'example.com:443']) await ctl('grant.add', { identity: 'local:smoke-shell', resource: `net:${host}`, permission: 'connect', effect: 'ask' });
        await ctl('identity.activate', { id: 'local:smoke-shell' });
        agentRun = await wc.executeJavaScript(`(async () => {
          const pause = (ms) => new Promise((r) => setTimeout(r, ms));
          await window.acc.workspace.add({ folder: ${JSON.stringify(ws)}, name: 'Agents smoke' });
          await pause(1500);
          document.querySelector('.side-tabs [data-panel="agents"]').click();
          for (let i = 0; i < 50 && !document.querySelector('#agents-list .dev-server'); i++) await pause(100);
          const row = document.querySelector('#agents-list .dev-server');
          const before = { name: row?.querySelector('.name').textContent, sub: row?.querySelector('.sub').textContent, buttons: [...(row?.querySelectorAll('.acts button') ?? [])].map((b) => b.textContent) };
          [...(row?.querySelectorAll('.acts button') ?? [])].find((b) => b.textContent === 'Start')?.click();
          let tab = null;
          for (let i = 0; i < 150 && !(tab = document.querySelector('.term-tab.agent.active')); i++) await pause(200);
          return { before, tab: tab?.querySelector('.title').textContent ?? null };
        })()`);
        const t = terminals.listSessions().find((s) => s.session);
        if (!t) throw new Error('no contained session tab');
        agentRun.sessionId = t.session;
        // Typed with a variable cut to nothing, so the echoed command line can't pass for the output.
        const lines = () => cleanOutput(terminals.read(t.id)?.raw ?? '').split(/\r?\n/).map((l) => l.trim());
        // The container takes a moment to start; type once cmd shows its prompt.
        for (let i = 0; i < 100 && !lines().some((l) => l.endsWith('>')); i++) await wait(100);
        agentRun.prompt = lines().some((l) => l.endsWith('>'));
        // Typed in the tab's terminal, run in the container, and seen from outside it: the file it wrote.
        const proof = path.join(ws, 'agent-smoke.txt');
        terminals.write(t.id, 'echo agent-smoke-ok> agent-smoke.txt\r');
        for (let i = 0; i < 100 && !fs.existsSync(proof); i++) await wait(100);
        await wait(200);
        agentRun.wrote = fs.existsSync(proof) ? fs.readFileSync(proof, 'utf8').trim() : null;
        // A made-up key printed in the session: its transcript must hold only the marker (checked below).
        terminals.write(t.id, 'echo sk-ant-api03-SMOKEsmokeSMOKEsmoke0123456789\r');

        // The approval inbox: a request to an `ask` host waits on a card in the bar.
        /** @param {string} button @returns {Promise<any>} what the card said, after clicking */
        const answerCard = (button) => wc.executeJavaScript(`(async () => {
          const pause = (ms) => new Promise((r) => setTimeout(r, ms));
          const bar = document.getElementById('approval-bar');
          for (let i = 0; i < 100 && bar.hidden; i++) await pause(100);
          const card = { shown: !bar.hidden, who: document.getElementById('approval-who').textContent, what: document.getElementById('approval-what').textContent,
            where: document.getElementById('approval-where').textContent, left: document.getElementById('approval-left').textContent, focus: document.activeElement?.id };
          document.getElementById(${JSON.stringify(button)}).click();
          return card;
        })()`);
        const fileText = async (/** @type {string} */ f) => {
          for (let i = 0; i < 150 && !fs.existsSync(path.join(ws, f)); i++) await wait(100);
          await wait(200);
          return fs.existsSync(path.join(ws, f)) ? fs.readFileSync(path.join(ws, f), 'utf8').trim() : null;
        };
        terminals.write(t.id, 'curl.exe -s -o NUL -w "%{http_connect}" https://example.org/ > deny.txt\r');
        agentRun.denyCard = await answerCard('approval-deny');
        agentRun.denied = await fileText('deny.txt');
        // Two identical requests: the first asks, the second goes on the session allow.
        terminals.write(t.id, 'curl.exe -s -o NUL https://example.com/ & curl.exe -s -o NUL https://example.com/ & echo done> allow.txt\r');
        agentRun.allowCard = await answerCard('approval-session');
        agentRun.allowed = await fileText('allow.txt');
        const asked = (await ctl('audit.query', { type: 'approval.requested' })).events;
        const decided = (await ctl('audit.query', { type: 'approval.decided' })).events;
        agentRun.approvals = { asked: asked.map((/** @type {any} */ e) => e.resource.id), decided: decided.map((/** @type {any} */ e) => `${e.resource.id} ${e.approval.answer} ${e.decision.result}`) };
        agentRun.barAfter = await wc.executeJavaScript(`document.getElementById('approval-bar').hidden`);
        // The folder the Core started it in, as main recorded it from session.list.
        agentRun.cwd = t.cwd;
        agentRun.after = await wc.executeJavaScript(`(async () => {
          const pause = (ms) => new Promise((r) => setTimeout(r, ms));
          const stop = () => [...document.querySelectorAll('#agents-list .dev-server .acts button')].find((x) => x.textContent === 'Stop');
          for (let i = 0; i < 50 && !stop(); i++) await pause(100);
          stop()?.click();
          let info = null;
          for (let i = 0; i < 100; i++) { info = await window.acc.agents.info(); if (!info.rows?.[0]?.sessions.length) break; await pause(100); }
          for (let i = 0; i < 50 && !document.querySelector('.term-tab.agent.exited'); i++) await pause(100);
          return { sessions: info?.rows?.[0]?.sessions.length ?? null, exited: Boolean(document.querySelector('.term-tab.agent.exited')) };
        })()`);
        const { events } = await ctl('audit.query', { type: 'session.end' });
        agentRun.ended = events.map((/** @type {any} */ e) => e.decision?.reasons?.[0] ?? e.outcome?.error_code);

        // Stop All: two running sessions, the navbar button, and nothing running within 5 s.
        agentRun.stopAll = await wc.executeJavaScript(`(async () => {
          const pause = (ms) => new Promise((r) => setTimeout(r, ms));
          await window.acc.agents.start('local:smoke-shell');
          await window.acc.agents.start('local:smoke-shell');
          const running = (await window.acc.agents.info()).rows?.[0]?.sessions.length ?? null;
          const t0 = Date.now();
          document.getElementById('stop-all').click();
          let left = null;
          for (let i = 0; i < 100; i++) { left = (await window.acc.agents.info()).rows?.[0]?.sessions.length; if (left === 0) break; await pause(50); }
          const ms = Date.now() - t0;
          let toast = null;
          for (let i = 0; i < 50 && !toast; i++) { toast = [...document.body.children].find((d) => d.textContent.startsWith('Stop All:'))?.textContent ?? null; if (!toast) await pause(100); }
          return { running, left, ms, toast };
        })()`);
        agentRun.stopAll.audit = (await ctl('audit.query', { type: 'stop.all' })).events.map((/** @type {any} */ e) => `${e.identity.subject} ${e.decision.reasons[0]}`);
        agentRun.stopAll.key = Menu.getApplicationMenu()?.getMenuItemById('stop-all')?.accelerator ?? null;

        // The Logs tab over what all of the above wrote: every event, then only denials, then one session.
        agentRun.logs = await wc.executeJavaScript(`(async () => {
          const pause = (ms) => new Promise((r) => setTimeout(r, ms));
          const names = () => [...document.querySelectorAll('#logs-list .row.log .name')].map((n) => n.textContent);
          const settle = async (before) => { for (let i = 0; i < 50 && names().join() === before; i++) await pause(100); await pause(200); return names(); };
          document.querySelector('.side-tabs [data-panel="logs"]').click();
          const all = await settle('');
          const sel = (f) => document.getElementById('logs-' + f);
          const identities = [...sel('identity').options].map((o) => o.value);
          const sessions = sel('session').options.length - 1;
          sel('result').value = 'deny';
          sel('result').dispatchEvent(new Event('change'));
          const denied = await settle(all.join());
          const deniedClasses = [...document.querySelectorAll('#logs-list .row.log')].map((r) => r.className);
          sel('result').value = '';
          sel('result').dispatchEvent(new Event('change'));
          await settle(denied.join());
          const only = [...document.querySelectorAll('#logs-list .row.log .acts button')].find((b) => b.textContent === 'Only this session');
          only?.click();
          const one = await settle(all.join());
          const first = document.querySelector('#logs-list .row.log');
          first?.click();
          const detail = document.querySelector('#logs-list .log-detail')?.textContent ?? '';
          return { all: all.length, stopAll: all.includes('stop.all sessions') && all[0] === 'session.end', identities, sessions, denied, deniedClasses, oneSession: sel('session').value !== '' && one.length > 0 && one.length < all.length, detail: detail.includes('"event_id"') };
        })()`);
        // The first session's transcript, from its session.start row's Transcript button.
        await wc.executeJavaScript(`(async () => {
          const pause = (ms) => new Promise((r) => setTimeout(r, ms));
          const sel = document.getElementById('logs-session');
          sel.value = ${JSON.stringify(t.session)};
          sel.dispatchEvent(new Event('change'));
          const find = () => [...document.querySelectorAll('#logs-list .row.log')].find((r) => r.title.includes(${JSON.stringify(`session ${t.session}`)}) && r.querySelector('.name').textContent === 'session.start');
          for (let i = 0; i < 50 && !find(); i++) await pause(100);
          const row = find();
          [...(row?.querySelectorAll('.acts button') ?? [])].find((b) => b.textContent === 'Transcript')?.click();
        })()`);
        for (let i = 0; i < 40 && !tabs.list().some((x) => x.url.startsWith('acc://transcript/')); i++) await wait(250);
        const tTab = tabs.list().find((x) => x.url.startsWith('acc://transcript/'));
        const tView = tTab && tabs.tabs.get(tTab.id);
        if (tView) {
          for (let i = 0; i < 40 && tView.view.webContents.isLoading(); i++) await wait(100);
          agentRun.transcript = await tView.view.webContents.executeJavaScript(`({ url: location.href, h1: document.querySelector('h1')?.textContent, text: document.querySelector('pre')?.textContent ?? '', scripts: document.scripts.length })`);
          tabs.close(tTab.id);
        }

        // Settings: the ⚙ button opens every control with its scope, the Core's rows from this Core.
        await wc.executeJavaScript(`document.getElementById('settings-open').click()`);
        for (let i = 0; i < 40 && !tabs.list().some((x) => x.url.startsWith('acc://settings/')); i++) await wait(250);
        const sTab = tabs.list().find((x) => x.url.startsWith('acc://settings/'));
        const sView = sTab && tabs.tabs.get(sTab.id);
        if (sView) {
          for (let i = 0; i < 40 && sView.view.webContents.isLoading(); i++) await wait(100);
          agentRun.settings = await sView.view.webContents.executeJavaScript(`({
            h2: [...document.querySelectorAll('h2')].map((h) => h.textContent),
            rows: Object.fromEntries([...document.querySelectorAll('tbody tr')].map((r) => [r.cells[0].textContent, r.cells[1].textContent])),
            scripts: document.scripts.length,
          })`);
          tabs.close(sTab.id);
        }
        agentRun.settingsKey = Menu.getApplicationMenu()?.items.flatMap((m) => m.submenu?.items ?? []).find((m) => m.label === 'Settings')?.accelerator ?? null;

        // Health: View › Health opens every check with this Core's own; the bundle is scrubbed JSON.
        Menu.getApplicationMenu()?.items.flatMap((m) => m.submenu?.items ?? []).find((m) => m.label === 'Health')?.click();
        for (let i = 0; i < 40 && !tabs.list().some((x) => x.url.startsWith('acc://health/')); i++) await wait(250);
        const hTab = tabs.list().find((x) => x.url.startsWith('acc://health/'));
        const hView = hTab && tabs.tabs.get(hTab.id);
        if (hView) {
          for (let i = 0; i < 40 && hView.view.webContents.isLoading(); i++) await wait(100);
          agentRun.health = await hView.view.webContents.executeJavaScript(`({
            rows: Object.fromEntries([...document.querySelectorAll('tbody tr')].filter((r) => r.cells.length === 4).map((r) => [r.cells[1].textContent, r.cells[0].textContent])),
            scripts: document.scripts.length,
          })`);
          tabs.close(hTab.id);
        }
        try {
          const file = await saveDiagnostics?.();
          const text = file ? fs.readFileSync(file, 'utf8') : '';
          const b = JSON.parse(text);
          agentRun.bundle = { checks: b.checks?.length, coreLog: Array.isArray(b.core?.log), home: text.toLowerCase().includes(os.homedir().toLowerCase().replaceAll('\\', '\\\\')) };
        } catch (err) {
          agentRun.bundle = { error: err instanceof Error ? err.message : String(err) };
        }

        // The Integrations tab over this Core: a server registered with ctl (after Settings, which counts identities), then Install and Pin pressed in the tab.
        const stub = fileURLToPath(new URL('../../tests/core/stub-mcp-server.js', import.meta.url));
        await ctl('mcp.add', { name: 'smoke-stub', transport: 'host', command: `"${node}" "${stub}"` });
        await ctl('memory.add', { text: 'Smoke: the workspace is a scratch folder.' });
        await ctl('standing.create', { id: 'smoke-nightly', identity: 'local:smoke-shell', workspace: ws, command: 'cmd.exe /d /c exit 0', maxMinutes: 5, expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
        agentRun.integrations = await wc.executeJavaScript(`(async () => {
          const pause = (ms) => new Promise((r) => setTimeout(r, ms));
          const until = async (ok) => { for (let i = 0; i < 300 && !ok(); i++) await pause(100); return ok(); };
          const row = () => [...document.querySelectorAll('#integrations-list .row')].find((r) => r.querySelector('.name')?.textContent === 'smoke-stub');
          const buttons = () => [...(row()?.querySelectorAll('.acts button') ?? [])];
          const press = (start) => buttons().find((b) => b.textContent.startsWith(start))?.click();
          document.querySelector('.side-tabs [data-panel="integrations"]').click();
          await until(row);
          const before = { buttons: buttons().map((b) => b.textContent), runs: row()?.nextElementSibling?.querySelector('.sub')?.textContent ?? '' };
          press('Install');
          await until(() => buttons().some((b) => b.textContent.startsWith('Pin')));
          const names = [...document.querySelectorAll('#integrations-list .row .name')].map((n) => n.textContent);
          const read = { buttons: buttons().map((b) => b.textContent), tools: names.filter((n) => ['echo', 'env', 'big'].includes(n)).sort() };
          press('Pin');
          await until(() => /tools served/.test(row()?.querySelector('.sub')?.textContent ?? ''));
          const pinned = row()?.querySelector('.sub')?.textContent ?? '';
          // The standing grant: Pause, then Resume.
          const grant = () => [...document.querySelectorAll('#integrations-list .row')].find((r) => r.querySelector('.name')?.textContent === 'smoke-nightly');
          const grantButtons = () => [...(grant()?.querySelectorAll('.acts button') ?? [])].map((b) => b.textContent);
          const grantBefore = { sub: grant()?.querySelector('.sub')?.textContent ?? '', buttons: grantButtons() };
          grant()?.querySelector('.acts button')?.click();
          await until(() => grantButtons().join() === 'Resume');
          const grantPaused = grant()?.querySelector('.sub')?.textContent ?? '';
          grant()?.querySelector('.acts button')?.click();
          await until(() => grantButtons().join() === 'Pause');
          return { before, read, pinned, grantBefore, grantPaused, sections: [...document.querySelectorAll('#integrations-list .group-title')].map((g) => g.textContent) };
        })()`);
        agentRun.integrations.state = (await ctl('mcp.get', { name: 'smoke-stub' })).state;
        agentRun.integrations.grantStatus = (await ctl('standing.get', { id: 'smoke-nightly' })).status;
        agentRun.integrations.grantChanges = (await ctl('audit.query', { type: 'standing.change' })).events.map((/** @type {any} */ e) => e.action);
        await shot('integrations.png', wc);

        // The Feed (H6): its categories, Add as discovered registers the item's server with the Core; the start page
        // shows the advisory for smoke-stub (installed: registered just above) and not the one for a tool that isn't.
        if (process.env.ACC_SMOKE_SEEDED) {
          agentRun.feed = await wc.executeJavaScript(`(async () => {
            const pause = (ms) => new Promise((r) => setTimeout(r, ms));
            document.querySelector('.side-tabs [data-panel="feed"]').click();
            for (let i = 0; i < 50 && !document.querySelector('#feed-list .group-title'); i++) await pause(100);
            const groups = [...document.querySelectorAll('#feed-list .group-title')].map((g) => g.textContent);
            const row = [...document.querySelectorAll('#feed-list .row')].find((r) => r.querySelector('.name')?.textContent === 'Smoke MCP server');
            [...(row?.querySelectorAll('.acts button') ?? [])].find((b) => b.textContent === 'Add as discovered')?.click();
            await pause(1500);
            document.getElementById('feed-start').click();
            return { groups };
          })()`);
          agentRun.feed.discovered = await ctl('mcp.get', { name: 'smoke-feed-mcp' }).then((s) => s.state, (e) => e.message);
          for (let i = 0; i < 60 && !tabs.list().some((x) => x.url.startsWith('acc://start/')); i++) await wait(250);
          const stTab = tabs.list().find((x) => x.url.startsWith('acc://start/'));
          const stView = stTab && tabs.tabs.get(stTab.id);
          if (stView) {
            for (let i = 0; i < 80 && stView.view.webContents.isLoading(); i++) await wait(100);
            agentRun.feed.start = await stView.view.webContents.executeJavaScript(`({
              h2: [...document.querySelectorAll('h2')].map((h) => h.textContent),
              advisories: document.querySelector('.card')?.textContent ?? '', scripts: document.scripts.length,
            })`);
            tabs.close(stTab.id);
          }
        }

        // The Identity Center (H5): Reviewed, Suspend and Activate from the Agents tab change the Core;
        // Identities opens the page, a script-free acc:// page with a section for the identity.
        agentRun.lifecycle = await wc.executeJavaScript(`(async () => {
          const pause = (ms) => new Promise((r) => setTimeout(r, ms));
          const until = async (ok) => { for (let i = 0; i < 100 && !ok(); i++) await pause(100); return ok(); };
          document.querySelector('.side-tabs [data-panel="agents"]').click();
          const row = () => [...document.querySelectorAll('#agents-list .dev-server')].find((r) => r.querySelector('.name')?.textContent === 'Smoke shell');
          const buttons = () => [...(row()?.querySelectorAll('.acts button') ?? [])];
          const press = (label) => buttons().find((b) => b.textContent === label)?.click();
          await until(() => buttons().some((b) => b.textContent === 'Reviewed'));
          const before = buttons().map((b) => b.textContent);
          press('Reviewed');
          await pause(800);
          press('Suspend');
          await until(() => buttons().some((b) => b.textContent === 'Activate'));
          const suspended = { sub: row()?.querySelector('.sub')?.textContent ?? '', buttons: buttons().map((b) => b.textContent) };
          press('Activate');
          await until(() => buttons().some((b) => b.textContent === 'Suspend'));
          document.getElementById('agents-identities').click();
          return { before, suspended };
        })()`);
        for (let i = 0; i < 40 && !tabs.list().some((x) => x.url.startsWith('acc://identities/')); i++) await wait(250);
        const iTab = tabs.list().find((x) => x.url.startsWith('acc://identities/'));
        const iView = iTab && tabs.tabs.get(iTab.id);
        if (iView) {
          for (let i = 0; i < 40 && iView.view.webContents.isLoading(); i++) await wait(100);
          agentRun.lifecycle.page = await iView.view.webContents.executeJavaScript(`({
            h1: document.querySelector('h1')?.textContent, h2: [...document.querySelectorAll('h2')].map((h) => h.textContent),
            h3: [...document.querySelectorAll('h3')].map((h) => h.textContent), text: document.body.innerText, scripts: document.scripts.length,
          })`);
          tabs.close(iTab.id);
        }
        const me = await ctl('identity.get', { id: 'local:smoke-shell' });
        agentRun.lifecycle.core = { status: me.status, reviewBy: me.reviewBy, actions: (await ctl('audit.query', { type: 'identity.lifecycle' })).events.map((/** @type {any} */ e) => e.action) };

        // Profiles (H5): another profile's identity is not listed here, and Start refuses it whatever the renderer sends.
        await ctl('profile.create', { id: 'smoke-lab', displayName: 'Smoke lab' });
        await ctl('identity.create', { id: 'local:smoke-lab-agent', kind: 'ai-agent', displayName: 'Lab agent', profile: 'smoke-lab' });
        agentRun.profiles = await wc.executeJavaScript(`(async () => {
          const p = await window.acc.profile.info();
          const a = await window.acc.agents.info();
          const start = await window.acc.agents.start('local:smoke-lab-agent').then(() => 'started', (e) => String(e.message || e));
          return { active: p.active, list: p.list.map((x) => x.id), agents: a.rows.map((r) => r.name), start, button: document.getElementById('workspace').textContent };
        })()`);
        await wc.executeJavaScript(`(async () => { await window.acc.workspace.switch('default'); await window.acc.workspace.remove('agents-smoke'); })()`).catch(() => {});
      } catch (err) {
        agentRun = { ...agentRun, error: err instanceof Error ? err.message : String(err) };
      } finally {
        // The contained session's tab, and the plain terminal the workspace switch opened in its folder.
        for (const s of terminals.listSessions().filter((x) => x.session || x.ws === 'agents-smoke')) terminals.kill(s.id);
        await wc.executeJavaScript(`document.querySelectorAll('.term-tab.agent .close').forEach((b) => b.click())`).catch(() => {});
        coreProc?.kill();
        await wait(500);
        if (saved === undefined) delete process.env.HOUSTON_CORE_DATA; else process.env.HOUSTON_CORE_DATA = saved;
        try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch (err) { console.warn(`[smoke] couldn't remove ${root}: ${err instanceof Error ? err.message : err}`); }
      }
      console.log(`[smoke] agents=${JSON.stringify(agentRun)}`);
      check('the Agents tab starts a contained shell for an identity in the workspace folder, types into it, and Stop ends it',
        Boolean(agentRun?.before?.name === 'Smoke shell' && agentRun.before.buttons.includes('Start') && /Smoke shell/.test(agentRun.tab ?? '')
          && agentRun.prompt && agentRun.wrote === 'agent-smoke-ok' && agentRun.cwd?.toLowerCase() === ws.toLowerCase()
          && agentRun.after?.sessions === 0 && agentRun.after.exited && agentRun.ended?.includes('stopped')), agentRun);
      check('the approval bar shows the exact request, identity and workspace; Deny refuses it, Allow for this session lets the same request through again without asking',
        Boolean(agentRun?.denyCard?.shown && agentRun.denyCard.who === 'local:smoke-shell' && agentRun.denyCard.what === 'connect to example.org:443'
          && agentRun.denyCard.where?.toLowerCase().includes(ws.toLowerCase()) && /^denies in \d+ s$/.test(agentRun.denyCard.left) && agentRun.denyCard.focus === 'approval-deny'
          && agentRun.denied === '403' && agentRun.allowCard?.what === 'connect to example.com:443' && agentRun.allowed === 'done'
          && agentRun.approvals?.asked.join() === 'example.org:443,example.com:443'
          && agentRun.approvals.decided.join() === 'example.org:443 deny deny,example.com:443 session allow' && agentRun.barAfter === true), agentRun);
      check('Stop All on the navbar ends every running session within 5 s, says how many, and is audited; the menu gives it Ctrl+Shift+Backspace',
        Boolean(agentRun?.stopAll?.running === 2 && agentRun.stopAll.left === 0 && agentRun.stopAll.ms < 5000
          && agentRun.stopAll.toast === 'Stop All: stopped 2 agent sessions' && agentRun.stopAll.audit?.join() === 'local:operator 2 running'
          && agentRun.stopAll.key === 'CmdOrCtrl+Shift+Backspace'), agentRun?.stopAll);
      const lg = agentRun?.logs;
      check('the Logs tab lists the audit log newest first, filters by decision and by session, and shows an event whole on a click',
        Boolean(lg?.all > 5 && lg.stopAll && lg.identities.includes('local:smoke-shell') && lg.sessions === 3
          && lg.denied.includes('egress.connect example.org:443') && lg.deniedClasses.every((/** @type {string} */ c) => c.endsWith(' deny'))
          && lg.oneSession && lg.detail), lg);
      const st = agentRun?.settings;
      check('⚙ opens Settings: every control under its scope (global, profile, workspace, session) with its value now, the Core\'s from the Core; Ctrl+, on the menu',
        Boolean(st && st.scripts === 0 && st.h2.join() === 'Global,Profile: Default,Workspace: Agents smoke,Session'
          && st.rows['Log limits'] === '100 MB a transcript, 5 GB for transcripts and the audit log together; oldest transcripts deleted first, then the oldest audit segments' && st.rows['Running agent sessions'] === '0 sessions'
          && st.rows['Agent identities and grants']?.startsWith('2 identities, 3 grants (2 ask)') && st.rows.Folder?.toLowerCase() === ws.toLowerCase()
          && agentRun.settingsKey === 'CmdOrCtrl+,'), { ...st, key: agentRun?.settingsKey });
      const hl = agentRun?.health;
      check('View › Health shows every check with the Core\'s audit chain and storage; the diagnostics bundle holds them with the user folder scrubbed',
        Boolean(hl && hl.scripts === 0 && hl.rows['Houston Core'] === '✓' && hl.rows['Audit chain'] === '✓' && hl.rows['Core storage'] === '✓' && hl.rows['MCP server'] === '✓'
          && agentRun.bundle?.checks > 5 && agentRun.bundle.coreLog && agentRun.bundle.home === false), { ...hl, bundle: agentRun?.bundle });
      const ig = agentRun?.integrations;
      check('the Integrations tab shows a registered server\'s command before it runs, installs it, lists the tools a pin would serve, and pins them',
        Boolean(ig?.before?.buttons.join() === 'Install' && ig.before.runs.includes('stub-mcp-server.js') && ig.read.tools.join() === 'big,echo,env'
          && ig.read.buttons[0] === 'Pin 3 tools' && ig.pinned === '3 tools served' && ig.state === 'pinned'
          // Local models depend on the machine, so that group is left out of the comparison.
          && ig.sections.filter((x) => !x.startsWith('Local models')).join() === 'MCP servers (1),Secrets (0),Standing grants (1),Memory (0 waiting, 1 approved),Agent backends'), ig);
      const fd = agentRun?.feed;
      if (fd) {
        check("the Feed tab shows each category, Add as discovered registers the item's MCP server as discovered, and the start page shows the advisory for an installed tool only",
          Boolean(fd.groups?.join() === 'Advisories (2),MCP servers (1)' && fd.discovered === 'discovered' && fd.start?.scripts === 0
            && fd.start.h2.length === 4 && fd.start.h2[0] === 'Advisories for installed tools' && fd.start.h2[3] === 'Feed highlights'
            && fd.start.advisories.includes('smoke-stub') && !fd.start.advisories.includes('not-installed-tool')), fd);
      }
      check('the Integrations tab lists a standing grant with who it runs as, and Pause and Resume change it in the Core',
        Boolean(ig?.grantBefore?.sub === 'local:smoke-shell · up to 5 min' && ig.grantBefore.buttons.join() === 'Pause' && /^paused/.test(ig.grantPaused)
          && ig.grantStatus === 'active' && ig.grantChanges?.join() === 'standing.create,standing.pause,standing.resume'), ig);
      const lc = agentRun?.lifecycle;
      const due = lc?.core?.reviewBy ? Math.round((Date.parse(lc.core.reviewBy) - Date.now()) / 86_400_000) : null;
      check('the Agents tab marks an identity reviewed, suspends and activates it in the Core, and opens the Identity Center with its grants and reach',
        Boolean(lc?.before?.join() === 'Start,Suspend,Reviewed,Retire,Details' && lc.suspended.buttons[0] === 'Activate' && /suspended/.test(lc.suspended.sub)
          && lc.core.status === 'active' && due === 90 && lc.core.actions.slice(-3).join() === 'identity.review,identity.suspend,identity.activate'
          && lc.page?.h1 === 'Identity Center' && lc.page.scripts === 0 && lc.page.h2.includes('Smoke shell')
          && lc.page.h3.includes('What it can reach') && lc.page.text.includes('due in 90 days')), lc && { ...lc, page: lc.page && { ...lc.page, text: lc.page.text.slice(0, 400) } });
      const pr = agentRun?.profiles;
      check('the window runs as one profile: the 🧭 menu lists the Core\'s profiles, the Agents tab shows only this profile\'s identities, and Start refuses another profile\'s',
        Boolean(pr?.active === 'default' && pr.list.join() === 'default,smoke-lab' && pr.agents.includes('Smoke shell') && !pr.agents.includes('Lab agent')
          && /belongs to profile smoke-lab/.test(pr.start) && !pr.button.includes('·')), pr);
      const tr = agentRun?.transcript;
      check('a session\'s transcript opens from the Logs tab as a script-free page, with what it printed and a typed key replaced by its marker',
        Boolean(tr?.url?.endsWith(String(agentRun?.sessionId)) && tr.h1 === 'Session transcript' && tr.scripts === 0
          && /# session .* · local:smoke-shell/.test(tr.text) && tr.text.includes('agent-smoke-ok') && tr.text.includes('[REDACTED:anthropic-key]')
          && !tr.text.includes('SMOKEsmoke') && /# ended: stopped/.test(tr.text)), { ...tr, text: tr?.text?.slice(-600) });
    }
    // Last, so it shows terminal_run's output in the terminal.
    await wait(1500);
    await shot('shell.png', wc);
    console.log(`[smoke] screenshots in ${dir}`);
  }
}
