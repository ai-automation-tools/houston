// Small JSON files under the app's userData folder. Written atomically (temp file +
// rename) so a crash mid-write can't leave a half file behind.

import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { cleanMessages } from '../shared/chat.js';
import { cleanRecent, pushRecent } from '../shared/recent.js';
import { settingsFrom } from '../shared/settings.js';
import { chatFileName, cleanWorkspaces } from '../shared/workspaces.js';
import { cleanIndex, isConversationId, touchConversation } from '../shared/conversations.js';
import { env } from './env.js';

/** @param {string} name */
const file = (name) => path.join(app.getPath('userData'), name);

/** A workspace's chat folder; chatFileName throws for anything that isn't a workspace id. @param {string} ws */
const chatDir = (ws) => {
  chatFileName(ws);
  return path.join('chats', ws);
};

/**
 * @param {string} name
 * @param {unknown} fallback
 */
function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file(name), 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * @param {string} name
 * @param {unknown} data
 */
function writeJson(name, data) {
  const target = file(name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, target);
}

export const store = {
  /** settings.json with neutral defaults; ACC_HUB_URL in .env or the environment overrides the file. */
  settings() {
    return settingsFrom(readJson('settings.json', {}), env);
  },

  recent() {
    return cleanRecent(readJson('recent.json', []));
  },

  /** @param {Parameters<typeof pushRecent>[1]} item */
  addRecent(item) {
    const next = pushRecent(store.recent(), item);
    writeJson('recent.json', next);
    return next;
  },

  /** @returns {{ sidebarWidth: number, terminalHeight: number, terminalOpen: boolean, chatWidth: number, chatOpen: boolean, adBlock: boolean, bookmarkSource: string }} */
  layout() {
    const d = readJson('layout.json', {});
    return {
      sidebarWidth: Number.isFinite(d.sidebarWidth) ? d.sidebarWidth : 300,
      terminalHeight: Number.isFinite(d.terminalHeight) ? d.terminalHeight : 280,
      terminalOpen: d.terminalOpen !== false,
      chatWidth: Number.isFinite(d.chatWidth) ? d.chatWidth : 380,
      chatOpen: d.chatOpen === true,
      adBlock: d.adBlock !== false,
      bookmarkSource: typeof d.bookmarkSource === 'string' ? d.bookmarkSource : '',
    };
  },

  /** @param {Partial<ReturnType<typeof store.layout>>} patch */
  saveLayout(patch) {
    writeJson('layout.json', { ...store.layout(), ...patch });
  },

  /** runs.json: terminal_run's run history, raw; Runs cleans it. */
  runs() {
    return readJson('runs.json', []);
  },

  /** @param {import('../shared/runs.js').Run[]} list */
  saveRuns(list) {
    writeJson('runs.json', list);
  },

  /** workspaces.json; before it exists, a Default workspace holding the tabs layout.json saved. */
  workspaces() {
    const d = readJson('layout.json', {});
    return cleanWorkspaces(readJson('workspaces.json', null), { tabs: d.tabs, activeTab: d.activeTab });
  },

  /** @param {import('../shared/workspaces.js').Workspaces} state */
  saveWorkspaces(state) {
    writeJson('workspaces.json', state);
  },

  /**
   * A workspace's conversations: chats/<ws>/index.json, and one file per conversation
   * beside it. The first read moves the old single conversation (chat.json for Default,
   * chat-<ws>.json otherwise) in as the first one.
   * @param {string} ws
   */
  conversations(ws) {
    const dir = chatDir(ws);
    if (!fs.existsSync(file(path.join(dir, 'index.json')))) {
      const legacy = cleanMessages(readJson(chatFileName(ws), []));
      let index = cleanIndex(null);
      if (legacy.length) {
        const when = fs.statSync(file(chatFileName(ws))).mtimeMs;
        index = touchConversation(index, legacy, when);
        writeJson(path.join(dir, `${index.active}.json`), legacy);
      }
      writeJson(path.join(dir, 'index.json'), index);
      fs.rmSync(file(chatFileName(ws)), { force: true });
      return index;
    }
    return cleanIndex(readJson(path.join(dir, 'index.json'), null));
  },

  /** @param {string} ws @param {import('../shared/conversations.js').ConversationIndex} index */
  saveConversations(ws, index) {
    writeJson(path.join(chatDir(ws), 'index.json'), index);
  },

  /** One conversation, attached page and terminal text included. Empty if it's new, missing or malformed. @param {string} ws @param {string | null} id */
  chat(ws, id) {
    return id && isConversationId(id) ? cleanMessages(readJson(path.join(chatDir(ws), `${id}.json`), [])) : [];
  },

  /** @param {string} ws @param {string} id @param {import('../shared/chat.js').Message[]} messages */
  saveChat(ws, id, messages) {
    if (!isConversationId(id)) throw new Error(`not a conversation id: ${id}`);
    writeJson(path.join(chatDir(ws), `${id}.json`), messages);
  },

  /** @param {string} ws @param {string} id */
  deleteChat(ws, id) {
    if (!isConversationId(id)) throw new Error(`not a conversation id: ${id}`);
    fs.rmSync(file(path.join(chatDir(ws), `${id}.json`)), { force: true });
  },

  /** Every conversation a workspace had, with the workspace. @param {string} ws */
  removeChats(ws) {
    fs.rmSync(file(chatDir(ws)), { recursive: true, force: true });
    fs.rmSync(file(chatFileName(ws)), { force: true });
  },
};
