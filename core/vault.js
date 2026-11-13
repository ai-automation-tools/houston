// The vault (SEC-06): named secrets the gateway puts into an MCP server's environment when it
// starts the server. The only module that touches a secret's value (ADR-004). The Control API
// can set, list and delete secrets; nothing returns a value.
//
// Each value is a DPAPI blob in the Core's database, made with 32 bytes of entropy kept in
// `vault.key` beside it. Spike S5: a contained process runs as the same Windows user and can
// decrypt any plain DPAPI blob it is handed, but not one made with entropy it never sees. Both
// files sit in the Core's data folder, which every session is denied.
//
// Off Windows (Linux CI) there is no DPAPI, so the same key seals values with AES-256-GCM.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { OPERATOR } from './identities.js';
import { DEFAULT_PROFILE, profileOf } from './profiles.js';

export class VaultError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'VaultError';
    this.code = code;
  }
}

/** A secret's name: what `secret:<name>` grants and an MCP registration's env refer to. */
export const NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const MAX_VALUE = 16 * 1024;
/** Shorter values aren't redacted from text: they'd match ordinary words. */
const MIN_REDACT = 8;

/**
 * @typedef {{ seal: (plain: Buffer) => Buffer, open: (sealed: Buffer) => Buffer }} Sealer
 */

/** koffi's DPAPI functions, bound once per process (a struct name can only be declared once). @type {Promise<any> | null} */
let DPAPI = null;

/**
 * DPAPI for the current user, with the Core's entropy, through koffi.
 * @param {Buffer} entropy
 * @returns {Promise<Sealer>}
 */
async function dpapi(entropy) {
  DPAPI ??= (async () => {
    const { default: koffi } = await import('koffi');
    const crypt32 = koffi.load('crypt32.dll');
    koffi.struct('DATA_BLOB', { cbData: 'uint32', pbData: 'void *' });
    const sig = (/** @type {string} */ name) => `bool __stdcall ${name}(DATA_BLOB *in, void *descr, DATA_BLOB *entropy, void *res, void *prompt, uint32 flags, _Out_ DATA_BLOB *out)`;
    return {
      koffi, protect: crypt32.func(sig('CryptProtectData')), unprotect: crypt32.func(sig('CryptUnprotectData')),
      LocalFree: koffi.load('kernel32.dll').func('void * __stdcall LocalFree(void *p)'),
    };
  })();
  const { koffi, protect, unprotect, LocalFree } = await DPAPI;
  const UI_FORBIDDEN = 0x1;
  /** @param {Function} fn @param {Buffer} buf */
  const call = (fn, buf) => {
    /** @type {any} */
    const out = {};
    if (!fn({ cbData: buf.length, pbData: buf }, null, { cbData: entropy.length, pbData: entropy }, null, null, UI_FORBIDDEN, out)) {
      throw new VaultError('sealed', 'DPAPI refused the value (another user, another machine, or other entropy)');
    }
    try { return Buffer.from(koffi.decode(out.pbData, 'uint8', out.cbData)); } finally { LocalFree(out.pbData); }
  };
  return { seal: (b) => call(protect, b), open: (b) => call(unprotect, b) };
}

/** @param {Buffer} key @returns {Sealer} */
function aesGcm(key) {
  return {
    seal(plain) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([c.update(plain), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), body]);
    },
    open(sealed) {
      try {
        const d = crypto.createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12));
        d.setAuthTag(sealed.subarray(12, 28));
        return Buffer.concat([d.update(sealed.subarray(28)), d.final()]);
      } catch { throw new VaultError('sealed', 'the value does not open with this key'); }
    },
  };
}

/**
 * The Core's entropy: made once, kept in the data folder.
 * @param {string} dir
 */
function entropyIn(dir) {
  const file = path.join(dir, 'vault.key');
  try {
    const k = fs.readFileSync(file);
    if (k.length === 32) return k;
    throw new VaultError('sealed', `${file} is not 32 bytes; restore it from a backup or delete it with the secrets table`);
  } catch (e) {
    if (/** @type {any} */ (e).code !== 'ENOENT') throw e;
  }
  const k = crypto.randomBytes(32);
  fs.writeFileSync(file, k, { mode: 0o600, flag: 'wx' });
  return k;
}

/**
 * @param {{ db: import('node:sqlite').DatabaseSync, dir: string, audit: ReturnType<typeof import('./audit.js').openAudit>, sealer?: Sealer, now?: () => Date }} opts
 *   dir: the Core's data folder; sealer: tests only
 */
export async function openVault({ db, dir, audit, sealer, now = () => new Date() }) {
  const key = entropyIn(dir);
  const box = sealer ?? (process.platform === 'win32' ? await dpapi(key) : aesGcm(key));
  /** Opened values, for redaction; dropped on every change. @type {Map<string, string> | null} */
  let known = null;

  /** @param {string} name @param {'set' | 'delete'} change @param {string} by */
  const record = (name, change, by) => audit.append({
    type: 'secret.change', action: `secret.${change}`, identity: { subject: by }, session_id: null,
    resource: { type: 'Secret', id: name }, decision: { result: 'allow', policy_version: 'none', reasons: [change === 'set' ? 'set by the operator' : 'deleted by the operator'] },
  });

  /** @param {unknown} name @returns {string} */
  const checkName = (name) => {
    if (typeof name !== 'string' || !NAME.test(name)) throw new VaultError('bad_request', 'a secret name is lower-case letters, digits, - and _, up to 63, e.g. github-token');
    return name;
  };

  /** @param {string} name @returns {string | null} */
  const openOne = (name) => {
    const row = /** @type {any} */ (db.prepare('SELECT blob FROM secrets WHERE name = ?').get(name));
    return row ? box.open(Buffer.from(row.blob)).toString('utf8') : null;
  };

  return {
    /**
     * Store or replace a secret. Never echoes the value. A name is one secret across all profiles,
     * so replacing one in another profile is refused rather than moving it.
     * @param {unknown} name @param {unknown} value @param {string} [by] @param {unknown} [profile] default 'default'
     */
    set(name, value, by = OPERATOR, profile = undefined) {
      const n = checkName(name);
      const p = profileOf(db, profile, (c, m) => new VaultError(c, m));
      const had = /** @type {any} */ (db.prepare('SELECT profile_id FROM secrets WHERE name = ?').get(n));
      if (had && had.profile_id !== p) throw new VaultError('conflict', `${n} is a secret in profile ${had.profile_id}; names are unique across profiles`);
      if (typeof value !== 'string' || !value || value.length > MAX_VALUE || /[\0\r\n]/.test(value)) {
        throw new VaultError('bad_request', 'a secret value is one line of text, up to 16 KB');
      }
      const t = now().toISOString();
      db.prepare(`INSERT INTO secrets (name, blob, created_at, updated_at, profile_id) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET blob = excluded.blob, updated_at = excluded.updated_at`).run(n, box.seal(Buffer.from(value, 'utf8')), t, t, p);
      known = null;
      record(n, 'set', by);
      return /** @type {any} */ (db.prepare('SELECT name, profile_id AS profile, created_at, updated_at, last_used_at FROM secrets WHERE name = ?').get(n));
    },

    /** Names, profiles and dates only. @param {unknown} [profile] only that profile's */
    list(profile = undefined) {
      const p = profile === undefined ? null : profileOf(db, profile, (c, m) => new VaultError(c, m));
      return /** @type {{ name: string, profile: string, created_at: string, updated_at: string, last_used_at: string | null }[]} */ (
        db.prepare('SELECT name, profile_id AS profile, created_at, updated_at, last_used_at FROM secrets ORDER BY name').all()).filter((s) => !p || s.profile === p);
    },

    /** @param {unknown} name @param {string} [by] */
    remove(name, by = OPERATOR) {
      const n = checkName(name);
      if (!db.prepare('DELETE FROM secrets WHERE name = ?').run(n).changes) throw new VaultError('not_found', 'no secret has that name');
      known = null;
      record(n, 'delete', by);
      return { name: n, deleted: true };
    },

    /**
     * A value, for the gateway to put into an MCP server's environment. Never for the Control API.
     * Only a secret in the server's own profile: another profile's is as good as missing.
     * @param {string} name @param {string} [profile] the server's
     * @returns {string}
     * @throws {VaultError} not_found
     */
    reveal(name, profile = DEFAULT_PROFILE) {
      const mine = /** @type {any} */ (db.prepare('SELECT profile_id FROM secrets WHERE name = ?').get(checkName(name)));
      const v = mine?.profile_id === profile ? openOne(name) : null;
      if (v === null) throw new VaultError('not_found', `no secret named ${name} in profile ${profile}`);
      db.prepare('UPDATE secrets SET last_used_at = ? WHERE name = ?').run(now().toISOString(), name);
      return v;
    },

    /**
     * Replace every stored value in `text` with `[REDACTED:secret:<name>]`, longest first so
     * one value inside another goes whole. Values under 8 characters are left alone.
     * @param {string} text
     */
    redact(text) {
      if (!known) {
        known = new Map();
        for (const { name } of /** @type {any[]} */ (db.prepare('SELECT name FROM secrets').all())) {
          try { const v = openOne(name); if (v && v.length >= MIN_REDACT) known.set(name, v); } catch { /* a value that won't open can't be in the text either */ }
        }
      }
      let out = text;
      for (const [name, v] of [...known].sort((a, b) => b[1].length - a[1].length)) if (out.includes(v)) out = out.split(v).join(`[REDACTED:secret:${name}]`);
      return out;
    },
  };
}
