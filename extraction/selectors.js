(function () {
    'use strict';

    window.WAExporter = window.WAExporter || {};

    window.WAExporter.SELECTORS = {
        chatContainer: '#main, [role="main"]',
        messageRow: 'div.message-in, div.message-out, div[role="row"]',
        msgContainer: '[data-testid="msg-container"], div.message-in, div.message-out, div[role="row"] > div',
        chatTitle: '#main header [data-testid="conversation-info-header-chat-title"], #main header div[role="button"] span[dir="auto"], #main header span[dir="auto"]',
        copyableText: 'div.copyable-text[data-pre-plain-text]',
        msgText: '[data-testid="msg-text"], .selectable-text.copyable-text, span.selectable-text',
        msgTimestamp: '[data-testid="msg-meta"], span[data-testid="msg-meta"], div[data-testid="msg-meta"]',
        quotedMsg: '[data-testid="quoted-message"], div[aria-label*="Quoted"], div[aria-label*="Respond"]',
        mediaImage: '[data-testid="media-url-provider"] img, img[data-testid="image-thumb"], img[alt*="image" i], img[alt*="photo" i]',
        mediaVideo: '[data-testid="media-url-provider"] video, video',
        mediaAudio: '[data-testid="audio-player"], button[data-testid="audio-play"], [data-testid="audio-track"], [data-testid="ptt-icon"]',
        mediaDocument: '[data-testid="document-message"], span[data-testid="document-title"]',
        mediaSticker: '[data-testid="sticker"], img[src*="sticker"], img[alt*="sticker" i]',
        mediaContact: '[data-testid="vcard"], [data-testid="contact-card"], button[data-testid="vcard-view"], [data-icon="default-user"]',
        mediaPoll: '[data-testid="poll-bubble"], [data-testid="poll-view-votes"], [data-testid="poll-component"], [data-testid="poll-results"], [data-icon*="poll"]',
        mediaLocation: 'a[href*="maps.google"], a[href*="google.com/maps"], a[href*="maps.apple"], a[href*="waze.com"]',
        deletedMsg: '[data-testid="recalled"], span[data-icon="recalled"], [data-testid="icon-recalled"]',
        senderName: '[data-testid="msg-author"], span[data-testid="author"], span._11JPr, span._2103K',
        dateDivider: '[data-testid="chat-date-header"], span[data-testid="chat-date-header"], div[data-testid="chat-date-header"]',
        scrollContainer: 'div[scrollable="true"], .x10l6tqk.x13vifvy.x1o0tod.xupqr0c, #main div[tabindex="-1"], #main div[data-testid="conversation-panel-messages"]'
    };

    window.WAExporter.findScrollContainer = function () {
        const main = document.querySelector('#main');
        if (!main) return null;

        const explicit = main.querySelector('div[scrollable="true"]');
        if (explicit) return explicit;

        const candidate = main.querySelector(window.WAExporter.SELECTORS.scrollContainer);
        if (candidate && candidate.scrollHeight > candidate.clientHeight) return candidate;

        // Fallback: search all divs inside #main with scroll overflow
        const allDivs = main.querySelectorAll('div');
        for (const div of allDivs) {
            const style = window.getComputedStyle(div);
            if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && div.scrollHeight > div.clientHeight) {
                return div;
            }
        }

        return main;
    };
})();
