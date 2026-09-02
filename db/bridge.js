(function () {
    'use strict';

    if (typeof browser === 'undefined') {
        window.browser = chrome;
    }

    window.WAExporter = window.WAExporter || {};

    let pageScriptInjected = false;

    async function ensurePageScript() {
        if (pageScriptInjected || document.getElementById('wa-exporter-page-script')) {
            pageScriptInjected = true;
            return;
        }

        try {
            // Method 1: Fetch script content and inject as textContent to avoid CSP external script restrictions
            const scriptUrl = browser.runtime.getURL('db/page-script.js');
            const response = await fetch(scriptUrl);
            const scriptContent = await response.text();

            const script = document.createElement('script');
            script.id = 'wa-exporter-page-script';
            script.textContent = scriptContent;
            (document.head || document.documentElement).appendChild(script);
            script.remove();
            pageScriptInjected = true;
        } catch (e) {
            // Method 2: Fallback to direct script src injection
            try {
                const script = document.createElement('script');
                script.id = 'wa-exporter-page-script';
                script.src = browser.runtime.getURL('db/page-script.js');
                script.onload = () => {
                    pageScriptInjected = true;
                };
                (document.head || document.documentElement).appendChild(script);
            } catch (err) {
                console.warn('[WA-Exporter Bridge] Failed to inject page-script.js:', err);
            }
        }
    }

    function queryDB(action, params = {}, timeoutMs = null) {
        ensurePageScript();

        return new Promise((resolve, reject) => {
            const callbackId = 'cb_' + Math.random().toString(36).slice(2, 10) + Date.now();

            const handler = (event) => {
                if (event.source !== window || !event.data || event.data.__waExp !== callbackId) return;
                window.removeEventListener('message', handler);
                clearTimeout(timerId);

                if (event.data.error) {
                    reject(new Error(event.data.error));
                } else {
                    resolve(event.data.result);
                }
            };

            window.addEventListener('message', handler);

            // Set timeout according to action
            let defaultTimeout = 1000;
            if (action === 'count') defaultTimeout = 500;
            else if (action === 'capture_thumbnail') defaultTimeout = 2500;
            else if (action === 'batch_thumbnails') defaultTimeout = 12000;

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

    // Trigger initial injection
    ensurePageScript();
})();
