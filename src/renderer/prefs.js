// The Settings pane: the app's preferences you can change (each saved by main after
// src/shared/prefs.js checks it), Project Hub's folders and scan depth (saved by Hub, after
// src/shared/hubsettings.js checks them), and the agent and security controls, read-only,
// with where each is set. Everything is built with textContent; nothing from a file becomes HTML.

import { SCOPES, SETTINGS_URL } from './shared/scopes.js';
import { DEPTH_MAX, DEPTH_MIN } from './shared/hubsettings.js';
import { START_CARDS } from './shared/feed.js';

/** @typedef {{ label: string, url: string }} Row */

/** The message of an error from main, without Electron's "Error invoking remote method" prefix. @param {unknown} err */
const message = (err) => String(err instanceof Error ? err.message : err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/**
 * @param {string} tag
 * @param {Record<string, string>} [attrs]
 * @param {(Node | string)[]} [kids]
 */
function el(tag, attrs = {}, kids = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') e.textContent = v;
    else e.setAttribute(k, v);
  }
  e.append(...kids);
  return e;
}

/**
 * @param {{ api: any, onOpen: () => void, onClose: () => void, openUrl: (url: string) => void, onSaved?: (prefs: any) => void, resetLayout?: () => void }} deps
 */
export function createPrefs({ api, onOpen, onClose, openUrl, onSaved, resetLayout }) {
  const pane = /** @type {HTMLElement} */ (document.getElementById('prefs'));
  const main = /** @type {HTMLElement} */ (document.getElementById('prefs-main'));
  const status = /** @type {HTMLElement} */ (document.getElementById('prefs-status'));
  /** @type {any} */
  let p = null;
  let timer = 0;

  /** @param {string} text @param {boolean} [bad] */
  const say = (text, bad = false) => {
    status.textContent = text;
    status.classList.toggle('bad', bad);
    clearTimeout(timer);
    if (!bad) timer = window.setTimeout(() => { status.textContent = ''; }, 2500);
  };

  /**
   * Save one preference; on a refusal, show main's reason next to the field and keep what was typed.
   * @param {string} key @param {unknown} value @param {HTMLElement} [errorAt]
   */
  async function save(key, value, errorAt) {
    errorAt?.replaceChildren();
    try {
      p = await api.prefs.set(key, value);
      onSaved?.(p);
      say('Saved');
      return true;
    } catch (err) {
      if (errorAt) errorAt.textContent = message(err);
      say(message(err), true);
      return false;
    }
  }

  /** @param {string} id @param {string} title @param {Node[]} kids */
  const section = (id, title, kids) => el('section', { id: `prefs-${id}`, class: 'prefs-section', 'aria-labelledby': `prefs-${id}-h` }, [el('h2', { id: `prefs-${id}-h`, text: title }), ...kids]);

  /** @param {string} key @param {string} label @param {string} hint */
  function toggle(key, label, hint) {
    const box = /** @type {HTMLInputElement} */ (el('input', { type: 'checkbox', id: `pref-${key}` }));
    box.checked = Boolean(p[key]);
    box.addEventListener('change', async () => { if (!(await save(key, box.checked))) box.checked = !box.checked; });
    return el('div', { class: 'pref' }, [el('label', { class: 'pref-check', for: box.id }, [box, el('span', { text: label })]), el('p', { class: 'pref-hint', text: hint })]);
  }

  /** @param {string} key @param {string} label @param {[string, string][]} options @param {string} hint */
  function choice(key, label, options, hint) {
    const sel = /** @type {HTMLSelectElement} */ (el('select', { id: `pref-${key}` }, options.map(([v, t]) => el('option', { value: v, text: t }))));
    sel.value = p[key];
    let was = sel.value;
    sel.addEventListener('change', async () => { if (await save(key, sel.value)) was = sel.value; else sel.value = was; });
    return el('div', { class: 'pref' }, [el('label', { class: 'pref-label', for: sel.id, text: label }), sel, el('p', { class: 'pref-hint', text: hint })]);
  }

  /**
   * A group of checkboxes saved as the list of the ones ticked.
   * @param {string} key @param {string} label @param {readonly (readonly [string, string])[]} options @param {string} hint
   */
  function checks(key, label, options, hint) {
    const boxes = options.map(([id, text]) => {
      const box = /** @type {HTMLInputElement} */ (el('input', { type: 'checkbox', id: `pref-${key}-${id}`, value: id }));
      box.checked = p[key].includes(id);
      return { box, row: el('label', { class: 'pref-check', for: box.id }, [box, el('span', { text })]) };
    });
    for (const { box } of boxes) {
      box.addEventListener('change', async () => {
        if (!(await save(key, boxes.filter((b) => b.box.checked).map((b) => b.box.value)))) box.checked = !box.checked;
      });
    }
    return el('div', { class: 'pref' }, [el('span', { class: 'pref-label', text: label }), el('div', { class: 'pref-checks' }, boxes.map((b) => b.row)), el('p', { class: 'pref-hint', text: hint })]);
  }

  /**
   * A text field saved with its Save button or Enter; empty means the default.
   * @param {string} key @param {string} label @param {string} placeholder @param {string} hint @param {{ disabled?: boolean, after?: (ok: boolean) => void }} [opts]
   */
  function text(key, label, placeholder, hint, opts = {}) {
    const input = /** @type {HTMLInputElement} */ (el('input', { type: 'text', id: `pref-${key}`, placeholder, spellcheck: 'false', autocomplete: 'off' }));
    input.value = p[key] ?? '';
    input.disabled = Boolean(opts.disabled);
    const err = el('p', { class: 'pref-error', role: 'alert' });
    const btn = /** @type {HTMLButtonElement} */ (el('button', { type: 'button', text: 'Save' }));
    btn.disabled = Boolean(opts.disabled);
    const go = async () => { const ok = await save(key, input.value.trim(), err); opts.after?.(ok); };
    btn.addEventListener('click', go);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    return el('div', { class: 'pref' }, [el('label', { class: 'pref-label', for: input.id, text: label }), el('div', { class: 'pref-row' }, [input, btn]), err, el('p', { class: 'pref-hint', text: hint })]);
  }

  /**
   * An editable list of name + address rows, saved as a whole.
   * @param {string} key @param {string} label @param {string} urlHint @param {string} hint
   */
  function list(key, label, urlHint, hint) {
    const body = el('div', { class: 'pref-list' });
    const err = el('p', { class: 'pref-error', role: 'alert' });
    /** @param {Row} r */
    const addRow = (r) => {
      const name = el('input', { type: 'text', placeholder: 'Name', 'aria-label': 'Name', spellcheck: 'false' });
      const url = el('input', { type: 'text', placeholder: urlHint, 'aria-label': 'Address', spellcheck: 'false' });
      /** @type {HTMLInputElement} */ (name).value = r.label;
      /** @type {HTMLInputElement} */ (url).value = r.url;
      const del = el('button', { type: 'button', class: 'icon-btn', title: 'Remove', 'aria-label': `Remove ${r.label || 'row'}`, text: '✕' });
      const row = el('div', { class: 'pref-list-row' }, [name, url, del]);
      del.addEventListener('click', () => row.remove());
      body.append(row);
      return name;
    };
    for (const r of p[key]) addRow(r);
    const add = el('button', { type: 'button', text: '+ Add' });
    add.addEventListener('click', () => addRow({ label: '', url: '' }).focus());
    const saveBtn = el('button', { type: 'button', class: 'primary', text: 'Save' });
    saveBtn.addEventListener('click', () => {
      const rows = [...body.querySelectorAll('.pref-list-row')].map((r) => {
        const [n, u] = /** @type {HTMLInputElement[]} */ ([...r.querySelectorAll('input')]);
        return { label: n.value, url: u.value };
      }).filter((r) => r.label.trim() || r.url.trim());
      save(key, rows, err);
    });
    return el('div', { class: 'pref' }, [el('span', { class: 'pref-label', text: label }), body, el('div', { class: 'pref-row' }, [add, saveBtn]), err, el('p', { class: 'pref-hint', text: hint })]);
  }

  /**
   * A button that runs `act` and says how it went.
   * @param {string} label @param {string} hint @param {() => Promise<string>} act what to say when it worked
   */
  function action(label, hint, act) {
    const btn = /** @type {HTMLButtonElement} */ (el('button', { type: 'button', text: label }));
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try { say(await act()); } catch (err) { say(message(err), true); } finally { btn.disabled = false; }
    });
    return el('div', { class: 'pref' }, [btn, el('p', { class: 'pref-hint', text: hint })]);
  }

  /**
   * Project Hub's own settings, read from Hub each time the pane opens: the folders it shows
   * next to Projects, and how many folder levels it scans. Hub saves both in hub.config.json.
   * @param {HTMLElement} box
   */
  async function hubSettings(box) {
    box.replaceChildren(el('p', { class: 'pref-hint', text: 'Asking Project Hub…' }));
    /** @type {{ folders: { name: string, dir: string }[], defaultDepth: number, workspaces: { name: string, maxDepth: number | null, effectiveDepth: number }[] }} */
    let h;
    try {
      h = await api.prefs.hub();
    } catch (err) {
      const retry = el('button', { type: 'button', text: 'Retry' });
      retry.addEventListener('click', () => hubSettings(box));
      box.replaceChildren(el('p', { class: 'pref-error', text: message(err) }), el('div', { class: 'pref' }, [retry]));
      return;
    }
    const reload = () => hubSettings(box);

    // Folders: each with Remove, and a row to add one.
    const folders = el('div', { class: 'pref-list' }, h.folders.map((f) => {
      const del = el('button', { type: 'button', class: 'icon-btn', title: `Remove ${f.name} from Project Hub (the folder stays on disk)`, 'aria-label': `Remove ${f.name}`, text: '✕' });
      del.addEventListener('click', async () => {
        try {
          await api.prefs.hubFolder({ op: 'remove', name: f.name });
          say(`Removed ${f.name}; Project Hub is rescanning`);
          reload();
        } catch (err) {
          say(message(err), true);
        }
      });
      return el('div', { class: 'pref-folder' }, [el('b', { text: f.name }), el('span', { class: 'pref-path', text: f.dir, title: f.dir }), del]);
    }));
    const dir = /** @type {HTMLInputElement} */ (el('input', { type: 'text', placeholder: 'D:\\Work\\Notes', 'aria-label': 'Folder path', spellcheck: 'false', autocomplete: 'off' }));
    const name = /** @type {HTMLInputElement} */ (el('input', { type: 'text', placeholder: 'Name (optional)', 'aria-label': 'Name in Project Hub', spellcheck: 'false', autocomplete: 'off', class: 'pref-short' }));
    const add = /** @type {HTMLButtonElement} */ (el('button', { type: 'button', class: 'primary', text: 'Add folder' }));
    const err = el('p', { class: 'pref-error', role: 'alert' });
    /** @param {boolean} force */
    const go = async (force) => {
      err.replaceChildren();
      add.disabled = true;
      try {
        const r = await api.prefs.hubFolder({ op: 'add', dir: dir.value, name: name.value, force });
        if (r?.ask) {
          const anyway = el('button', { type: 'button', text: 'Add anyway' });
          anyway.addEventListener('click', () => go(true));
          err.replaceChildren(el('span', { text: `${r.ask} ` }), anyway);
          return;
        }
        say('Added; Project Hub is rescanning, and the Files tree updates when it is done');
        reload();
      } catch (e) {
        err.textContent = message(e);
      } finally {
        add.disabled = false;
      }
    };
    add.addEventListener('click', () => go(false));
    for (const input of [dir, name]) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(false); });

    // Scan depth: the default, and each workspace's own or the default.
    /** @param {number} value @param {string} label */
    const depthInput = (value, label) => /** @type {HTMLInputElement} */ (el('input', { type: 'number', min: String(DEPTH_MIN), max: String(DEPTH_MAX), step: '1', value: String(value), 'aria-label': label, class: 'pref-depth' }));
    const depthErr = el('p', { class: 'pref-error', role: 'alert' });
    /** @param {{ maxDepth: number | null, workspace?: string }} change */
    const setDepth = async (change) => {
      depthErr.replaceChildren();
      try {
        await api.prefs.hubDepth(change);
        say('Saved; Project Hub is rescanning');
        reload();
      } catch (e) {
        depthErr.textContent = message(e);
      }
    };
    const def = depthInput(h.defaultDepth, 'Default scan depth');
    const defSave = el('button', { type: 'button', text: 'Save' });
    defSave.addEventListener('click', () => setDepth({ maxDepth: Number(def.value) }));
    const rows = h.workspaces.map((w) => {
      const own = /** @type {HTMLInputElement} */ (el('input', { type: 'checkbox', id: `hub-depth-${w.name}` }));
      own.checked = w.maxDepth !== null;
      const n = depthInput(w.effectiveDepth, `${w.name} scan depth`);
      const save = /** @type {HTMLButtonElement} */ (el('button', { type: 'button', text: 'Save' }));
      n.disabled = save.disabled = !own.checked;
      own.addEventListener('change', () => {
        n.disabled = save.disabled = !own.checked;
        if (!own.checked && w.maxDepth !== null) setDepth({ maxDepth: null, workspace: w.name });
      });
      save.addEventListener('click', () => setDepth({ maxDepth: Number(n.value), workspace: w.name }));
      return el('div', { class: 'pref-row' }, [el('label', { class: 'pref-check pref-ws', for: own.id }, [own, el('span', { text: w.name })]), n, save]);
    });

    box.replaceChildren(
      el('div', { class: 'pref' }, [
        el('span', { class: 'pref-label', text: 'Folders' }), folders, el('div', { class: 'pref-row' }, [dir, name, add]), err,
        el('p', { class: 'pref-hint', text: "Shown in the Files tree next to your projects. Adding or removing one changes Project Hub's hub.config.json and starts a rescan; nothing on disk is moved or deleted. A folder on this machine only: never a network path or a whole drive." }),
      ]),
      el('div', { class: 'pref' }, [
        el('span', { class: 'pref-label', text: 'Scan depth' }), el('div', { class: 'pref-row' }, [el('span', { class: 'pref-ws', text: 'Every workspace' }), def, defSave]), ...rows, depthErr,
        el('p', { class: 'pref-hint', text: `How many folder levels Project Hub indexes, ${DEPTH_MIN} to ${DEPTH_MAX} (10 unless changed). Deeper finds more files and makes scans longer. Tick a workspace to give it a depth of its own.` }),
      ]),
      el('p', { class: 'pref-hint', text: "Project Hub's other settings (its colour scheme, folder icons, browser-favorites sync and backup) belong to its own page: open Project Hub in a tab and press ↗ to see it whole in your browser." }),
    );
  }

  /** The controls the Core and other places own, by scope, read-only. */
  function readOnly() {
    /** @type {Record<string, { label: string, scope: string, value: string, where: string }[]>} */
    const by = {};
    for (const c of p.readOnly) (by[c.scope] ??= []).push(c);
    const groups = Object.entries(by).map(([scope, rows]) => el('div', { class: 'prefs-scope' }, [
      el('h3', { text: SCOPES[/** @type {keyof typeof SCOPES} */ (scope)]?.label ?? scope }),
      el('dl', {}, rows.flatMap((r) => [el('dt', { text: r.label }), el('dd', {}, [el('span', { class: 'prefs-value', text: r.value }), el('span', { class: 'pref-hint', text: r.where })])])),
    ]));
    const full = el('button', { type: 'button', class: 'linkish', text: 'Open every control as a page, with what each scope means' });
    full.addEventListener('click', () => { close(); openUrl(SETTINGS_URL); });
    return [el('p', { class: 'pref-hint', text: "These are set by the Houston Core, the command line (npm run ctl) or .env, never by a switch here: a checkbox can't enforce anything. Each says where it's changed." }), ...groups, full];
  }

  function render() {
    const hubNote = p.hubFromEnv
      ? `Set by ACC_HUB_URL in .env (${p.hubNow}), which wins over this field.`
      : `Empty uses ${p.hubDefault}. Must be on this machine unless ACC_HUB_REMOTE=1 is set. Takes effect when Houston restarts.`;
    const restart = el('button', { type: 'button', class: 'primary', text: 'Restart Houston now', hidden: '' });
    const hubBox = el('div', { class: 'pref-hub' });
    restart.addEventListener('click', () => api.prefs.restart());
    const openStart = el('button', { type: 'button', class: 'linkish', text: 'Open the start page' });
    openStart.addEventListener('click', () => { close(); openUrl('acc://start/'); });
    main.replaceChildren(
      section('start', 'Start and new tab', [
        choice('startTab', 'Houston opens with', [['restore', "The last session's tabs"], ['start', 'The start page']], "The start page means the last session's tabs aren't reopened. Another workspace's tabs still come back when you switch to it."),
        checks('startCards', 'Start page cards', START_CARDS, 'What the start page (acc://start/) shows, in this order. It also opens from the Feed tab and when a workspace has no tabs.'),
        openStart,
        list('quickLinks', 'New tab links', 'https://…', 'The buttons on a new tab, up to 12, after its Settings button. With none, it shows Project Hub and the Chrome Web Store.'),
      ]),
      section('general', 'General', [
        toggle('closeToTray', 'Close to tray', 'Closing the window hides Houston to the system tray; terminals, dev servers and the MCP server keep running.'),
        choice('theme', 'Theme', [['system', 'Follow Windows'], ['light', 'Light'], ['dark', 'Dark']], 'The window, its own pages and the theme web pages are told to use.'),
        choice('tabLabels', 'Sidebar tabs', [['icons', 'Icons'], ['names', 'Names'], ['both', 'Icons and names']], "How the tab buttons across the top of the sidebar show. Tabs that don't fit go behind »."),
      ]),
      section('browser', 'Browser', [
        toggle('adBlock', 'Block ads and trackers', "Ghostery's filter lists on every tab; applies at once."),
      ]),
      section('files', 'Files', [
        toggle('dotsFirst', 'Dot-folders first', 'On: .claude, .github and dot-files sort to the top of their folder, as in Windows Explorer. Off: they come after the other folders and files.'),
        action('Clear Recent', 'Empties the Recent tab. Your files, bookmarks and history are left alone.', async () => { await api.recent.clear(); return 'Recent cleared'; }),
        ...(resetLayout ? [action('Reset panel sizes', 'The sidebar, chat pane and terminal panel go back to their first sizes.', async () => { resetLayout(); return 'Panel sizes reset'; })] : []),
      ]),
      section('startup', 'Startup', [
        toggle('startTerminal', 'Open the terminal panel', 'Off: Houston starts with the terminal panel closed and no shell running until you open it.'),
        choice('defaultShell', 'Default shell', p.shells.map((/** @type {{ id: string, label: string }} */ s) => [s.id, s.label]), 'What a new terminal (+) runs. Only shells found on this machine are listed.'),
      ]),
      section('sources', 'Sources', [
        text('hubUrl', 'Project Hub address', p.hubDefault, hubNote, { disabled: p.hubFromEnv, after: (ok) => { if (ok) restart.hidden = false; } }),
        restart,
        list('newsSources', 'News sources', 'https://…/feed.xml or D:\\notes\\digest.md', 'RSS, Atom or Markdown over http(s), or an absolute path to a local .md file; up to 12.'),
        text('feedIndex', 'Feed index file', 'D:\\feeds\\index.json', 'The index.json a scheduled job writes, for the Feed tab and the start page. Empty turns the Feed off.'),
      ]),
      section('hub', 'Project Hub', [hubBox]),
      section('security', 'Agents and security', readOnly()),
    );
    hubSettings(hubBox);
  }

  /** @param {KeyboardEvent} e */
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };

  /** @param {string} [section] a section's id, such as 'sources', to scroll to */
  async function open(section) {
    try {
      p = await api.prefs.get();
    } catch (err) {
      say(message(err), true);
      return;
    }
    render();
    if (pane.hidden) {
      pane.hidden = false;
      onOpen();
      document.addEventListener('keydown', onKey);
    }
    const at = section && document.getElementById(`prefs-${section}`);
    if (at) at.scrollIntoView({ block: 'start' });
    /** @type {HTMLElement | null} */ ((at || pane).querySelector('input, select, button'))?.focus();
  }

  /** A browser tab took over: the pane hides, and its tab stays in the strip to come back to. */
  function hide() {
    if (pane.hidden) return;
    pane.hidden = true;
    document.removeEventListener('keydown', onKey);
  }

  /** Esc, ✕ or the tab's ×: the pane and its tab go. */
  function close() {
    hide();
    onClose();
  }

  document.getElementById('prefs-close')?.addEventListener('click', close);
  for (const a of pane.querySelectorAll('.prefs-nav a')) {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      document.getElementById(/** @type {string} */ (a.getAttribute('href')).slice(1))?.scrollIntoView({ block: 'start' });
    });
  }
  return { open, close, hide, showing: () => !pane.hidden };
}
