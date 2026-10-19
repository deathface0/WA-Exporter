/*!
 * WA-Exporter minimal WA-JS entry.
 *
 * Derived from WPPConnect WA-JS (src/index.ts, src/chat/functions/getMessages.ts,
 * src/chat/functions/getActiveChat.ts, src/chat/functions/downloadMedia.ts,
 * src/util/toArrayBuffer.ts), Copyright 2021 WPPConnect Team,
 * licensed under the Apache License, Version 2.0:
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Modified for WA-Exporter: only the module loader and the stores/finders needed
 * for read-only export are bundled. No chat/conn/status/contact modules, no
 * events, no patches, no telemetry. scripts/build-wajs.sh copies this file into
 * the upstream checkout as src/wa-exporter-entry.ts and verifies the output.
 */

import { internalEv } from './eventEmitter';
import * as loader from './loader';
import { msgFindByDirection } from './whatsapp/functions/msgFindByDirection';
import { LruMediaStore } from './whatsapp/misc/LruMediaStore';
import { MediaBlobCache } from './whatsapp/misc/MediaBlobCache';
import { MsgModel } from './whatsapp/models/MsgModel';
import { ChatStore, MsgStore } from './whatsapp/stores';

declare const __VERSION__: string;
declare const __SUPPORTED_WHATSAPP_WEB__: string;

export { loader };
export const version = __VERSION__;
export const supportedWhatsappWeb = __SUPPORTED_WHATSAPP_WEB__;
export const flavor = 'wa-exporter-minimal';

// Serialized ids come from WhatsApp's own toString(); `_serialized` is no longer
// populated on current builds and WA-JS' MsgKey patch is not included here.
const anchors = new Map<string, any>();
// Messages returned by getMessages(); media can only be read for these.
const listed = new Map<string, any>();

function getActiveChat(): any {
  return ChatStore.getModelsArray().find((c: any) => c.active);
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
  const chat: any = ChatStore.get(chatId);
  if (!chat) throw new Error('chat_not_found');

  let count = options.count;
  let anchor: any;
  let appendLast = false;

  if (options.id) {
    anchor = anchors.get(options.id);
    if (!anchor) throw new Error('unknown_anchor');
  } else {
    anchor = chat.lastReceivedKey;
    appendLast = true;
    count--;
  }
  if (!anchor) return [];

  const result: any = await msgFindByDirection({ anchor, count, direction: 'before' } as any);
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
  const live: any = MsgStore.get(msg.id) || msg;
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

  if (filehash && typeof (LruMediaStore as any)?.get === 'function') {
    const buffer = toArrayBuffer(await LruMediaStore.get(filehash).catch(() => null));
    if (buffer) return { blob: new Blob([buffer], { type: mimetype }), source: 'lru' };
  }
  if (filehash && (MediaBlobCache as any)?.has?.(filehash)) {
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
  let inLru: boolean | null = null;
  if (filehash && typeof (LruMediaStore as any)?.has === 'function') {
    inLru = await LruMediaStore.has(filehash).catch(() => null);
  }
  const fields = thumbnailFields(id);
  return {
    isLiveModel: live !== listed.get(id) || typeof live.get === 'function',
    hasMediaData: !!mediaData,
    mediaStage: mediaData ? String(mediaData.mediaStage || '') || null : null,
    hasFilehash: !!filehash,
    inLru,
    inMemory: !!(filehash && (MediaBlobCache as any)?.has?.(filehash)),
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
  const model: any = typeof live.downloadMedia === 'function' ? live : new (MsgModel as any)(live);
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
