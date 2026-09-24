(function () {
    'use strict';

    if (typeof browser === 'undefined') {
        globalThis.browser = chrome;
    }

    const activeRequests = new Map();
    browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (!message) return;

                if (message.type === 'download_file') {
            try {
                // Use UTF-8 safe base64 encoding
                const utf8Bytes = new TextEncoder().encode(message.text);
                let binaryStr = '';
                for (let i = 0; i < utf8Bytes.length; i++) binaryStr += String.fromCharCode(utf8Bytes[i]);
                const dataUrl = 'data:' + message.mime + ';base64,' + btoa(binaryStr);
                const dlOpts = { url: dataUrl, filename: message.filename, saveAs: true };

                const dlAPI = (typeof browser !== 'undefined' && browser.downloads)
                    ? browser.downloads
                    : (typeof chrome !== 'undefined' && chrome.downloads)
                        ? chrome.downloads : null;

                if (!dlAPI) {
                    sendResponse({ ok: false, error: 'No downloads API available' });
                    return false;
                }

                // Behavioral detection: call download() and check if it returns a thenable.
                // Firefox returns a Promise; Chrome returns undefined and uses callback.
                let callbackUsed = false;
                const result = dlAPI.download(dlOpts, (downloadId) => {
                    callbackUsed = true;
                    // Chrome callback path
                    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.lastError) {
                        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
                    } else if (!downloadId) {
                        sendResponse({ ok: false, error: 'Download failed to start' });
                    } else {
                        sendResponse({ ok: true, downloadId });
                    }
                });

                if (result && typeof result.then === 'function') {
                    // Firefox Promise path — callback won't fire
                    result.then(downloadId => {
                        sendResponse({ ok: true, downloadId });
                    }).catch(err => {
                        sendResponse({ ok: false, error: err.message || 'Download failed' });
                    });
                }

                return true; // Keep message channel open for async response
            } catch(e) {
                console.error('Download failed', e);
                sendResponse({ ok: false, error: e.message });
            }
            return false;
        }
        if (message.type === 'abort_gemini_call') {
            const controller = activeRequests.get(message.requestId);
            if (controller) {
                controller.abort();
                activeRequests.delete(message.requestId);
            }
            sendResponse({ ok: true });
            return false;
        }
        if (message.type === 'gemini_api_call') {
            const { endpoint, method, headers, body } = message;

            if (!endpoint || !endpoint.startsWith('https://generativelanguage.googleapis.com/')) {
                sendResponse({ status: 0, ok: false, error: 'Forbidden endpoint' });
                return false;
            }
            if (method && !['GET', 'POST'].includes(method.toUpperCase())) {
                sendResponse({ status: 0, ok: false, error: 'Forbidden method' });
                return false;
            }

            const controller = new AbortController();
            if (message.requestId) {
                activeRequests.set(message.requestId, controller);
            }
            fetch(endpoint, {
                method: method || 'GET',
                headers: headers || { 'Content-Type': 'application/json' },
                body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
                signal: controller.signal
            })
                .then(async (res) => {
                    const text = await res.text();
                    let data = null;
                    try {
                        data = JSON.parse(text);
                    } catch (e) {
                        data = text;
                    }
                    sendResponse({ status: res.status, ok: res.ok, data: data });
                    if (message.requestId) activeRequests.delete(message.requestId);
                })
                .catch((err) => {
                    sendResponse({ status: 0, ok: false, error: err.message });
                    if (message.requestId) activeRequests.delete(message.requestId);
                });

            return true;
        }
    });
})();
