(function () {
    'use strict';

    if (typeof browser === 'undefined') {
        window.browser = chrome;
    }

    window.WAExporter = window.WAExporter || {};

    let pageScriptReady = null;

    // Injected on demand (first queryDB of a DOM-engine export) and awaited, so the first
    // request is not posted before page-script.js listens. It guards against re-running.
    function ensurePageScript() {
        if (pageScriptReady) return pageScriptReady;

        pageScriptReady = new Promise((resolve) => {
            const oldScript = document.getElementById('wa-exporter-page-script');
            if (oldScript) {
                oldScript.remove();
            }

            try {
                const script = document.createElement('script');
                script.id = 'wa-exporter-page-script';
                script.src = browser.runtime.getURL('db/page-script.js') + '?t=' + Date.now();
                script.onload = () => {
                    console.log('[WA-Exporter Bridge] page-script.js loaded successfully');
                    resolve(true);
                };
                script.onerror = () => {
                    console.warn('[WA-Exporter Bridge] Failed to load page-script.js');
                    pageScriptReady = null;
                    resolve(false);
                };
                (document.head || document.documentElement).appendChild(script);
            } catch (e) {
                console.warn('[WA-Exporter Bridge] Failed to inject page-script.js:', e);
                pageScriptReady = null;
                resolve(false);
            }
        });
        return pageScriptReady;
    }

    // Firefox hands page messages to content scripts behind an XrayWrapper, which rejects our
    // objects as properties. Results are plain data, so a JSON copy makes them ours.
    function toLocal(value) {
        return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    }

    async function queryDB(action, params = {}, timeoutMs = null) {
        await ensurePageScript();

        return new Promise((resolve, reject) => {
            const allowedActions = ['capture_thumbnail', 'extract_audio_blob'];
            if (!allowedActions.includes(action)) return reject(new Error('Invalid action: ' + action));

            const callbackId = 'cb_' + Math.random().toString(36).slice(2, 10) + Date.now();

            const handler = (event) => {
                if (event.source !== window || !event.data || event.data.__waExp !== callbackId) return;
                window.removeEventListener('message', handler);
                clearTimeout(timerId);

                if (event.data.error) {
                    reject(new Error(event.data.error));
                } else {
                    resolve(toLocal(event.data.result));
                }
            };

            window.addEventListener('message', handler);

            // Set timeout according to action
            const defaultTimeout = action === 'capture_thumbnail' ? 2500 : 1000;

            const timeoutLimit = timeoutMs || defaultTimeout;
            const timerId = setTimeout(() => {
                window.removeEventListener('message', handler);
                reject(new Error(`Action '${action}' timed out after ${timeoutLimit}ms`));
            }, timeoutLimit);

            // Send request to MAIN-world page-script
            window.postMessage({
                __waExpReq: true,
                callbackId: callbackId,
                action: action,
                params: params
            }, '*');
        });
    }

    window.WAExporter.queryDB = queryDB;
    window.WAExporter.ensurePageScript = ensurePageScript;
    // No eager injection: page-script.js reaches the MAIN world on the first queryDB() of an export.
})();
