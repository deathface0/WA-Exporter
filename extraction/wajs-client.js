(function () {
    'use strict';

    if (typeof browser === 'undefined') {
        window.browser = chrome;
    }

    window.WAExporter = window.WAExporter || {};

    const ALLOWED_ACTIONS = ['wajs_health', 'wajs_active_chat', 'wajs_get_messages', 'wajs_release',
        'wajs_media_info', 'wajs_media_thumbnail', 'wajs_media_audio', 'wajs_media_download',
        'wajs_addons', 'wajs_people'];
    const TIMEOUTS = {
        wajs_health: 25000,
        wajs_active_chat: 2000,
        wajs_get_messages: 15000,
        wajs_release: 2000,
        wajs_media_info: 3000,
        wajs_media_thumbnail: 5000,
        wajs_media_audio: 8000,
        wajs_media_download: 60000,
        wajs_addons: 10000,
        wajs_people: 5000
    };

    // Asks the background to inject the minimal bundle + host into the MAIN world.
    // Only called when the user starts an export (or a dev probe).
    async function ensureInjected(version = null) {
        const res = await browser.runtime.sendMessage({ type: 'inject_wajs', version });
        if (!res || !res.ok) throw new Error((res && res.error) || 'WA-JS injection failed');
        return res;
    }

    // Remembers a WhatsApp build where the health check failed for version reasons.
    async function markIncompatible(waVersion, reason) {
        await browser.runtime.sendMessage({ type: 'wajs_mark_incompatible', waVersion, reason });
    }

    function call(action, params = {}, timeoutMs = null) {
        return new Promise((resolve, reject) => {
            if (!ALLOWED_ACTIONS.includes(action)) return reject(new Error('Invalid action: ' + action));

            const callbackId = 'wj_' + Math.random().toString(36).slice(2, 10) + Date.now();
            const timeoutLimit = timeoutMs || TIMEOUTS[action] || 5000;

            const handler = (event) => {
                if (event.source !== window || !event.data || event.data.__waExpWajs !== callbackId) return;
                window.removeEventListener('message', handler);
                clearTimeout(timerId);
                if (event.data.error) reject(new Error(event.data.error));
                else resolve(event.data.result);
            };

            window.addEventListener('message', handler);
            const timerId = setTimeout(() => {
                window.removeEventListener('message', handler);
                reject(new Error(`Action '${action}' timed out after ${timeoutLimit}ms`));
            }, timeoutLimit);

            window.postMessage({ __waExpWajsReq: true, callbackId, action, params }, '*');
        });
    }

    window.WAExporter.Wajs = { ensureInjected, call, markIncompatible };
})();
