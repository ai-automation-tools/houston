// The left sidebar: Files (Project Hub's tree), Bookmarks (browser profiles Hub reads,
// plus Hub's own favorites), Recent, and one search box across all three; plus MCP,
// the log of calls agents made to the app's MCP server and the run history; and Cron, Cronsole's tasks.

import { docsTasks, failedTasks, runSummary, runUrl, taskSummary } from './shared/cronsole.js';
import { diffAreas, gitUrl } from './shared/git.js';
import { devUrl } from './shared/devservers.js';
import { runLogUrl, runStateText } from './shared/runs.js';
import { PROJECT_HUB_REPO } from './shared/settings.js';
import { pushEntry } from './shared/mcplog.js';
import { HUB_FAVORITES, absPath, defaultAction, fileMenu, flatten, flattenBookmarks, isContainer, searchAll, terminalDir } from './shared/tree.js';

const ICONS = {
  projects: '🗂️', root: '📦', section: '📁', cli: '🤖', folder: '📁', repo: '📘', group: '🗃️', draft: '🧪',
  docroot: '📚', userroot: '👤', md: '📝', html: '🌐', file: '📄', image: '🖼️', pdf: '📕', config: '⚙️',
  skill: '🧩', agent: '🧠', command: '⌘', hook: '🪝', routine: '⏱️', style: '🎨',
};
const RECENT_ICONS = { url: '🌐', file: '📄', folder: '📁', terminal: '💻' };
const RUN_ICONS = { running: '◌', succeeded: '✓', failed: '✗', cancelled: '■' };

/**
 * @typedef {import('./shared/tree.js').HubNode} HubNode
 * @typedef {import('./shared/tree.js').FileAction} FileAction
 */

export class Sidebar {
  /**
   * @param {{
   *   api: any,
   *   layout: { bookmarkSource: string },
   *   openUrl: (url: string, opts?: { background?: boolean }) => void,
   *   openTerminal: (cwd: string) => void,
   *   viewDoc: (id: string, opts?: { newTab?: boolean }) => void,
   *   openCronsole: () => void,
   * }} opts
   */
  constructor({ api, layout, openUrl, openTerminal, viewDoc, openCronsole }) {
    this.api = api;
    this.openCronsole = openCronsole;
    this.cronLoaded = false;
    /** @type {import('./shared/cronsole.js').CronTask[] | null} The last list Cronsole gave, for the Docs filter. */
    this.cronTasks = null;
    this.openUrl = openUrl;
    this.openTerminal = openTerminal;
    this.viewDoc = viewDoc;
    /** @type {{ base: string, home: string, tree: HubNode[] } | null} */
    this.scan = null;
    /** The workspace's Hub folder id the Files tree starts at; '' for the whole tree. */
    this.root = '';
    /** @type {ReturnType<typeof flatten>} */
    this.fileIndex = [];
    /** @type {ReturnType<typeof flattenBookmarks>} */
    this.bookmarkIndex = [];
    /** @type {any[]} */
    this.recent = [];
    this.bookmarkSource = layout.bookmarkSource;

    this.el = {
      files: /** @type {HTMLElement} */ (document.getElementById('panel-files')),
      bookmarks: /** @type {HTMLElement} */ (document.getElementById('panel-bookmarks')),
      bookmarkTree: /** @type {HTMLElement} */ (document.getElementById('bookmark-tree')),
      source: /** @type {HTMLSelectElement} */ (document.getElementById('bookmark-source')),
      recent: /** @type {HTMLElement} */ (document.getElementById('panel-recent')),
      mcp: /** @type {HTMLElement} */ (document.getElementById('panel-mcp')),
      mcpList: /** @type {HTMLElement} */ (document.getElementById('mcp-list')),
      runsSearch: /** @type {HTMLInputElement} */ (document.getElementById('runs-search')),
      cron: /** @type {HTMLElement} */ (document.getElementById('panel-cron')),
      cronList: /** @type {HTMLElement} */ (document.getElementById('cron-list')),
      git: /** @type {HTMLElement} */ (document.getElementById('panel-git')),
      gitList: /** @type {HTMLElement} */ (document.getElementById('git-list')),
      gitBranch: /** @type {HTMLElement} */ (document.getElementById('git-branch')),
      dev: /** @type {HTMLElement} */ (document.getElementById('panel-dev')),
      devList: /** @type {HTMLElement} */ (document.getElementById('dev-list')),
      devFolder: /** @type {HTMLElement} */ (document.getElementById('dev-folder')),
      results: /** @type {HTMLElement} */ (document.getElementById('panel-search')),
      search: /** @type {HTMLInputElement} */ (document.getElementById('search')),
      status: /** @type {HTMLElement} */ (document.getElementById('hub-status')),
    };
    this.current = 'files';

    for (const btn of document.querySelectorAll('.side-tabs button')) {
      btn.addEventListener('click', () => this.show(/** @type {HTMLElement} */ (btn).dataset.panel || 'files'));
    }
    let timer = 0;
    this.el.search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = window.setTimeout(() => this.runSearch(), 120);
    });
    this.el.search.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { this.el.search.value = ''; this.runSearch(); }
      if (e.key === 'Enter') /** @type {HTMLElement | null} */ (this.el.results.querySelector('.row'))?.click();
    });
    this.el.source.addEventListener('change', () => {
      this.bookmarkSource = this.el.source.value;
      this.api.saveLayout({ bookmarkSource: this.bookmarkSource });
      this.loadBookmarks();
    });
    document.getElementById('cron-open')?.addEventListener('click', () => this.openCronsole());
    document.getElementById('cron-refresh')?.addEventListener('click', () => this.loadCron());
    document.getElementById('cron-docs')?.addEventListener('click', (e) => {
      const btn = /** @type {HTMLElement} */ (e.currentTarget);
      btn.setAttribute('aria-pressed', String(btn.getAttribute('aria-pressed') !== 'true'));
      if (this.cronTasks) this.renderCron(this.cronTasks);
    });
    document.getElementById('git-refresh')?.addEventListener('click', () => this.loadGit());
    document.getElementById('dev-refresh')?.addEventListener('click', () => this.loadDev());
    api.dev.onChanged(() => { if (this.current === 'dev') this.loadDev(); });
    api.recent.onChanged((/** @type {any[]} */ list) => { this.recent = list; this.renderRecent(); });
    /** @type {import('./shared/mcplog.js').LogEntry[]} */
    this.calls = [];
    api.mcp.onLogged((/** @type {import('./shared/mcplog.js').LogEntry} */ entry) => {
      pushEntry(this.calls, entry);
      this.renderCalls();
    });
    /** @type {import('./shared/activity.js').WorkRow[]} */
    this.work = [];
    api.activity.onChanged((/** @type {import('./shared/activity.js').WorkRow[]} */ rows) => {
      this.work = rows;
      this.renderCalls();
    });
    /** @type {import('./shared/runs.js').RunRow[]} */
    this.runs = [];
    api.runs.onChanged(() => this.loadRuns());
    /** @type {number | undefined} */
    let typing;
    this.el.runsSearch.addEventListener('input', () => {
      window.clearTimeout(typing);
      typing = window.setTimeout(() => this.loadRuns(), 150);
    });
  }

  /** The run history, searched by what's in the box; main does the search over the output. */
  async loadRuns() {
    this.runs = await this.api.runs.list(this.el.runsSearch.value);
    this.renderCalls();
  }

  async load() {
    this.checkHub();
    this.checkCron();
    window.setInterval(() => { this.checkHub(); this.checkCron(); }, 60_000);
    this.recent = await this.api.recent.list();
    this.renderRecent();
    this.calls = await this.api.mcp.log();
    this.work = await this.api.activity.list();
    await this.loadRuns();
    await Promise.all([this.loadFiles(), this.loadBookmarks()]);
    // Hub rescans on its own; reload the tree when it says so, no Retry needed.
    this.api.hub.onChanged(() => this.loadFiles());
  }

  async checkHub() {
    const h = await this.api.hub.health();
    this.el.status.className = `dot ${h.ok ? 'ok' : 'bad'}`;
    this.el.status.title = `Project Hub: ${h.ok ? 'ready' : h.state}. Click for Connections.`;
  }

  /**
   * The Cron tab's count of failing tasks, on the Hub dot's timer. Only when Cronsole is
   * set up, since the first ask starts its MCP server; a failed ask clears the count.
   */
  async checkCron() {
    try {
      if (!(await this.api.cronsole.info()).configured) return;
      this.showCronFailures(failedTasks(await this.api.cronsole.tasks()));
    } catch {
      this.showCronFailures([]);
    }
  }

  /** The MCP tab's count of agent work waiting for a click or still running. */
  showWorkCount() {
    const btn = /** @type {HTMLElement | null} */ (document.querySelector('.side-tabs [data-panel="mcp"]'));
    if (!btn) return;
    const open = this.work.filter((w) => w.open);
    btn.textContent = 'MCP';
    btn.title = "Calls agents made to the app's MCP server, and the commands and tasks they asked to run";
    if (!open.length) return;
    const badge = document.createElement('span');
    badge.className = 'tab-badge work';
    badge.textContent = String(open.length);
    btn.append(badge);
    btn.title = open.slice(0, 10).map((w) => `${w.label}: ${w.text}`).join('\n');
  }

  /** @param {import('./shared/cronsole.js').CronTask[]} failed */
  showCronFailures(failed) {
    const btn = /** @type {HTMLElement | null} */ (document.querySelector('.side-tabs [data-panel="cron"]'));
    if (!btn) return;
    btn.textContent = 'Cron';
    btn.title = "Cronsole's scheduled tasks";
    if (!failed.length) return;
    const badge = document.createElement('span');
    badge.className = 'tab-badge';
    badge.textContent = String(failed.length);
    btn.append(badge);
    const names = failed.slice(0, 10).map((t) => t.name).join('\n');
    btn.title = `${failed.length} Cronsole task${failed.length === 1 ? '' : 's'} failed the last run:\n${names}${failed.length > 10 ? '\n…' : ''}`;
  }

  /** The Files tree from the last scan, from the workspace's folder down when it has one. */
  renderFiles() {
    if (!this.scan) return;
    const all = flatten(this.scan.tree);
    const top = this.root ? all.find((e) => e.node.id === this.root)?.node : undefined;
    const nodes = top ? top.children || [] : this.scan.tree;
    // Search covers what the tree shows.
    this.fileIndex = top ? flatten(nodes) : all;
    this.el.files.innerHTML = '';
    const list = document.createElement('div');
    for (const node of nodes) list.append(this.fileRow(node, 0));
    this.el.files.append(list);
  }

  /** @param {boolean} [fresh] */
  async loadFiles(fresh = false) {
    // A warm rescan (a change event) re-renders in place; only an empty panel gets the
    // "loading" note, so the cold-scan warning doesn't flash over an existing tree.
    if (!this.el.files.querySelector('.row')) {
      this.el.files.innerHTML = '<div class="panel-note">Loading the Project Hub tree… a cold scan takes about 12 seconds.</div>';
    }
    try {
      this.scan = await this.api.hub.scan(fresh);
      this.renderFiles();
    } catch (err) {
      this.el.files.innerHTML = '';
      this.el.files.append(note(`${errText(err)}\n\nStart Project Hub (${PROJECT_HUB_REPO}), or point settings.json or ACC_HUB_URL at it, then press Retry.`, true));
      const retry = document.createElement('button');
      retry.textContent = 'Retry';
      retry.className = 'panel-note';
      retry.addEventListener('click', () => this.loadFiles(true));
      this.el.files.append(retry);
    }
  }

  /**
   * One tree row, lazily expanding its children on first open.
   * @param {HubNode} node
   * @param {number} depth
   */
  fileRow(node, depth) {
    const wrap = document.createElement('div');
    const row = document.createElement('div');
    row.className = 'row';
    row.tabIndex = 0;
    row.style.paddingLeft = `${8 + depth * 14}px`;
    row.title = node.desc ? `${node.name}\n${node.desc}` : node.name;
    const container = isContainer(node) && (node.children?.length ?? 0) > 0;
    row.innerHTML = `<span class="caret">${container ? '▸' : ''}</span><span class="icon"></span><span class="name"></span><span class="acts"></span>`;
    q(row, '.icon').textContent = ICONS[/** @type {keyof typeof ICONS} */ (node.kind)] || (isContainer(node) ? '📁' : '📄');
    q(row, '.name').textContent = node.name;
    this.addFileActions(q(row, '.acts'), node);
    wrap.append(row);

    /** @type {HTMLElement | null} */
    let kids = null;
    const toggle = () => {
      if (!container) return;
      if (!kids) {
        kids = document.createElement('div');
        for (const c of node.children || []) kids.append(this.fileRow(c, depth + 1));
        wrap.append(kids);
      } else {
        kids.hidden = !kids.hidden;
      }
      q(row, '.caret').textContent = kids.hidden ? '▸' : '▾';
    };
    row.addEventListener('click', (e) => {
      if (/** @type {HTMLElement} */ (e.target).closest('.acts')) return;
      const action = defaultAction(node);
      if (action === 'expand') toggle();
      else this.fileAction(node, action, e.ctrlKey);
    });
    row.addEventListener('contextmenu', async (e) => {
      e.preventDefault();
      const items = fileMenu(node);
      if (!items.length) return;
      const picked = await this.api.menu(items);
      if (picked) this.fileAction(node, /** @type {FileAction} */ (picked));
    });
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') row.click();
      if (e.key === 'ArrowRight' && container && (!kids || kids.hidden)) toggle();
      if (e.key === 'ArrowLeft' && kids && !kids.hidden) toggle();
      if (e.key === 'ArrowDown') /** @type {HTMLElement | null} */ (nextRow(row, 1))?.focus();
      if (e.key === 'ArrowUp') /** @type {HTMLElement | null} */ (nextRow(row, -1))?.focus();
    });
    return wrap;
  }

  /** @param {HTMLElement} host @param {HubNode} node */
  addFileActions(host, node) {
    if (!this.scan || node.id.startsWith('@')) return;
    host.append(
      button('>_', 'Terminal here', () => this.fileAction(node, 'terminal')),
      button('👁', 'View here', () => this.fileAction(node, 'view')),
      button('code', 'Open in VS Code', () => this.fileAction(node, 'code')),
      button('📂', 'Reveal in Explorer', () => this.fileAction(node, 'reveal')),
    );
    if (!isContainer(node)) host.append(button('🌐', 'Open in a browser tab', () => this.fileAction(node, 'browse')));
  }

  /**
   * Everything a click, a hover button or the right-click menu can do to a Files row.
   * @param {HubNode} node
   * @param {FileAction} action
   * @param {boolean} [newTab] Ctrl+click: view in a new tab instead of the document tab
   */
  fileAction(node, action, newTab = false) {
    if (!this.scan) return;
    const path = absPath(node.id, this.scan);
    if (action === 'view') this.viewDoc(node.id, { newTab });
    if (action === 'browse' && path) this.openUrl(`file:///${path}`);
    if (action === 'code' || action === 'reveal') this.openInHub(node, action);
    if (action === 'terminal') {
      const dir = terminalDir(node, this.scan);
      if (dir) this.openTerminal(dir);
    }
    if (action === 'workspace' && path) this.addWorkspace(node, path);
    if (action === 'copy-path' && path) copy(path.replaceAll('/', '\\'));
    if (action === 'copy-id') copy(node.id);
  }

  /** @param {HubNode} node @param {string} path */
  async addWorkspace(node, path) {
    try {
      await this.api.workspace.add({ folder: path.replaceAll('/', '\\'), name: node.name, hubId: node.id });
    } catch (err) {
      toast(errText(err));
    }
  }

  /**
   * Scope the Files tree to a workspace's Hub folder; '' shows everything.
   * @param {string} hubId
   */
  setRoot(hubId) {
    this.root = hubId;
    if (this.scan) this.renderFiles();
    // Another workspace, likely another repo.
    if (this.current === 'git') this.loadGit();
    if (this.current === 'dev') this.loadDev();
  }

  /** @param {HubNode} node @param {'code' | 'reveal'} how */
  async openInHub(node, how) {
    try {
      await this.api.hub.open(node.id, how, node.name);
    } catch (err) {
      toast(errText(err));
    }
  }

  async loadBookmarks() {
    const tree = this.el.bookmarkTree;
    tree.innerHTML = '<div class="panel-note">Loading bookmarks…</div>';
    try {
      const wantHub = this.bookmarkSource === HUB_FAVORITES;
      const data = wantHub ? await this.api.hub.favorites() : await this.api.hub.webmarks(this.bookmarkSource || undefined);
      if (!wantHub || !this.el.source.options.length) {
        const sources = wantHub ? (await this.api.hub.webmarks()).sources : data.sources;
        this.fillSources(sources, wantHub ? HUB_FAVORITES : data.source);
      }
      const roots = data.roots || [];
      this.bookmarkIndex = flattenBookmarks(roots);
      tree.innerHTML = '';
      for (const r of roots) tree.append(this.bookmarkRow(r, 0, true));
      if (!this.bookmarkIndex.length) tree.append(note('No bookmarks in this source.'));
    } catch (err) {
      tree.innerHTML = '';
      tree.append(note(errText(err), true));
    }
  }

  /** @param {{ id: string, label: string }[]} sources @param {string} selected */
  fillSources(sources, selected) {
    const sel = this.el.source;
    sel.innerHTML = '';
    for (const s of sources) sel.append(new Option(s.label, s.id, false, s.id === selected));
    sel.append(new Option('Project Hub favorites', HUB_FAVORITES, false, selected === HUB_FAVORITES));
  }

  /**
   * @param {{ name: string, url?: string, children?: any[] }} n
   * @param {number} depth
   * @param {boolean} open
   */
  bookmarkRow(n, depth, open) {
    const wrap = document.createElement('div');
    const row = document.createElement('div');
    row.className = 'row';
    row.tabIndex = 0;
    row.style.paddingLeft = `${8 + depth * 14}px`;
    const folder = !n.url;
    row.innerHTML = `<span class="caret">${folder ? (open ? '▾' : '▸') : ''}</span><span class="icon">${folder ? '📁' : '🔖'}</span><span class="name"></span>`;
    q(row, '.name').textContent = n.name || n.url || '';
    row.title = n.url || n.name;
    wrap.append(row);
    if (folder) {
      const kids = document.createElement('div');
      kids.hidden = !open;
      let built = false;
      const build = () => {
        if (built) return;
        built = true;
        for (const c of n.children || []) kids.append(this.bookmarkRow(c, depth + 1, false));
      };
      if (open) build();
      wrap.append(kids);
      row.addEventListener('click', () => {
        build();
        kids.hidden = !kids.hidden;
        q(row, '.caret').textContent = kids.hidden ? '▸' : '▾';
      });
    } else {
      row.addEventListener('click', (e) => this.openUrl(/** @type {string} */ (n.url), { background: e.ctrlKey }));
      row.addEventListener('auxclick', (e) => { if (e.button === 1) this.openUrl(/** @type {string} */ (n.url), { background: true }); });
    }
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter') row.click(); });
    return wrap;
  }

  renderRecent() {
    const host = this.el.recent;
    host.innerHTML = '';
    if (!this.recent.length) { host.append(note('Files, pages and terminals you open show up here.')); return; }
    for (const r of this.recent) host.append(this.recentRow(r));
  }

  /** @param {{ type: 'url' | 'file' | 'folder' | 'terminal', target: string, label: string, at: number }} r */
  recentRow(r) {
    const row = document.createElement('div');
    row.className = 'row';
    row.tabIndex = 0;
    row.style.paddingLeft = '10px';
    row.innerHTML = '<span class="icon"></span><span class="name"></span><span class="sub"></span>';
    q(row, '.icon').textContent = RECENT_ICONS[r.type] || '•';
    q(row, '.name').textContent = r.label;
    q(row, '.sub').textContent = ago(r.at);
    row.title = r.target;
    row.addEventListener('click', () => {
      if (r.type === 'url') this.openUrl(r.target);
      if (r.type === 'terminal' || r.type === 'folder') this.openTerminal(r.target);
      if (r.type === 'file') this.api.hub.open(r.target, 'code', r.label).catch((/** @type {unknown} */ err) => toast(errText(err)));
    });
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter') row.click(); });
    return row;
  }

  renderCalls() {
    const host = this.el.mcpList;
    host.innerHTML = '';
    this.showWorkCount();
    const query = this.el.runsSearch.value.trim();
    if (query) {
      host.append(groupTitle(`Runs matching "${query}"`));
      if (!this.runs.length) host.append(note('No run has this in its command, folder, changed files or output. The last 50 runs are kept.'));
      for (const r of this.runs) host.append(this.runRow(r));
      return;
    }
    if (this.work.length) {
      host.append(groupTitle('Agent work'));
      for (const w of this.work) {
        const row = workRow(w);
        const run = w.run;
        if (run !== null) {
          row.addEventListener('click', () => this.openUrl(runLogUrl(run)));
          row.addEventListener('keydown', (e) => { if (e.key === 'Enter') row.click(); });
        }
        host.append(row);
      }
    }
    if (this.runs.length) {
      host.append(groupTitle('Runs'));
      for (const r of this.runs) host.append(this.runRow(r));
    }
    if (this.work.length || this.runs.length) host.append(groupTitle('Calls'));
    if (!this.calls.length) {
      host.append(note("Calls agents make to the app's MCP server show up here, newest first, under the commands and tasks they asked to run. The full log is in %APPDATA%\\ai-command-center\\logs\\mcp.log."));
      return;
    }
    for (const c of this.calls) {
      const row = document.createElement('div');
      row.className = `row call${c.ok ? '' : ' failed'}${c.note ? ' info' : ''}`;
      row.tabIndex = 0;
      row.style.paddingLeft = '10px';
      row.innerHTML = '<span class="icon"></span><span class="name"></span><span class="sub"></span>';
      q(row, '.icon').textContent = c.note ? '·' : c.ok ? '✓' : '✗';
      const opened = c.client && (c.method === 'initialize' || c.method === 'server/discover');
      q(row, '.name').textContent = c.tool ? `${c.tool}${c.args && c.args !== '{}' ? ` ${c.args}` : ''}` : opened ? `${c.client} connected` : c.method;
      // Which client made a later call, by the name it gave (self-reported, not proof).
      q(row, '.sub').textContent = `${c.client && !opened ? `${c.client} · ` : ''}${c.status ? String(c.status) : `${c.ms} ms`}`;
      row.title = [new Date(c.at).toLocaleString(), c.tool ? `tools/call ${c.tool}` : c.method, c.client && `from ${c.client}`, c.args, c.note, c.error].filter(Boolean).join('\n');
      host.append(row);
    }
  }

  /**
   * One past terminal_run run: its command and how it ended, or the output line that
   * matched the search. A click opens its output, changed files included, as a page.
   * @param {import('./shared/runs.js').RunRow} r
   */
  runRow(r) {
    const row = document.createElement('div');
    row.className = `row work run ${r.state}`;
    row.tabIndex = 0;
    row.style.paddingLeft = '10px';
    row.innerHTML = '<span class="icon"></span><span class="name"></span><span class="sub"></span>';
    const files = r.changed?.length ? ` · ${r.changed.length} file${r.changed.length === 1 ? '' : 's'}` : '';
    q(row, '.icon').textContent = RUN_ICONS[r.state];
    q(row, '.name').textContent = r.command;
    q(row, '.sub').textContent = r.match ?? `${runStateText(r)}${files} · ${ago(r.startedAt)}`;
    row.title = [
      r.command,
      `Run ${r.run} in ${r.cwd}`,
      runStateText(r),
      `Started ${new Date(r.startedAt).toLocaleString()}`,
      r.changed?.length && `Changed: ${r.changed.slice(0, 20).join(', ')}${r.changed.length > 20 ? ', …' : ''}`,
      r.match && `Output: ${r.match}`,
    ].filter(Boolean).join('\n');
    row.addEventListener('click', () => this.openUrl(runLogUrl(r.run)));
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter') row.click(); });
    return row;
  }

  /**
   * The workspace repo's branch and changed files, read-only: asked for each time the
   * tab opens and on Refresh. A file opens its diff as a page (acc://git); a file with
   * both staged and unstaged changes gets a row for each.
   */
  async loadGit() {
    const host = this.el.gitList;
    host.innerHTML = '';
    this.el.gitBranch.textContent = '';
    host.append(note('Asking git…'));
    try {
      const st = await this.api.git.status();
      host.innerHTML = '';
      if (!st.repo) {
        host.append(note(st.reason));
        return;
      }
      const repoName = st.repo.split(/[\\/]/).filter(Boolean).pop();
      const track = st.upstream ? ` → ${st.upstream}${st.ahead ? ` ↑${st.ahead}` : ''}${st.behind ? ` ↓${st.behind}` : ''}` : ' (no upstream)';
      this.el.gitBranch.textContent = `${repoName} · ${st.branch || '(detached)'}${track}`;
      this.el.gitBranch.title = `${st.repo}\n${this.el.gitBranch.textContent}`;
      if (!st.files.length) host.append(note('No changes: the working tree matches the last commit.'));
      /** @type {[string, (f: any) => boolean, 'staged' | 'unstaged' | 'untracked'][]} */
      const groups = [
        ['Conflicts', (f) => f.kind === 'conflict', 'unstaged'],
        ['Staged', (f) => f.kind !== 'conflict' && Boolean(f.staged), 'staged'],
        ['Changes', (f) => f.kind !== 'conflict' && f.kind !== 'untracked' && Boolean(f.unstaged), 'unstaged'],
        ['Untracked', (f) => f.kind === 'untracked', 'untracked'],
      ];
      for (const [label, has, area] of groups) {
        const files = st.files.filter(has);
        if (!files.length) continue;
        const head = document.createElement('div');
        head.className = 'git-group';
        head.textContent = `${label} (${files.length})`;
        host.append(head);
        for (const f of files) {
          const row = document.createElement('div');
          row.className = `row git-file ${f.kind}`;
          row.tabIndex = 0;
          row.style.paddingLeft = '10px';
          row.innerHTML = '<span class="icon"></span><span class="name"></span><span class="sub"></span>';
          q(row, '.icon').textContent = area === 'staged' ? f.staged : f.unstaged;
          q(row, '.name').textContent = f.path.split('/').pop();
          q(row, '.sub').textContent = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
          row.title = f.from ? `${f.path} (renamed from ${f.from})` : f.path;
          // A conflict has no clean diff to show; git's own working-tree diff of it is still useful.
          const open = diffAreas(f).includes(area) || f.kind === 'conflict';
          if (open) {
            row.addEventListener('click', () => this.openUrl(gitUrl(f.path, area)));
            row.addEventListener('keydown', (e) => { if (e.key === 'Enter') row.click(); });
          }
          host.append(row);
        }
      }
    } catch (err) {
      host.innerHTML = '';
      host.append(note(errText(err), true));
    }
  }

  /**
   * The workspace's dev scripts, each with its server's state when it has one, then the
   * servers started in other workspaces. Asked for when the tab opens, on Refresh, and
   * whenever a server starts, comes up or ends.
   */
  async loadDev() {
    const host = this.el.devList;
    let info;
    try {
      info = await this.api.dev.info();
    } catch (err) {
      host.innerHTML = '';
      host.append(note(errText(err), true));
      return;
    }
    host.innerHTML = '';
    const folderName = (/** @type {string} */ f) => f.split(/[\\/]/).filter(Boolean).pop() || f;
    this.el.devFolder.textContent = info.folder ? `${folderName(info.folder)}${info.manager ? ` · ${info.manager}` : ''}` : '';
    this.el.devFolder.title = info.folder || '';
    if (info.reason) host.append(note(info.reason));
    /** @param {string} label */
    const group = (label) => {
      const head = document.createElement('div');
      head.className = 'git-group';
      head.textContent = label;
      host.append(head);
    };
    if (info.scripts.length) group('Scripts');
    for (const script of info.scripts) {
      host.append(this.devRow(script, info.servers.find((s) => s.folder === info.folder && s.script === script) ?? null, ''));
    }
    const others = info.servers.filter((s) => s.folder !== info.folder);
    if (others.length) group(`Other workspaces (${others.length})`);
    for (const s of others) host.append(this.devRow(s.script, s, folderName(s.folder)));
  }

  /**
   * One script's row. A click opens the server's address once it's up, else its log;
   * a script that isn't running starts on click.
   * @param {string} script
   * @param {any} s its server, or null when it hasn't started this run
   * @param {string} where the folder's name, for a server from another workspace
   */
  devRow(script, s, where) {
    const running = s && (s.state === 'starting' || s.state === 'ready' || s.state === 'stopping');
    const row = document.createElement('div');
    row.className = `row dev-server ${s ? s.state : 'idle'}`;
    row.tabIndex = 0;
    row.style.paddingLeft = '10px';
    row.innerHTML = '<span class="icon"></span><span class="name"></span><span class="sub"></span><span class="acts"></span>';
    q(row, '.icon').textContent = !s ? '▷' : s.state === 'ready' ? '●' : running ? '◌' : '■';
    q(row, '.name').textContent = where ? `${script} · ${where}` : script;
    q(row, '.sub').textContent = s ? s.text : '';
    row.title = s ? [`${s.manager} run ${script}`, s.folder, s.text, s.pid && `pid ${s.pid}`].filter(Boolean).join('\n') : `Start: run ${script}`;
    /** @param {Promise<unknown>} p */
    const act = (p) => p.catch((err) => toast(errText(err)));
    /** @type {[string, () => void][]} */
    const buttons = [];
    if (s?.url && s.state === 'ready') buttons.push(['Open', () => this.openUrl(s.url)]);
    if (s) buttons.push(['Log', () => this.openUrl(devUrl(s.id))]);
    if (!s && !where) buttons.push(['Start', () => act(this.api.dev.start(script))]);
    if (s && s.state !== 'stopping') buttons.push([running ? 'Restart' : 'Start', () => act(this.api.dev.restart(s.id))]);
    if (running && s.state !== 'stopping') buttons.push(['Stop', () => act(this.api.dev.stop(s.id))]);
    for (const [label, fn] of buttons) {
      const b = document.createElement('button');
      b.textContent = label;
      b.addEventListener('click', fn);
      q(row, '.acts').append(b);
    }
    row.addEventListener('click', (e) => {
      if (/** @type {HTMLElement} */ (e.target).closest('.acts')) return;
      if (!s) act(this.api.dev.start(script));
      else if (s.state === 'ready' && s.url) this.openUrl(s.url);
      else this.openUrl(devUrl(s.id));
    });
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === row) row.click(); });
    return row;
  }

  // Cronsole's tasks, asked for when the tab is first opened and on Refresh.
  async loadCron() {
    this.cronLoaded = true;
    const host = this.el.cronList;
    host.innerHTML = '';
    host.append(note('Asking Cronsole…'));
    try {
      const tasks = await this.api.cronsole.tasks();
      this.showCronFailures(failedTasks(tasks));
      this.cronTasks = tasks;
      this.renderCron(tasks);
    } catch (err) {
      this.cronTasks = null;
      host.innerHTML = '';
      host.append(note(errText(err), true));
    }
  }

  /**
   * The task rows, only the docs-upkeep ones while the Docs button is pressed.
   * @param {import('./shared/cronsole.js').CronTask[]} all
   */
  renderCron(all) {
    const host = this.el.cronList;
    const docsOnly = document.getElementById('cron-docs')?.getAttribute('aria-pressed') === 'true';
    const tasks = docsOnly ? docsTasks(all) : all;
    host.innerHTML = '';
    if (!all.length) host.append(note('Cronsole has no tasks.'));
    else if (!tasks.length) host.append(note('No docs upkeep tasks: none has doc, readme, changelog or diagram in its name.'));
    const now = Date.now();
    for (const t of tasks) {
      const s = taskSummary(t, now);
      const row = document.createElement('div');
      row.className = `row task${s.failed ? ' failed' : ''}`;
      row.tabIndex = 0;
      row.style.paddingLeft = '10px';
      row.innerHTML = '<span class="icon"></span><span class="name"></span><span class="sub"></span>';
      q(row, '.icon').textContent = s.icon;
      q(row, '.name').textContent = t.name;
      q(row, '.sub').textContent = s.sub;
      row.title = s.title;
      row.addEventListener('click', () => this.toggleRuns(row, t.id));
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter') row.click(); });
      host.append(row);
    }
  }

  /**
   * A task's last few runs under its row, from Cronsole's get_task_history; clicking a
   * run opens its output as a page (acc://run). A second click on the task folds them.
   * @param {HTMLElement} row
   * @param {string} taskId
   */
  async toggleRuns(row, taskId) {
    const open = row.nextElementSibling;
    if (open?.classList.contains('runs')) { open.remove(); return; }
    const box = document.createElement('div');
    box.className = 'runs';
    box.append(note('Asking Cronsole…'));
    row.after(box);
    try {
      /** @type {import('./shared/cronsole.js').CronRun[]} */
      const runs = await this.api.cronsole.history(taskId);
      box.innerHTML = '';
      if (!runs.length) box.append(note('Cronsole has recorded no runs. A task that fires on its own trigger is recorded by its platform: Open Cronsole shows those.'));
      const now = Date.now();
      for (const r of runs) {
        const s = runSummary(r, now);
        const line = document.createElement('div');
        line.className = `row run${s.failed ? ' failed' : ''}`;
        line.tabIndex = 0;
        line.style.paddingLeft = '28px';
        line.innerHTML = '<span class="icon"></span><span class="name"></span><span class="sub">Show output</span>';
        q(line, '.icon').textContent = s.icon;
        q(line, '.name').textContent = s.text;
        line.title = s.title;
        line.addEventListener('click', () => this.openUrl(runUrl(taskId, r.id)));
        line.addEventListener('keydown', (e) => { if (e.key === 'Enter') line.click(); });
        box.append(line);
      }
    } catch (err) {
      box.innerHTML = '';
      box.append(note(errText(err), true));
    }
  }

  /** @param {string} name */
  show(name) {
    this.current = name;
    for (const btn of document.querySelectorAll('.side-tabs button')) {
      btn.setAttribute('aria-selected', String(/** @type {HTMLElement} */ (btn).dataset.panel === name));
    }
    if (this.el.search.value.trim()) return;
    this.el.files.hidden = name !== 'files';
    this.el.bookmarks.hidden = name !== 'bookmarks';
    this.el.recent.hidden = name !== 'recent';
    this.el.mcp.hidden = name !== 'mcp';
    this.el.cron.hidden = name !== 'cron';
    this.el.git.hidden = name !== 'git';
    this.el.dev.hidden = name !== 'dev';
    if (name === 'cron' && !this.cronLoaded) this.loadCron();
    if (name === 'git') this.loadGit();
    if (name === 'dev') this.loadDev();
  }

  focusSearch() {
    this.el.search.focus();
    this.el.search.select();
  }

  runSearch() {
    const query = this.el.search.value.trim();
    const res = this.el.results;
    if (!query) {
      res.hidden = true;
      this.show(this.current);
      return;
    }
    this.el.files.hidden = this.el.bookmarks.hidden = this.el.recent.hidden = this.el.mcp.hidden = this.el.cron.hidden = this.el.git.hidden = true;
    res.hidden = false;
    res.innerHTML = '';

    const { files, bookmarks: marks, recent } = searchAll({ files: this.fileIndex, bookmarks: this.bookmarkIndex, recent: this.recent }, query);

    if (!files.length && !marks.length && !recent.length) { res.append(note(`Nothing matches "${query}".`)); return; }

    if (files.length) {
      res.append(groupTitle(`Files (${files.length}${files.length === 40 ? '+' : ''})`));
      for (const f of files) {
        const row = this.fileRow(f.node, 0);
        const first = /** @type {HTMLElement} */ (row.firstElementChild);
        const sub = document.createElement('span');
        sub.className = 'sub';
        sub.textContent = f.path.split(' / ').slice(-3, -1).join(' / ');
        first.insertBefore(sub, first.querySelector('.acts'));
        res.append(row);
      }
    }
    if (marks.length) {
      res.append(groupTitle(`Bookmarks (${marks.length})`));
      for (const b of marks) res.append(this.bookmarkRow({ name: b.name, url: b.url }, 0, false));
    }
    if (recent.length) {
      res.append(groupTitle(`Recent (${recent.length})`));
      for (const r of recent) res.append(this.recentRow(r));
    }
  }
}

/** @param {HTMLElement} el @param {string} sel */
function q(el, sel) { return /** @type {HTMLElement} */ (el.querySelector(sel)); }

/** @param {string} text @param {boolean} [bad] */
function note(text, bad = false) {
  const d = document.createElement('div');
  d.className = `panel-note${bad ? ' bad' : ''}`;
  d.style.whiteSpace = 'pre-line';
  d.textContent = text;
  return d;
}

/**
 * One ask an agent made (terminal_run, cron_run): what it asked, where, and how it stands.
 * @param {import('./shared/activity.js').WorkRow} w
 */
function workRow(w) {
  const row = document.createElement('div');
  row.className = `row work ${w.state}`;
  row.tabIndex = 0;
  row.style.paddingLeft = '10px';
  row.innerHTML = '<span class="icon"></span><span class="name"></span><span class="sub"></span>';
  q(row, '.icon').textContent = w.icon;
  q(row, '.name').textContent = w.text;
  q(row, '.sub').textContent = w.label;
  row.title = [
    w.text,
    w.where,
    w.label,
    `Asked ${new Date(w.askedAt).toLocaleString()}`,
    w.endedAt && `Ended ${new Date(w.endedAt).toLocaleString()}`,
    w.error,
  ].filter(Boolean).join('\n');
  return row;
}

/** @param {string} text */
function groupTitle(text) {
  const d = document.createElement('div');
  d.className = 'group-title';
  d.textContent = text;
  return d;
}

/** @param {string} label @param {string} title @param {() => void} fn */
function button(label, title, fn) {
  const b = document.createElement('button');
  b.textContent = label;
  b.title = title;
  b.setAttribute('aria-label', title);
  b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
  return b;
}

/** @param {string} text */
function copy(text) {
  navigator.clipboard.writeText(text).then(() => toast(`Copied ${text}`), () => toast("Couldn't copy to the clipboard"));
}

/** @param {HTMLElement} row @param {1 | -1} dir */
function nextRow(row, dir) {
  const rows = [...document.querySelectorAll('.panel:not([hidden]) .row')].filter((r) => /** @type {HTMLElement} */ (r).offsetParent);
  const i = rows.indexOf(row);
  return rows[i + dir];
}

/** @param {unknown} err */
function errText(err) {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

/** @param {number} at */
function ago(at) {
  const s = Math.round((Date.now() - at) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/** @param {string} text */
export function toast(text) {
  const t = document.createElement('div');
  t.textContent = text;
  Object.assign(t.style, {
    position: 'fixed', left: '12px', bottom: '12px', maxWidth: '420px', padding: '10px 12px', zIndex: '10',
    background: '#1f2937', border: '1px solid #374151', borderRadius: '8px', color: '#f4f4f5', whiteSpace: 'pre-line',
  });
  document.body.append(t);
  setTimeout(() => t.remove(), 6000);
}
