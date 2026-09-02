(function () {
    'use strict';

    if (typeof browser === 'undefined') {
        globalThis.browser = chrome;
    }

    browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (!message) return;

        if (message.type === 'gemini_api_call') {
            const { endpoint, method, headers, body } = message;

            fetch(endpoint, {
                method: method || 'GET',
                headers: headers || { 'Content-Type': 'application/json' },
                body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined
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
                })
                .catch((err) => {
                    sendResponse({ status: 0, ok: false, error: err.message });
                });

            return true;
        }
    });
})();
