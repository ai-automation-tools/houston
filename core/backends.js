// Backend adapter manifests: how the Core starts an agent CLI inside a container (ADR-004).
//
// Each identity gets its own home for its CLI, under the agents folder beside the Core's data
// folder, and signs in there once. The operator's own `~/.claude` and `~/.codex` are never
// granted: besides the sign-in they hold the operator's MCP list, with tokens in its env
// blocks, hooks and history. A fresh home also means the CLI starts with no MCP servers, so
// the manifest doesn't have to replace the list (S3: Codex's `-c mcp_servers={}` merges, it
// doesn't replace, checked 2026-11-12 with `codex mcp list`).
//
// The CLI's own permission prompts stay on as the CLI's UX; the container is the boundary. An
// unattended run (a standing grant's prompt, `headless`) turns them off, since nobody can answer.
// Network needs are declared, not granted: the identity still needs a `net:` grant for each.

import fs from 'node:fs';
import path from 'node:path';

export class BackendError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'BackendError';
  }
}

/**
 * @typedef {{ home: string, appData: string, PATH: string }} Where  the operator's folders
 *
 * @typedef {object} Manifest
 * @property {string} displayName
 * @property {(w: Where) => string[]} programs  the CLI's native program, first one found wins.
 *   Native, not a Node wrapper: Node won't start a script under the denied profile (S3).
 * @property {'file' | 'folder'} read  what of the program the container may read
 * @property {string} homeVar  the variable that points the CLI at its config folder
 * @property {string[]} args
 * @property {Record<string, string>} env
 * @property {boolean} gitBash  Claude Code on Windows runs its shell commands in Git Bash
 * @property {string[]} hosts  `host:port` it talks to; each needs a net: connect grant
 * @property {string} signIn
 * @property {(prompt: string) => string[]} [headless]  the arguments for one unattended run of a prompt (a standing
 *   grant's, H4): no prompts of the CLI's own, since nobody is there to answer them; the container and the
 *   identity's grants are the boundary (ADR-004). A backend without it can't run unattended.
 */

/** @type {Record<string, Manifest>} */
export const BACKENDS = {
  'claude-code': {
    displayName: 'Claude Code',
    programs: ({ home }) => [path.win32.join(home, '.local', 'bin', 'claude.exe')],
    read: 'file',
    homeVar: 'CLAUDE_CONFIG_DIR',
    // Only servers from --mcp-config, which is the session's gateway (gatewayArgs): a workspace .mcp.json adds nothing.
    args: ['--strict-mcp-config'],
    // No telemetry, error reports or self-update (its program is read-only anyway).
    env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' },
    gitBash: true,
    // The model, and the sign-in's token exchange and refresh. The sign-in page itself opens in the operator's browser.
    hosts: ['api.anthropic.com:443', 'platform.claude.com:443'],
    signIn: 'Run /login in the session and paste the code from the browser.',
    // Print mode, one prompt and out; its permission prompts off (the operator's choice, 2026-11-13).
    headless: (prompt) => ['-p', prompt, '--dangerously-skip-permissions'],
  },
  codex: {
    displayName: 'Codex',
    programs: ({ appData }) => ['x86_64-pc-windows-msvc', 'aarch64-pc-windows-msvc'].map((t) => path.win32.join(
      appData, 'npm', 'node_modules', '@openai', 'codex', 'node_modules', '@openai', `codex-win32-${t.startsWith('x86') ? 'x64' : 'arm64'}`, 'vendor', t, 'bin', 'codex.exe')),
    // Its folder: codex.exe starts codex-code-mode-host.exe beside it.
    read: 'folder',
    homeVar: 'CODEX_HOME',
    // Codex's own Windows sandbox can't be set up inside a container; the container is the sandbox. Approvals stay at its default.
    // No update check (GitHub) or analytics: the first contained start reached for both and was denied.
    args: ['--sandbox', 'danger-full-access', '-c', 'check_for_update_on_startup=false', '-c', 'analytics.enabled=false'],
    env: {},
    gitBash: false,
    // ChatGPT sign-in (chatgpt.com, auth.openai.com) or an API key (api.openai.com).
    hosts: ['chatgpt.com:443', 'auth.openai.com:443', 'api.openai.com:443'],
    signIn: 'Choose device sign-in in the session (or run `codex login --device-auth`) and enter the code in the browser.',
  },
};

/** @param {string} p */
const exists = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

/** @param {string} id e.g. local:dev-codex @returns {string} a folder name */
const slug = (id) => id.replace(/^local:/, '').replaceAll('/', '+'); // ids can't hold '+'

/**
 * Turn an identity's backend into what the runner needs. Finds the program on disk now.
 *
 * @param {string} name a key of BACKENDS
 * @param {{ identity: string, agentsRoot: string, where: Where, isFile?: (p: string) => boolean, prompt?: string }} opts
 *   prompt: run it unattended (the manifest's headless start) instead of the interactive CLI
 * @returns {{ command: string, readonly: string[], readwrite: string[], pathDirs: string[], env: Record<string, string>, hosts: string[], home: string, program: string }}
 * @throws {BackendError} for an unknown backend or a program that isn't installed
 */
export function resolveBackend(name, { identity, agentsRoot, where, isFile = exists, prompt }) {
  const m = Object.hasOwn(BACKENDS, name) ? BACKENDS[name] : null;
  if (!m) throw new BackendError(`unknown backend '${name}'; one of ${Object.keys(BACKENDS).join(', ')}`);
  if (prompt !== undefined && !m.headless) throw new BackendError(`${m.displayName} has no unattended start yet`);
  const program = m.programs(where).find(isFile);
  if (!program) throw new BackendError(`${m.displayName} is not installed (looked for ${m.programs(where).join(', ')})`);

  const home = path.win32.join(agentsRoot, slug(identity), name);
  const readonly = [m.read === 'file' ? program : path.win32.dirname(program)];
  const pathDirs = [path.win32.dirname(program)];
  /** @type {Record<string, string>} */
  const env = { ...m.env, [m.homeVar]: home };
  if (m.gitBash) {
    const git = where.PATH.split(';').filter((d) => path.win32.isAbsolute(d)).map((d) => path.win32.join(d, 'git.exe')).find(isFile);
    // <Git>\cmd\git.exe or <Git>\bin\git.exe; bash is <Git>\bin\bash.exe either way.
    const root = git && path.win32.dirname(path.win32.dirname(git));
    const bash = root && path.win32.join(root, 'bin', 'bash.exe');
    if (!root || !bash || !isFile(bash)) throw new BackendError(`${m.displayName} needs Git for Windows (Git Bash), and git.exe isn't on PATH`);
    readonly.push(root);
    pathDirs.push(path.win32.join(root, 'cmd'));
    env.CLAUDE_CODE_GIT_BASH_PATH = bash;
  }
  const args = [...m.args, ...(prompt !== undefined && m.headless ? m.headless(prompt) : [])];
  return { command: [program, ...args].map(quote).join(' '), readonly, readwrite: [home], pathDirs, env, hosts: m.hosts, home, program };
}

/**
 * One argument for a Windows command line, as the C runtime (and CommandLineToArgvW) reads it back:
 * quoted when it has a space, tab or quote or is empty; a quote escaped, and the backslashes before
 * a quote, or before the closing quote, doubled. A prompt's own quotes and backslashes survive.
 * @param {string} a
 */
export function quote(a) {
  if (a && !/[\s"]/.test(a)) return a;
  return `"${a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

/**
 * Point a backend's CLI at the session's gateway (H3): the arguments to add to its command
 * line, quoted. The token stays in HOUSTON_MCP_TOKEN, never on the command line, which the
 * session.start event records.
 * @param {string} name a key of BACKENDS
 * @param {string} url the session's gateway
 * @param {string} dir a folder the session can read (its temp folder), for a config file
 * @returns {string} '' for a backend with no way in
 */
export function gatewayArgs(name, url, dir) {
  if (name === 'claude-code') {
    const file = path.win32.join(dir, 'houston-mcp.json');
    // Claude Code expands ${VAR} in an MCP config's headers.
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { houston: { type: 'http', url, headers: { Authorization: 'Bearer ${HOUSTON_MCP_TOKEN}' } } } }));
    return ['--mcp-config', file].map(quote).join(' ');
  }
  if (name === 'codex') {
    // A value that isn't TOML is taken as a string. The tool timeout covers an approval card's two minutes.
    return ['-c', `mcp_servers.houston.url=${url}`, '-c', 'mcp_servers.houston.bearer_token_env_var=HOUSTON_MCP_TOKEN', '-c', 'mcp_servers.houston.tool_timeout_sec=300']
      .map(quote).join(' ');
  }
  return '';
}

/** What the Control API's `backend.list` shows: the manifests, and whether each program is installed here. @param {Where} where */
export function listBackends(where, isFile = exists) {
  return Object.entries(BACKENDS).map(([name, m]) => ({
    name, displayName: m.displayName, hosts: m.hosts, signIn: m.signIn, installed: m.programs(where).some(isFile),
  }));
}
