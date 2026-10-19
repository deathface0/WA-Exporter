/*!
 * WA-Exporter minimal WA-JS entry.
 *
 * Derived from WPPConnect WA-JS (src/index.ts, src/chat/functions/getMessages.ts,
 * src/chat/functions/getActiveChat.ts), Copyright 2021 WPPConnect Team,
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
    if (m && m.id) anchors.set(m.id.toString(), m.id);
  }
  return msgs;
}

function reset(): void {
  anchors.clear();
}

export const chat = { getActiveChat, getMessages, reset };

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
