/*!
 * WA-Exporter minimal WA-JS entry.
 *
 * Derived from WPPConnect WA-JS (src/index.ts, src/chat/functions/getMessages.ts,
 * src/chat/functions/getActiveChat.ts, src/chat/functions/downloadMedia.ts,
 * src/util/toArrayBuffer.ts, src/chat/functions/getVotes.ts,
 * src/contact/functions/getPnLidEntry.ts), Copyright 2021 WPPConnect Team,
 * licensed under the Apache License, Version 2.0:
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Modified for WA-Exporter: only the module loader is bundled; the WhatsApp modules
 * used for read-only export are imported by name. No chat/conn/status/contact or
 * whatsapp/ modules of WA-JS, no events, no patches, no telemetry.
 * scripts/build-wajs.sh copies this file into the upstream checkout as
 * src/wa-exporter-entry.ts and verifies the output.
 */

import { internalEv } from './eventEmitter';
import * as loader from './loader';

declare const __VERSION__: string;
declare const __SUPPORTED_WHATSAPP_WEB__: string;

export { loader };
export const version = __VERSION__;
export const supportedWhatsappWeb = __SUPPORTED_WHATSAPP_WEB__;
export const flavor = 'wa-exporter-minimal';

// WhatsApp modules used here, imported by their own name. Never through WA-JS'
// module lookups: with the meta loader, its searchId imports every WA* module in
// order until one matches, running factories WhatsApp had not loaded (2437 extra
// modules and two sound fetches measured on WA 2.3000.1050809078). WhatsApp
// initializes all of these at startup, and wa() refuses any module it has not.
const MODULES = {
  chats: ['WAWebChatCollection', 'ChatCollection'],
  msgs: ['WAWebMsgCollection', 'MsgCollection'],
  msgFind: ['WAWebDBMessageFindLocal', 'msgFindByDirection'],
  msgModel: ['WAWebMsgModel', 'Msg'],
  lruMedia: ['WAWebMediaStore', 'LruMediaStore'],
  blobCache: ['WAWebMediaInMemoryBlobCache', 'InMemoryMediaBlobCache'],
  reactionsBatch: ['WAWebDBGetReactions', 'getFilteredReactionsFromParentMsgs'],
  reactionsOne: ['WAWebDBGetReactions', 'getReactions'],
  votesTable: ['WAWebPollsVotesSchema', 'getTable'],
  voteFromDbRow: ['WAWebPollsDbSerialization', 'voteFromDbRow'],
  contacts: ['WAWebContactCollection', 'ContactCollection'],
  lidPnCache: ['WAWebApiContact', 'lidPnCache'],
  createWid: ['WAWebWidFactory', 'createWid'],
} as const;
type ModuleKey = keyof typeof MODULES;

// Without these the text engine cannot run (the host then falls back to the DOM).
const REQUIRED: ModuleKey[] = ['chats', 'msgs', 'msgFind'];

function wa(key: ModuleKey): any {
  const [name, exported] = MODULES[key];
  if (loader.loaderType !== 'meta') return null;
  try {
    const entry = loader.__debug().modulesMap[name];
    if (!entry || !entry.factoryFinished) return null;
    const mod: any = loader.loadModule(name);
    return (mod && mod[exported]) || null;
  } catch (e) {
    return null;
  }
}

function missing(): { required: string[]; optional: string[] } {
  const keys = Object.keys(MODULES) as ModuleKey[];
  const absent = keys.filter((k) => !wa(k));
  return {
    required: absent.filter((k) => REQUIRED.includes(k)),
    optional: absent.filter((k) => !REQUIRED.includes(k)),
  };
}

export const modules = { missing };

// Serialized ids come from WhatsApp's own toString(); `_serialized` is no longer
// populated on current builds and WA-JS' MsgKey patch is not included here.
const anchors = new Map<string, any>();
// Messages returned by getMessages(); media can only be read for these.
const listed = new Map<string, any>();

function getActiveChat(): any {
  const chats = wa('chats');
  return chats ? chats.getModelsArray().find((c: any) => c.active) : undefined;
}

// Newest message model loaded in the chat's own collection.
function newestLoadedKey(chat: any): any {
  const models: any[] =
    chat.msgs && typeof chat.msgs.getModelsArray === 'function' ? chat.msgs.getModelsArray() : [];
  let best: any = null;
  for (const m of models) {
    if (m && m.id && typeof m.t === 'number' && (!best || m.t >= best.t)) best = m;
  }
  return best ? best.id : null;
}

/**
 * Messages before `id` (or the newest ones when omitted), oldest first.
 * Same lookup as upstream getMessages() with direction 'before' on the
 * msgFindByDirection API; `id` must be a key returned by a previous call.
 */
async function getMessages(
  chatId: string,
  options: { count: number; id?: string }
): Promise<any[]> {
  const chat: any = wa('chats').get(chatId);
  if (!chat) throw new Error('chat_not_found');

  let count = options.count;
  let anchor: any;
  let appendLast = false;

  if (options.id) {
    anchor = anchors.get(options.id);
    if (!anchor) throw new Error('unknown_anchor');
  } else {
    anchor = chat.lastReceivedKey || newestLoadedKey(chat);
    appendLast = true;
    count--;
  }
  if (!anchor) return [];

  const msgFindByDirection = wa('msgFind');
  const MsgStore = wa('msgs');
  let result: any = await msgFindByDirection({ anchor, count, direction: 'before' });
  // lastReceivedKey can point at an entry outside the message table (seen right after a
  // reaction arrived): the lookup then answers status 404 with no messages.
  if (!options.id && result && result.status === 404) {
    const fallback = newestLoadedKey(chat);
    if (fallback && fallback.toString() !== anchor.toString()) {
      anchor = fallback;
      result = await msgFindByDirection({ anchor, count, direction: 'before' });
    }
  }
  const found: any[] = Array.isArray(result) ? result : result?.messages || [];

  // Prefer the live model only when it is complete: MsgStore can hold partial stubs
  // (seen with t === null) while the database row has every field.
  const msgs = found.map((m: any) => {
    const live: any = MsgStore.get(m.id);
    return live && typeof live.t === 'number' ? live : m;
  });
  if (appendLast) {
    const last = MsgStore.get(anchor);
    if (last) msgs.push(last);
  }

  for (const m of msgs) {
    if (!m || !m.id) continue;
    const key = m.id.toString();
    anchors.set(key, m.id);
    listed.set(key, m);
  }
  return msgs;
}

function reset(): void {
  anchors.clear();
  listed.clear();
}

export const chat = { getActiveChat, getMessages, reset };

function toArrayBuffer(data: any): ArrayBuffer | null {
  if (!data) return null;
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice().buffer;
  }
  return new Uint8Array(data).slice().buffer;
}

function mediaSource(id: string): { live: any; mediaData: any; filehash: string | null; mimetype: string } {
  const msg = listed.get(id);
  if (!msg) throw new Error('unknown_message');
  const live: any = wa('msgs').get(msg.id) || msg;
  const mediaData = live.mediaData || null;
  return {
    live,
    mediaData,
    filehash: (mediaData && mediaData.filehash) || live.filehash || msg.filehash || null,
    mimetype: (mediaData && mediaData.mimetype) || live.mimetype || 'application/octet-stream'
  };
}

/**
 * Cache-only part of upstream downloadMedia(): persistent LruMediaStore, in-memory
 * MediaBlobCache, then the opaque blob already attached to the model. Never downloads.
 */
async function getCached(id: string): Promise<{ blob: Blob | null; source: string | null }> {
  const { mediaData, filehash, mimetype } = mediaSource(id);
  const LruMediaStore = wa('lruMedia');
  const MediaBlobCache = wa('blobCache');

  if (filehash && typeof LruMediaStore?.get === 'function') {
    const buffer = toArrayBuffer(await LruMediaStore.get(filehash).catch(() => null));
    if (buffer) return { blob: new Blob([buffer], { type: mimetype }), source: 'lru' };
  }
  if (filehash && MediaBlobCache?.has?.(filehash)) {
    return { blob: MediaBlobCache.get(filehash), source: 'memory' };
  }
  if (mediaData && mediaData.mediaBlob && typeof mediaData.mediaBlob.forceToBlob === 'function') {
    const blob = mediaData.mediaBlob.forceToBlob();
    if (blob) return { blob, source: 'opaque' };
  }
  return { blob: null, source: null };
}

// Raw thumbnail-like fields on the message, if any (base64 strings or data URIs).
function thumbnailFields(id: string): Record<string, string> {
  const { live, mediaData } = mediaSource(id);
  const out: Record<string, string> = {};
  const candidates: Record<string, any> = {
    thumbnail: live.thumbnail,
    mediaPngThumbnail: live.mediaPngThumbnail,
    thumbnailHQ: live.thumbnailHQ,
    preview: mediaData && mediaData.preview
  };
  for (const name of Object.keys(candidates)) {
    if (typeof candidates[name] === 'string' && candidates[name]) out[name] = candidates[name];
  }
  return out;
}

async function info(id: string): Promise<any> {
  const { live, mediaData, filehash } = mediaSource(id);
  const LruMediaStore = wa('lruMedia');
  const MediaBlobCache = wa('blobCache');
  let inLru: boolean | null = null;
  if (filehash && typeof LruMediaStore?.has === 'function') {
    inLru = await LruMediaStore.has(filehash).catch(() => null);
  }
  const fields = thumbnailFields(id);
  return {
    isLiveModel: live !== listed.get(id) || typeof live.get === 'function',
    hasMediaData: !!mediaData,
    mediaStage: mediaData ? String(mediaData.mediaStage || '') || null : null,
    hasFilehash: !!filehash,
    inLru,
    inMemory: !!(filehash && MediaBlobCache?.has?.(filehash)),
    hasOpaqueBlob: !!(mediaData && mediaData.mediaBlob),
    thumbnailFields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, { length: v.length, prefix: v.slice(0, 5) }]))
  };
}

/**
 * Network download, same call as WhatsApp's own "Download" button (WAWebMediaStage.react)
 * and upstream downloadMedia(). Only reachable through the gated wajs_media_download action.
 * Media older than maxAgeSeconds is never requested: once expired on the CDN (403),
 * WhatsApp asks the sender's phone to re-upload it (stage REUPLOADING).
 * Uses the live model when loaded, otherwise a detached MsgModel built from the database row.
 */
async function download(id: string, opts: { maxAgeSeconds: number }): Promise<any> {
  const { live } = mediaSource(id);
  const t = typeof live.t === 'number' ? live.t
    : typeof live.senderTimestampMs === 'number' ? Math.floor(live.senderTimestampMs / 1000) : null;
  if (!t || !(opts && opts.maxAgeSeconds > 0) || Date.now() / 1000 - t > opts.maxAgeSeconds) {
    return { skipped: 'too_old' };
  }
  const MsgModel = wa('msgModel');
  if (typeof live.downloadMedia !== 'function' && !MsgModel) return { skipped: 'unavailable' };
  const model: any = typeof live.downloadMedia === 'function' ? live : new MsgModel(live);
  const stageBefore = model.mediaData ? String(model.mediaData.mediaStage || '') || null : null;
  let error: string | null = null;
  try {
    await model.downloadMedia({ downloadEvenIfExpensive: true, rmrReason: 1, isUserInitiated: true });
  } catch (e: any) {
    error = (e && (e.code || e.name || e.message)) || 'download_failed';
  }
  const stageAfter = model.mediaData ? String(model.mediaData.mediaStage || '') || null : null;
  const cached = await getCached(id);
  return { stageBefore, stageAfter, error, cachedAfter: cached.source, size: cached.blob ? cached.blob.size : null, detached: model !== live };
}

export const media = { getCached, thumbnailFields, info, download };

// Reactions and poll votes live in the local model-storage tables `reactions` and
// `poll-votes`; WhatsApp renders them from there (WAWebDBGetReactions,
// WAWebAddonPollVoteTableMode). Encrypted vote columns are decrypted locally by the
// storage layer. Only messages already returned by getMessages() can be queried.
function listedKeys(ids: string[]): string[] {
  return (Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string' && listed.has(id));
}

function keyString(value: any): string | null {
  return value === null || value === undefined ? null : String(value);
}

function pushRow(out: Record<string, any[]>, parent: string, row: any): void {
  if (!out[parent]) out[parent] = [];
  out[parent].push(row);
}

async function getReactionRows(ids: string[]): Promise<Record<string, any[]>> {
  const keys = listedKeys(ids);
  const out: Record<string, any[]> = {};
  if (!keys.length) return out;

  const batch = wa('reactionsBatch');
  const one = wa('reactionsOne');
  const rows: any[] = [];
  if (typeof batch === 'function') {
    const byParent: Map<string, any[]> = await batch(keys);
    byParent.forEach((list) => rows.push(...list));
  } else if (typeof one === 'function') {
    for (const key of keys) {
      const res = await one(key);
      for (const group of (res && res.reactions) || []) rows.push(...(group.senders || []));
    }
  } else {
    throw new Error('reactions_unavailable');
  }

  for (const r of rows) {
    const parent = keyString(r && r.parentMsgKey);
    if (!parent || !keys.includes(parent)) continue;
    pushRow(out, parent, {
      msgKey: keyString(r.msgKey),
      sender: keyString(r.senderUserJid),
      text: typeof r.reactionText === 'string' ? r.reactionText : null,
      timestamp: typeof r.timestamp === 'number' ? r.timestamp : null,
    });
  }
  return out;
}

async function getVoteRows(ids: string[]): Promise<Record<string, any[]>> {
  const keys = listedKeys(ids);
  const out: Record<string, any[]> = {};
  if (!keys.length) return out;

  const getTable = wa('votesTable');
  const voteFromDbRow = wa('voteFromDbRow');
  const table: any = typeof getTable === 'function' ? getTable() : null;
  if (!table || typeof voteFromDbRow !== 'function') throw new Error('votes_unavailable');

  const rows: any[] = await table.anyOf(['parentMsgKey'], keys);
  for (const row of rows || []) {
    const parent = keyString(row && row.parentMsgKey);
    if (!parent || !keys.includes(parent)) continue;
    let vote: any;
    try {
      vote = await voteFromDbRow(row);
    } catch (e) {
      continue; // malformed row (e.g. unparsable sender)
    }
    pushRow(out, parent, {
      msgKey: keyString(row.msgKey),
      sender: keyString(vote.sender),
      selected: Array.isArray(vote.selectedOptionLocalIds)
        ? vote.selectedOptionLocalIds.filter((n: any) => typeof n === 'number')
        : [],
      timestamp: typeof vote.senderTimestampMs === 'number' ? vote.senderTimestampMs : null,
    });
  }
  return out;
}

export const addons = { getReactionRows, getVoteRows };

function textOf(value: any): string | null {
  return typeof value === 'string' && value ? value : null;
}

/**
 * Names known to WhatsApp in memory only: ContactStore.get() is a plain index lookup and
 * lidPnCache is an in-memory map. Never ContactStore.find/findQuery or getPnLidEntry,
 * which can query the server. A @lid's phone number is only returned for address-book
 * contacts (`name` set): WhatsApp hides it from the UI otherwise.
 */
function getPeople(jids: string[]): Record<string, any> {
  const ContactStore = wa('contacts');
  const lidPnCache = wa('lidPnCache');
  const createWid = wa('createWid');
  if (!ContactStore) throw new Error('contacts_unavailable');
  const out: Record<string, any> = {};
  for (const jid of Array.isArray(jids) ? jids : []) {
    if (typeof jid !== 'string' || !/^[\w.:-]+@(c\.us|lid)$/.test(jid) || out[jid]) continue;
    const own: any = ContactStore.get(jid);
    let pn: any = null;
    if (jid.endsWith('@lid') && lidPnCache && typeof createWid === 'function') {
      try {
        pn = lidPnCache.getPhoneNumber(createWid(jid)) || null;
      } catch (e) {
        pn = null;
      }
    }
    const viaPn: any = pn ? ContactStore.get(pn.toString()) : null;
    const name = textOf(own && own.name) || textOf(viaPn && viaPn.name);
    out[jid] = {
      name,
      pushname: textOf(own && own.pushname) || textOf(viaPn && viaPn.pushname),
      verifiedName: textOf(own && own.verifiedName) || textOf(viaPn && viaPn.verifiedName),
      phone: name && pn ? textOf(String(pn.user)) : null,
    };
  }
  return out;
}

export const contacts = { getPeople };

// Upstream conn/events/registerMainInit.ts is excluded, but the meta loader waits for
// 'conn.main_init' before setting isReady. Same passive check as conn/functions/isMainInit.
loader.onInjected(() => {
  const check = setInterval(() => {
    if ((window as any).Debug?.VERSION) {
      clearInterval(check);
      internalEv.emit('conn.main_init');
    }
  }, 100);
});

loader.injectLoader();
