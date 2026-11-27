// Native context menus for the shell UI. The renderer lists `{ id, label }` items and
// '-' separators; main pops up an Electron Menu and answers with the id picked.

const MAX_ITEMS = 40;
const MAX_LABEL = 200;
const PREVIEW = 40;

/**
 * Checked in main before the menu is built. `&` is doubled because a Windows menu
 * reads a single one as a mnemonic and hides it.
 * @param {unknown} value
 * @returns {({ id: string, label: string } | '-')[]}
 */
export function menuItems(value) {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) throw new Error(`menu must be a list of at most ${MAX_ITEMS} items`);
  return value.map((i) => {
    if (i === '-') return '-';
    if (!i || typeof i.id !== 'string' || typeof i.label !== 'string' || !i.label || i.label.length > MAX_LABEL) {
      throw new Error('a menu item needs a string id and a label');
    }
    return { id: i.id, label: i.label.replaceAll('&', '&&') };
  });
}

/**
 * The terminal's Paste item, showing what would go in: the first line, clipped, and how
 * many lines (each one a command the shell runs). '' when there's nothing to paste.
 * @param {string} text
 */
export function pasteLabel(text) {
  const lines = String(text || '').replace(/(\r\n|\r|\n)+$/, '').split(/\r\n|\r|\n/);
  if (!lines.join('').trim()) return '';
  // Control and invisible characters would hide what the line really is.
  const first = lines[0].replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').trim();
  const shown = first.length > PREVIEW ? `${first.slice(0, PREVIEW)}…` : first;
  return lines.length > 1 ? `Paste ${lines.length} lines: ${shown}` : `Paste: ${shown}`;
}
