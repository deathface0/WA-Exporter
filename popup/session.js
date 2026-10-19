(function () {
    'use strict';

    // Talks to the WhatsApp tab: injects the content scripts, sends extract/cancel/state
    // messages and relays extraction events. No DOM of the popup is touched here.

    if (typeof browser === 'undefined') {
        window.browser = chrome;
    }
    window.WAExporter = window.WAExporter || {};

    const WHATSAPP_URL = 'web.whatsapp.com';

    const REQUIRED_SCRIPTS = [
        'ai/gemini.js',
        'db/bridge.js',
        'extraction/selectors.js',
        'extraction/parsers.js',
        'extraction/scroller.js',
        'export/formatters.js',
        'extraction/wajs-client.js',
        'extraction/wajs-mapper.js',
        'extraction/wajs-engine.js',
        'extraction/main.js'
    ];

    // Content scripts only (isolated world). db/page-script.js reaches the MAIN world on demand,
    // when the DOM engine first needs it (db/bridge.js).
    async function ensureInjected(tabId) {
        for (const file of REQUIRED_SCRIPTS) {
            try {
                await browser.scripting.executeScript({ target: { tabId }, files: [file] });
            } catch (err) { }
        }
    }

    function isWhatsAppTab(tab) {
        return !!(tab && tab.url && tab.url.includes(WHATSAPP_URL));
    }

    async function getWhatsAppTab() {
        const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
        if (isWhatsAppTab(activeTab)) return activeTab;
        try {
            const waTabs = await browser.tabs.query({ url: '*://web.whatsapp.com/*' });
            if (waTabs && waTabs.length > 0) return waTabs[0];
        } catch (e) { }
        return null;
    }

    async function sendTabMessage(tabId, message, retries = 5) {
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                return await browser.tabs.sendMessage(tabId, message);
            } catch (err) {
                if (attempt === retries) throw err;
                await ensureInjected(tabId);
                await new Promise(resolve => setTimeout(resolve, 350));
            }
        }
    }

    /** { tab, info } with info = { chatName, totalMessages, ... }, or { error: i18nKey }. */
    async function connect() {
        const tab = await getWhatsAppTab();
        if (!tab) return { error: 'errNoWhatsApp' };
        await ensureInjected(tab.id);
        let info;
        try {
            info = await sendTabMessage(tab.id, { action: 'get_chat_info' });
        } catch (e) {
            return { error: 'errConnect' };
        }
        if (!info || !info.chatId) return { tab, error: 'errNoChat' };
        return { tab, info };
    }

    async function getState(tabId) {
        const response = await sendTabMessage(tabId, { action: 'get_extraction_state' });
        return (response && response.state) || null;
    }

    function extract(tabId, payload) {
        return sendTabMessage(tabId, payload);
    }

    async function cancel(tabId) {
        await sendTabMessage(tabId, { action: 'cancel_extraction' });
    }

    /** handlers: { progress(msg), completed(result), error(message) } */
    function onExtractionEvents(handlers) {
        browser.runtime.onMessage.addListener((message) => {
            if (!message) return;
            if (message.type === 'extraction_progress' && handlers.progress) handlers.progress(message);
            else if (message.type === 'extraction_completed' && handlers.completed) handlers.completed(message.result);
            else if (message.type === 'extraction_error' && handlers.error) handlers.error(message.error);
        });
    }

    async function copyToClipboard(text) {
        try {
            await navigator.clipboard.writeText(text);
        } catch (e) {
            const ta = Object.assign(document.createElement('textarea'), { value: text });
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            ta.remove();
        }
    }

    function download(filename, text, mime) {
        browser.runtime.sendMessage({ type: 'download_file', filename, text, mime }).then(res => {
            if (!res || !res.ok) throw new Error('Background download failed');
        }).catch(() => {
            const blob = new Blob([text], { type: mime });
            const url = URL.createObjectURL(blob);
            const a = Object.assign(document.createElement('a'), { href: url, download: filename });
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
        });
    }

    window.WAExporter.Session = {
        connect,
        getState,
        extract,
        cancel,
        onExtractionEvents,
        copyToClipboard,
        download
    };
})();
