// The app's configuration: `.env` at the repo root (see .env.example) under the real
// environment, which wins. Kept apart from process.env, and every child process gets
// its environment from childEnv(), so terminals and Cronsole never see the chat key.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

export const ENV_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.env');

/**
 * @param {string} file
 * @param {Record<string, string | undefined>} [base]
 * @returns {Record<string, string | undefined>}
 */
export function loadEnv(file, base = process.env) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') throw err;
  }
  return { ...parseEnv(text), ...base };
}

export const env = loadEnv(ENV_FILE);

/**
 * A program's full path from PATH's absolute entries only, or null. On Windows a bare
 * name is looked up in the working directory first, and a child's working directory is
 * often a workspace repo, so a repo holding its own git.exe or npm.cmd would run instead.
 * @param {string} file e.g. 'git.exe'
 */
export function onPath(file) {
  const dirs = (process.env.PATH || process.env.Path || '').split(path.delimiter).filter((d) => path.isAbsolute(d));
  return dirs.map((d) => path.join(d, file)).find((f) => fs.existsSync(f)) ?? null;
}

/** The app's own credentials (the chat key, under either name; Hub's token): never passed to a child. */
const APP_SECRETS = new Set(['ACC_CHAT_API_KEY', 'ANTHROPIC_API_KEY', 'ACC_HUB_TOKEN']);

/** The values of the app's own credentials that are set, so the diagnostics bundle can leave them out. */
export const appSecretValues = () => [...APP_SECRETS].map((k) => env[k]).filter((v) => typeof v === 'string' && v !== '');

/**
 * The environment for a terminal or other child process: `base` without the app's own
 * credentials, whether they came from .env or the real environment, plus `extra`.
 * Names match case-insensitively, as Windows matches them.
 * @param {Record<string, string | undefined>} base
 * @param {Record<string, string>} [extra]
 * @returns {Record<string, string | undefined>}
 */
export function childEnv(base, extra = {}) {
  return { ...Object.fromEntries(Object.entries(base).filter(([k]) => !APP_SECRETS.has(k.toUpperCase()))), ...extra };
}
