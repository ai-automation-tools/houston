// Downloads and saved pages: the name a file is saved under, and the mark of the web it
// keeps. Pure; src/main/downloads.js does the saving.

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/**
 * A file name that is safe on Windows and not taken: no folder part, no characters
 * Windows refuses, no device name, and " (1)", " (2)"… before the extension when the
 * name is in use.
 * @param {string} suggested what the server or the page title suggests
 * @param {(name: string) => boolean} taken
 */
export function downloadName(suggested, taken) {
  let name = String(suggested || '').split(/[\\/]/).pop() || '';
  name = name.replace(/[<>:"|?*\p{Cc}\p{Cf}]/gu, '_').replace(/[. ]+$/, '').trim().slice(0, 200);
  if (!name || /^\.+$/.test(name)) name = 'download';
  if (RESERVED.test(name)) name = `_${name}`;
  if (!taken(name)) return name;
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let i = 1; ; i++) {
    const next = `${stem} (${i})${ext}`;
    if (!taken(next)) return next;
  }
}

/**
 * The Zone.Identifier stream Windows reads to treat a file as from the internet
 * (SmartScreen, Office's Protected View). Only an http(s) address is recorded, and
 * never its user name or password. '' for a file that came from this machine.
 * @param {string} url what was downloaded or saved
 */
export function zoneIdentifier(url) {
  if (/^file:/i.test(url)) return '';
  const web = (/** @type {string} */ u) => {
    try {
      const p = new URL(u);
      if (!/^https?:$/.test(p.protocol)) return '';
      p.username = '';
      p.password = '';
      return p.href;
    } catch { return ''; }
  };
  const host = web(url);
  return `[ZoneTransfer]\r\nZoneId=3\r\n${host ? `HostUrl=${host}\r\n` : ''}`;
}
