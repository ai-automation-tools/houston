// The container request every session starts from. Each default comes from a spike result
// (docs/decisions/spikes/2026-11-12-h0-spike-results.md, "What this changes"):
//
// - `ui: { disable: false }`: without it Node, Git and Python's TLS die with 0xC0000142 (S1).
//   Clipboard and input injection stay denied.
// - Enumerate (names only) on the drive roots of every granted path: Node lstats each parent
//   from the root down (S1). Enumerate is recursive, so it leaks every file name on the drive
//   unless private trees are denied, hence the next rule.
// - Deny the users folder (every profile) and every global deny folder.
// - The workspace and temp folder may not sit under a denied folder: Node will not run there (S1).
// - A clean PATH with System32 first (the SDK shells out to `whoami`), TEMP inside the session's
//   temp folder, and PYTHONNOUSERSITE because per-user site-packages is under the denied profile.
// - Network: everything off, or, with a proxy port, the container proxy setting that leaves
//   that one host port reachable and nothing else (S2). The container sets HTTP(S)_PROXY;
//   NODE_USE_ENV_PROXY makes Node's own fetch use them (H1 egress check).
//
// Pure: builds the request and refuses a bad one; the runner hands it to the SDK.

import path from 'node:path';
import { canonicalPath, pathKey } from './paths.js';

export class LaunchError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'LaunchError';
  }
}

/** @param {string} p canonical @returns {string} the Windows spelling the SDK takes */
const win = (p) => p.replaceAll('/', '\\');

/** @param {string} key @param {string} parentKey */
const within = (key, parentKey) => key === parentKey || key.startsWith(parentKey.endsWith('/') ? parentKey : `${parentKey}/`);

/** Environment names the defaults own; a backend can't set them. */
const OWNED = new Set(['path', 'temp', 'tmp', 'pythonnousersite', 'node_use_env_proxy']);

/**
 * @typedef {object} LaunchSpec
 * @property {string} command the full command line
 * @property {string} workspace the working folder, read and write
 * @property {string} temp this session's temp folder, read and write
 * @property {string} home the operator's profile folder; its parent (the users folder) is denied
 * @property {string[]} [readonly] program folders
 * @property {string[]} [readwrite] other read-write folders, such as a CLI's config folder
 * @property {string[]} [pathDirs] program folders for PATH, after the Windows ones
 * @property {Record<string, string>} [env] extra environment, e.g. from a backend manifest
 * @property {{ id: string, resource: string }[]} [globals] policy.js globalDenies(); each folder is denied
 * @property {string[]} [denied] more folders to deny
 * @property {string} [systemRoot] defaults to C:\Windows
 * @property {number} [proxyPort] the Core's egress proxy on 127.0.0.1; omit for no network at all
 * @property {number} [timeoutMs]
 */

/**
 * @param {LaunchSpec} spec
 * @returns {object} an @microsoft/mxc-sdk v1 ContainerRequest
 * @throws {LaunchError} when the request would be unsafe or would not start
 */
export function launchRequest(spec) {
  const {
    command, workspace, temp, home, readonly = [], readwrite = [], pathDirs = [], env = {},
    globals = [], denied = [], systemRoot = 'C:\\Windows', proxyPort, timeoutMs = 30 * 60_000,
  } = spec;
  if (typeof command !== 'string' || !command.trim() || /[\r\n\0]/.test(command)) throw new LaunchError('the command is one non-empty line');

  /** @param {string} p @param {string} what */
  const canon = (p, what) => {
    try { return canonicalPath(p); } catch (e) { throw new LaunchError(`${what}: ${/** @type {Error} */ (e).message} (${p})`); }
  };
  const ws = canon(workspace, 'workspace');
  const tmp = canon(temp, 'temp folder');
  const users = path.win32.dirname(win(canon(home, 'home')));
  const sys = canon(systemRoot, 'system root');

  const globalDirs = globals.map((g) => {
    const m = /^file:(.+)\/\*\*$/.exec(g.resource);
    if (!m) throw new LaunchError(`global deny ${g.id} is not a folder pattern`);
    return canon(m[1], `global deny ${g.id}`);
  });
  const base = [canon(users, 'users folder'), ...denied.map((d) => canon(d, 'denied folder'))];
  // A global deny inside a folder already denied adds nothing, so only the ones outside go in.
  const deny = dedupe([...base, ...globalDirs.filter((g) => !base.some((b) => within(g.toLowerCase(), b.toLowerCase())))]);
  const globalKeys = globalDirs.map((d) => d.toLowerCase());

  const rw = dedupe([ws, tmp, ...readwrite.map((p) => canon(p, 'read-write folder'))]);
  const ro = dedupe(readonly.map((p) => canon(p, 'read-only folder'))).filter((p) => !rw.some((r) => pathKey(r) === pathKey(p)));

  for (const p of [...rw, ...ro]) {
    const k = p.toLowerCase();
    if (k.length <= 3) throw new LaunchError(`a whole drive can't be granted (${win(p)})`);
    if (globalKeys.some((g) => within(k, g) || within(g, k))) throw new LaunchError(`${win(p)} overlaps a global deny, which no grant overrides`);
  }
  for (const [p, what] of [[ws, 'workspace'], [tmp, 'temp folder']]) {
    const under = deny.find((d) => within(p.toLowerCase(), d.toLowerCase()));
    if (under) throw new LaunchError(`the ${what} ${win(p)} is under the denied folder ${win(under)}; Node can't run there`);
  }

  for (const k of Object.keys(env)) {
    if (OWNED.has(k.toLowerCase())) throw new LaunchError(`${k} is set by the launch defaults`);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new LaunchError(`bad environment name '${k}'`);
    if (typeof env[k] !== 'string' || /[\0\r\n]/.test(env[k])) throw new LaunchError(`${k} must be a one-line string`);
  }

  const PATH = dedupe([`${sys}/System32`, sys, `${sys}/System32/Wbem`, ...pathDirs.map((p) => canon(p, 'PATH folder'))]).map(win).join(';');
  const drives = dedupe([...rw, ...ro, sys].map((p) => `${p.slice(0, 2)}/`)).map(win);

  if (proxyPort !== undefined && !(Number.isInteger(proxyPort) && proxyPort > 0 && proxyPort < 65536)) throw new LaunchError('proxyPort is a port number');
  const network = proxyPort === undefined
    ? { egress: { default: 'deny' } }
    : { egress: { default: 'deny' }, ingress: { default: 'allow', hostLoopback: 'allow' }, runtimeConfig: { networkProxy: `http://127.0.0.1:${proxyPort}` } };

  return {
    command,
    workingDirectory: win(ws),
    environment: { ...env, PATH, TEMP: win(tmp), TMP: win(tmp), PYTHONNOUSERSITE: '1', ...(proxyPort === undefined ? {} : { NODE_USE_ENV_PROXY: '1' }) },
    inheritDefaultEnvironment: true,
    timeoutMs,
    filesystem: { readwritePaths: rw.map(win), readonlyPaths: ro.map(win), deniedPaths: deny.map(win) },
    network,
    ui: { disable: false },
    containment: { type: 'processcontainer', config: { filesystem: { enumeratePaths: drives } } },
  };
}

/** @param {string[]} paths canonical @returns {string[]} first spelling of each, order kept */
function dedupe(paths) {
  const seen = new Set();
  return paths.filter((p) => { const k = p.toLowerCase(); return seen.has(k) ? false : (seen.add(k), true); });
}
