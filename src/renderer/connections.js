// The Connections view: the Core, Hub, Cronsole, each shell, the chat model and the MCP server,
// each with its state, a Retry, and what to set when it's missing. A native <dialog>
// like the command palette; the rows come from the main process (shared/connections.js
// words them), and everything is shown as text.

/** @typedef {import('./shared/connections.js').Connection} Connection */

/** The groups in the order they're shown. Each is checked on its own, so a slow one (Cronsole starting up) doesn't hold up the rest. */
const GROUPS = /** @type {const} */ ([['core', 'Houston Core'], ['hub', 'Project Hub'], ['cronsole', 'Cronsole'], ['shells', 'Shells'], ['chat', 'Chat model'], ['mcp', 'MCP server']]);

/** @param {string} id */
const groupOf = (id) => (id.startsWith('shell:') ? 'shells' : id);

/**
 * @param {{
 *   api: any,
 *   onOpen: () => void,
 *   onClose: () => void,
 *   onChecked: (rows: Connection[]) => void,
 * }} opts onChecked: after any check, so the caller can react (Hub back up: reload Files)
 */
export function createConnections({ api, onOpen, onClose, onChecked }) {
  const dlg = /** @type {HTMLDialogElement} */ (document.getElementById('connections'));
  const list = /** @type {HTMLElement} */ (document.getElementById('connections-list'));
  const recheck = /** @type {HTMLButtonElement} */ (document.getElementById('connections-recheck'));
  /** Each group's rows; '…' rows while its check is out. @type {Map<string, (Connection | { id: string, name: string, state: 'checking', detail: string })[]>} */
  const groups = new Map();

  const render = () => {
    list.innerHTML = '';
    for (const [g] of GROUPS) {
      for (const c of groups.get(g) || []) {
        const row = document.createElement('div');
        row.className = `conn-row ${c.state}`;
        row.dataset.id = c.id;
        row.innerHTML = '<span class="dot"></span><span class="conn-name"></span><button type="button" class="conn-retry">Retry</button><span class="conn-detail"></span>';
        /** @type {HTMLElement} */ (row.querySelector('.dot')).className = `dot ${c.state}`;
        /** @type {HTMLElement} */ (row.querySelector('.conn-name')).textContent = c.name;
        /** @type {HTMLElement} */ (row.querySelector('.conn-detail')).textContent = c.detail;
        if ('fix' in c && c.fix) {
          const fix = document.createElement('span');
          fix.className = 'conn-fix';
          fix.textContent = c.fix;
          row.append(fix);
        }
        const retry = /** @type {HTMLButtonElement} */ (row.querySelector('.conn-retry'));
        retry.setAttribute('aria-label', `Check ${c.name} again`);
        retry.disabled = c.state === 'checking';
        retry.addEventListener('click', () => check(c.id));
        list.append(row);
      }
    }
  };

  /** One row again, or a whole group. @param {string} id */
  const check = async (id) => {
    const g = groupOf(id);
    const before = groups.get(g) || [];
    groups.set(g, before.map((r) => (r.id === id || id === g ? { ...r, state: 'checking', detail: 'Checking…' } : r)));
    render();
    try {
      /** @type {Connection[]} */
      const got = await api.connections.check(id);
      groups.set(g, id === g ? got : before.map((r) => got.find((x) => x.id === r.id) || r));
      onChecked(got);
    } catch (err) {
      const detail = `Couldn't check: ${err instanceof Error ? err.message : String(err)}`;
      groups.set(g, before.map((r) => (r.id === id || id === g ? { ...r, state: 'bad', detail } : r)));
    }
    render();
  };

  const checkAll = async () => {
    recheck.disabled = true;
    for (const [g, name] of GROUPS) if (!groups.has(g)) groups.set(g, [{ id: g, name, state: 'checking', detail: 'Checking…' }]);
    await Promise.all(GROUPS.map(([g]) => check(g)));
    recheck.disabled = false;
  };

  document.getElementById('connections-close')?.addEventListener('click', () => dlg.close());
  recheck.addEventListener('click', () => checkAll());
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  dlg.addEventListener('close', onClose);

  return {
    open() {
      if (dlg.open) return;
      onOpen();
      dlg.showModal();
      checkAll();
    },
  };
}
