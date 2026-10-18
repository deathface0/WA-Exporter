(function () {
    'use strict';

    // MAIN-world read-only facade over the vendored WA-JS bundle.
    // The bundle reference lives only in this closure; nothing else may touch it.
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
    const ALLOWED_ACTIONS = ['wajs_health', 'wajs_active_chat', 'wajs_get_messages', 'wajs_release'];

    // Fields copied from MsgModel instances; getMessages returns live models, not plain objects.
    const MESSAGE_FIELDS = [
        't', 'type', 'subtype', 'body', 'caption', 'filename', 'mimetype', 'size', 'duration',
        'isForwarded', 'forwardingScore', 'notifyName', 'pollName', 'pollSelectableOptionsCount',
        'isViewOnce', 'isGif', 'lat', 'lng', 'loc', 'vcardFormattedName', 'quotedStanzaID',
        'latestEditSenderTimestampMs', 'hasReaction', 'star', 'ack'
    ];
    const JID_FIELDS = ['from', 'to', 'author', 'quotedParticipant', 'quotedRemoteJid'];

    function toJid(value) {
        if (!value) return null;
        if (typeof value === 'string') return value;
        return typeof value._serialized === 'string' ? value._serialized : null;
    }

    function waitReady(timeoutMs) {
        if (core.isReady) return Promise.resolve(true);
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
            'chat.getActiveChat': core.chat && core.chat.getActiveChat
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
        const config = core.config || {};
        const previewServers = config.linkPreviewApiServers;
        const result = {
            ok: false,
            reason: null,
            wajsVersion: core.version || null,
            supportedWhatsappWeb: core.supportedWhatsappWeb || null,
            waVersion: (window.Debug && window.Debug.VERSION) || null,
            loaderType: (core.loader && core.loader.loaderType) || null,
            isReady: false,
            gaDisabled: config.disableGoogleAnalytics === true,
            linkPreviewDisabled: Array.isArray(previewServers) && previewServers.length === 0,
            chat: null,
            missing: []
        };

        if (!result.gaDisabled || !result.linkPreviewDisabled) {
            result.reason = 'unsafe_config';
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

    function release() {
        try { delete window.__waExpCore; } catch (e) { }
        try { delete window.WPPConfig; } catch (e) { }
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

            if (!core.isReady) return reply(callbackId, { error: 'WA-JS not ready' });

            if (action === 'wajs_active_chat') return reply(callbackId, { result: getActiveChatInfo() });

            if (action === 'wajs_get_messages') {
                if (typeof params?.chatId !== 'string') return reply(callbackId, { error: 'Invalid chatId' });
                if (!Number.isInteger(params.count) || params.count < 1 || params.count > MAX_PAGE_SIZE) {
                    return reply(callbackId, { error: 'Invalid count' });
                }
                if (params.id !== undefined && typeof params.id !== 'string') return reply(callbackId, { error: 'Invalid id' });
                return reply(callbackId, { result: await getMessages(params) });
            }
        } catch (err) {
            reply(callbackId, { error: (err && (err.code || err.message)) || 'Unknown error' });
        }
    });
})();
