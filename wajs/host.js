(function () {
    'use strict';

    // MAIN-world read-only facade over the vendored minimal WA-JS bundle
    // (scripts/wajs-entry/entry.ts). The bundle reference lives only in this closure.
    // Every core.* access must be listed in scripts/check-readonly.mjs.

    if (window.__waExpWajsHost) return;

    const core = window.__waExpCore;
    if (!core) {
        console.warn('[WA-Exporter WA-JS Host] Bundle global not found, host not started.');
        return;
    }

    Object.defineProperty(window, '__waExpWajsHost', { value: true, configurable: false, enumerable: false });

    const READY_TIMEOUT_MS = 20000;
    const MAX_PAGE_SIZE = 50;
    const ALLOWED_ACTIONS = ['wajs_health', 'wajs_active_chat', 'wajs_get_messages', 'wajs_release',
        'wajs_media_info', 'wajs_media_thumbnail', 'wajs_media_audio', 'wajs_media_download'];
    const MAX_AUDIO_BYTES = 5 * 1024 * 1024;
    // Network download policy (phase 3b): only recent media, never past WhatsApp's re-upload horizon.
    const DEFAULT_MAX_AGE_DAYS = 14;
    const MAX_AGE_DAYS_LIMIT = 30;
    // Base64 signatures of image payloads found in thumbnail fields.
    const IMAGE_PREFIXES = { '/9j/': 'image/jpeg', 'iVBOR': 'image/png', 'UklGR': 'image/webp' };

    // Fields copied from MsgModel instances; getMessages returns live models, not plain objects.
    const MESSAGE_FIELDS = [
        't', 'type', 'subtype', 'body', 'caption', 'filename', 'mimetype', 'size', 'duration',
        'isForwarded', 'forwardingScore', 'notifyName', 'pollName', 'pollSelectableOptionsCount',
        'isViewOnce', 'isGif', 'lat', 'lng', 'loc', 'vcardFormattedName', 'quotedStanzaID',
        'latestEditSenderTimestampMs', 'hasReaction', 'star', 'ack'
    ];
    const JID_FIELDS = ['from', 'to', 'author', 'quotedParticipant', 'quotedRemoteJid'];

    // WhatsApp's own toString() yields the serialized id; `_serialized` is not populated
    // on current builds (WA-JS' MsgKey prototype patch is excluded from the bundle).
    function toJid(value) {
        if (!value) return null;
        if (typeof value === 'string') return value;
        if (typeof value._serialized === 'string') return value._serialized;
        const str = typeof value.toString === 'function' ? value.toString() : '';
        return str.includes('@') ? str : null;
    }

    function waitReady(timeoutMs) {
        if (core.loader.isReady) return Promise.resolve(true);
        return new Promise(resolve => {
            const timer = setTimeout(() => resolve(false), timeoutMs);
            core.loader.onReady(() => {
                clearTimeout(timer);
                resolve(true);
            });
        });
    }

    // Static lookups only: dynamic core[...] access is rejected by check-readonly.
    function missingFunctions() {
        const required = {
            'chat.getMessages': core.chat && core.chat.getMessages,
            'chat.getActiveChat': core.chat && core.chat.getActiveChat,
            'chat.reset': core.chat && core.chat.reset,
            'media.getCached': core.media && core.media.getCached,
            'media.thumbnailFields': core.media && core.media.thumbnailFields,
            'media.info': core.media && core.media.info,
            'media.download': core.media && core.media.download
        };
        return Object.keys(required).filter(name => typeof required[name] !== 'function');
    }

    function getActiveChatInfo() {
        const chat = core.chat.getActiveChat();
        if (!chat || !chat.id) return null;
        return {
            id: toJid(chat.id),
            title: chat.formattedTitle || chat.name || null,
            isGroup: !!chat.isGroup
        };
    }

    function projectPrimitive(value) {
        if (value === null || value === undefined) return null;
        const t = typeof value;
        if (t === 'string' || t === 'number' || t === 'boolean') return value;
        return null;
    }

    function projectMessage(msg, includeKeys) {
        const out = {
            id: toJid(msg.id),
            fromMe: !!(msg.id && msg.id.fromMe)
        };
        MESSAGE_FIELDS.forEach(f => { out[f] = projectPrimitive(msg[f]); });
        if (typeof out.t !== 'number' && typeof msg.senderTimestampMs === 'number') {
            out.t = Math.floor(msg.senderTimestampMs / 1000);
        }
        JID_FIELDS.forEach(f => { out[f] = toJid(msg[f]); });

        out.mentionedJidList = Array.isArray(msg.mentionedJidList) ? msg.mentionedJidList.map(toJid).filter(Boolean) : [];
        out.pollOptions = Array.isArray(msg.pollOptions)
            ? msg.pollOptions.map(o => ({ name: projectPrimitive(o && (o.name || o.optionName)), localId: projectPrimitive(o && o.localId) }))
            : null;
        out.latestEditMsgKey = toJid(msg.latestEditMsgKey);
        out.hasMediaData = !!msg.mediaData;

        const q = msg.quotedMsg;
        out.quotedMsg = q ? {
            type: projectPrimitive(q.type),
            body: projectPrimitive(q.body),
            caption: projectPrimitive(q.caption),
            filename: projectPrimitive(q.filename)
        } : null;

        // Field discovery for phase 0: attribute names only, never values.
        if (includeKeys) {
            const attrs = msg.attributes || msg;
            out.__keys = Object.keys(attrs).sort();
        }
        return out;
    }

    async function health(params) {
        const result = {
            ok: false,
            reason: null,
            wajsVersion: core.version || null,
            flavor: core.flavor || null,
            supportedWhatsappWeb: core.supportedWhatsappWeb || null,
            waVersion: (window.Debug && window.Debug.VERSION) || null,
            loaderType: (core.loader && core.loader.loaderType) || null,
            isReady: false,
            chat: null,
            missing: []
        };

        // Only the minimal build is allowed: the full WA-JS bundle registers patches and events.
        if (result.flavor !== 'wa-exporter-minimal') {
            result.reason = 'unexpected_bundle';
            return result;
        }

        result.isReady = await waitReady(READY_TIMEOUT_MS);
        if (!result.isReady) {
            result.reason = 'not_ready';
            return result;
        }

        result.missing = missingFunctions();
        if (result.missing.length) {
            result.reason = 'api_missing:' + result.missing.join(',');
            return result;
        }

        result.chat = getActiveChatInfo();
        if (!result.chat) {
            result.reason = 'no_active_chat';
            return result;
        }

        // Test guard: stop before reading any message if the open chat is not the expected one.
        const expected = params && typeof params.expectedChatTitle === 'string' ? params.expectedChatTitle : null;
        if (expected && (result.chat.title || '').trim().toLowerCase() !== expected.trim().toLowerCase()) {
            result.reason = 'chat_mismatch';
            return result;
        }

        const canary = await core.chat.getMessages(result.chat.id, { count: 1 });
        const first = Array.isArray(canary) ? canary[0] : null;
        if (!Array.isArray(canary) || (first && (typeof toJid(first.id) !== 'string' || typeof first.t !== 'number'))) {
            result.reason = 'shape_mismatch';
            return result;
        }

        result.ok = true;
        return result;
    }

    async function getMessages(params) {
        const chat = getActiveChatInfo();
        // Only the chat currently open in the UI can be read.
        if (!chat || chat.id !== params.chatId) throw new Error('Chat is not the active chat');

        const options = { count: params.count };
        if (params.id) {
            options.direction = 'before';
            options.id = params.id;
        }
        const msgs = await core.chat.getMessages(chat.id, options);
        return (msgs || []).map(m => projectMessage(m, !!params.includeKeys));
    }

    function base64ToBlob(b64, mime) {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new Blob([bytes], { type: mime });
    }

    // Thumbnail fields hold base64 images or data URIs; decoded locally, never fetched.
    function fieldToBlob(value) {
        const dataUri = /^data:(image\/[\w.+-]+);base64,(.+)$/.exec(value);
        if (dataUri) return base64ToBlob(dataUri[2], dataUri[1]);
        for (const prefix of Object.keys(IMAGE_PREFIXES)) {
            if (value.startsWith(prefix)) return base64ToBlob(value, IMAGE_PREFIXES[prefix]);
        }
        return null;
    }

    async function resizeToDataUri(blob, maxSize) {
        let bitmap;
        try {
            bitmap = await createImageBitmap(blob);
        } catch (e) {
            return null; // not a decodable image (e.g. video)
        }
        const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        bitmap.close();
        let dataUri = canvas.toDataURL('image/webp', 0.6);
        if (!dataUri.startsWith('data:image/webp')) dataUri = canvas.toDataURL('image/jpeg', 0.6);
        return dataUri;
    }

    function blobToDataUri(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('read_failed'));
            reader.readAsDataURL(blob);
        });
    }

    // Local sources only: thumbnail fields on the message, then the media caches.
    async function mediaThumbnail(id, maxSize) {
        const fields = core.media.thumbnailFields(id);
        for (const name of Object.keys(fields)) {
            const blob = fieldToBlob(fields[name]);
            const dataUri = blob && await resizeToDataUri(blob, maxSize);
            if (dataUri) return { dataUri, source: 'field:' + name };
        }
        const cached = await core.media.getCached(id);
        if (cached.blob && /^image\//.test(cached.blob.type || '')) {
            const dataUri = await resizeToDataUri(cached.blob, maxSize);
            if (dataUri) return { dataUri, source: 'cache:' + cached.source };
        }
        return { dataUri: null, source: null };
    }

    async function mediaAudio(id) {
        const cached = await core.media.getCached(id);
        if (!cached.blob) return { dataUri: null, reason: 'not_cached' };
        if (!/^audio\//.test(cached.blob.type || '')) return { dataUri: null, reason: 'not_audio' };
        if (cached.blob.size > MAX_AUDIO_BYTES) return { dataUri: null, reason: 'too_large' };
        return { dataUri: await blobToDataUri(cached.blob), source: 'cache:' + cached.source, size: cached.blob.size };
    }

    // Same call as WhatsApp's "Download" button, for media not in any local cache.
    // want: 'thumbnail' (images/stickers) or 'audio' (voice notes).
    async function mediaDownload(id, want, maxSize, maxAgeDays) {
        const res = await core.media.download(id, { maxAgeSeconds: maxAgeDays * 86400 });
        if (res.skipped) return { status: 'not_downloaded', reason: res.skipped };
        if (!res.cachedAfter) {
            // A 403 from the CDN leaves the media in REUPLOADING: WhatsApp asked the sender to re-upload.
            const expired = res.stageAfter === 'REUPLOADING' || /MISSING|EXPIRED|GONE|403|404|410/i.test(String(res.error || res.stageAfter || ''));
            return { status: expired ? 'expired' : 'error', reason: res.error || res.stageAfter || 'not_cached_after_download' };
        }
        const out = want === 'audio' ? await mediaAudio(id) : await mediaThumbnail(id, maxSize);
        if (!out.dataUri) return { status: 'downloaded', reason: out.reason || 'not_decodable' };
        return { status: want === 'audio' ? 'cached' : 'thumbnail', dataUri: out.dataUri, source: 'network' };
    }

    function release() {
        core.chat.reset();
        try { delete window.__waExpCore; } catch (e) { }
        return { released: true, globalRemoved: !('__waExpCore' in window) };
    }

    function reply(callbackId, payload) {
        window.postMessage(Object.assign({ __waExpWajs: callbackId }, payload), '*');
    }

    window.addEventListener('message', async (event) => {
        if (event.source !== window || !event.data || !event.data.__waExpWajsReq) return;

        const { callbackId, action, params } = event.data;
        if (typeof callbackId !== 'string' || typeof action !== 'string') return;
        if (!ALLOWED_ACTIONS.includes(action)) return reply(callbackId, { error: 'Invalid action' });

        try {
            if (action === 'wajs_health') return reply(callbackId, { result: await health(params) });
            if (action === 'wajs_release') return reply(callbackId, { result: release() });

            if (!core.loader.isReady) return reply(callbackId, { error: 'WA-JS not ready' });

            if (action === 'wajs_active_chat') return reply(callbackId, { result: getActiveChatInfo() });

            if (action === 'wajs_get_messages') {
                if (typeof params?.chatId !== 'string') return reply(callbackId, { error: 'Invalid chatId' });
                if (!Number.isInteger(params.count) || params.count < 1 || params.count > MAX_PAGE_SIZE) {
                    return reply(callbackId, { error: 'Invalid count' });
                }
                if (params.id !== undefined && typeof params.id !== 'string') return reply(callbackId, { error: 'Invalid id' });
                return reply(callbackId, { result: await getMessages(params) });
            }

            if (action === 'wajs_media_download') {
                if (params?.allowNetwork !== true) return reply(callbackId, { error: 'Network download not allowed' });
                if (typeof params.id !== 'string') return reply(callbackId, { error: 'Invalid id' });
                if (params.want !== 'thumbnail' && params.want !== 'audio') return reply(callbackId, { error: 'Invalid want' });
                const maxAgeDays = Number.isInteger(params.maxAgeDays) && params.maxAgeDays >= 1
                    ? Math.min(params.maxAgeDays, MAX_AGE_DAYS_LIMIT) : DEFAULT_MAX_AGE_DAYS;
                const maxSize = Number.isInteger(params.maxSize) && params.maxSize >= 32 && params.maxSize <= 512 ? params.maxSize : 160;
                return reply(callbackId, { result: await mediaDownload(params.id, params.want, maxSize, maxAgeDays) });
            }

            if (action === 'wajs_media_info' || action === 'wajs_media_thumbnail' || action === 'wajs_media_audio') {
                // Only ids returned by a previous wajs_get_messages are known to the bundle.
                if (typeof params?.id !== 'string') return reply(callbackId, { error: 'Invalid id' });
                if (action === 'wajs_media_info') return reply(callbackId, { result: await core.media.info(params.id) });
                if (action === 'wajs_media_audio') return reply(callbackId, { result: await mediaAudio(params.id) });
                const maxSize = Number.isInteger(params.maxSize) && params.maxSize >= 32 && params.maxSize <= 512 ? params.maxSize : 160;
                return reply(callbackId, { result: await mediaThumbnail(params.id, maxSize) });
            }
        } catch (err) {
            reply(callbackId, { error: (err && (err.code || err.message)) || 'Unknown error' });
        }
    });
})();
