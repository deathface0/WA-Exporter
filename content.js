if (!window.waExporterInjected) {
    window.waExporterInjected = true;

    /* ── Selectors (single source of truth for DOM queries) ── */
    const SEL = {
        scrollContainer: '#main [data-scrolltracepolicy="wa.web.conversation.messages"], #main .copyable-area',
        messageRow: '#main div[role="row"]',
        messageText: '[data-testid="selectable-text"], span.selectable-text, span.copyable-text, ._akbw, ._ah6t',
        quotedText: '.quoted-mention',
        metadata: '[data-pre-plain-text]'
    };

    /* ── Constants ── */
    const SCROLL_DELAY_MS = 500;
    const SCROLL_JUMP_PX = 2000;
    const STAGNATION_LIMIT = 5;

    /* ── Message Listener ── */
    browser.runtime.onMessage.addListener((request, _sender, sendResponse) => {
        if (request.action === 'extract_chat') {
            runExtraction(request.start, request.end).then(data => sendResponse({ data }));
            return true;
        }
    });

    /* ── Text Extraction ── */

    function extractTextWithEmojis(element) {
        let text = '';
        for (const child of element.childNodes) {
            if (child.nodeType === Node.TEXT_NODE) {
                text += child.textContent;
            } else if (child.nodeType === Node.ELEMENT_NODE) {
                if (child.getAttribute('aria-hidden') === 'true') continue;
                text += child.tagName === 'IMG' && child.alt
                    ? child.alt
                    : extractTextWithEmojis(child);
            }
        }
        return text.trim() ? text : (element.textContent || '').replace(/\s+/g, ' ').trim();
    }

    /* ── Timestamp Helpers ── */

    function extractTimestampString(node) {
        const meta = node.querySelector(SEL.metadata);
        return meta ? meta.getAttribute('data-pre-plain-text') : null;
    }

    function parseWhatsAppTime(timeStr) {
        if (!timeStr) return 0;

        const match = timeStr.match(/\[(.*?)\]/);
        if (!match) return 0;

        const cleaned = match[1].trim().replace(/[\u200E\u200F\u202A-\u202E]/g, '');
        let date = new Date(cleaned);

        if (isNaN(date.getTime())) {
            const parts = cleaned.split(',');
            if (parts.length >= 2) {
                const timePart = parts[0].includes(':') ? parts[0].trim() : parts[1].trim();
                const datePart = parts[0].includes(':') ? parts[1].trim() : parts[0].trim();

                date = new Date(`${datePart} ${timePart}`);

                if (isNaN(date.getTime())) {
                    const dp = datePart.split(/[\/\-]/);
                    if (dp.length === 3) {
                        date = new Date(`${dp[1]}/${dp[0]}/${dp[2]} ${timePart}`);
                    }
                }
            }
        }

        return isNaN(date.getTime()) ? 0 : date.getTime();
    }

    /**
     * Scans neighbouring nodes to find a valid date string when the current
     * node only has a bare time (e.g. "12:34") without an associated date.
     */
    function getFallbackTime(node) {
        for (const el of node.querySelectorAll('span, div')) {
            const t = (el.textContent || '').trim();
            if (/^\d{1,2}:\d{2}(?:\s*(?:AM|PM|am|pm|a\.?\s*m\.|p\.?\s*m\.))?$/.test(t)) return t;
        }
        return null;
    }

    function getClosestDateString(nodes, index) {
        const extract = (meta) => {
            const m = meta.getAttribute('data-pre-plain-text').match(/\[(.*?)\]/);
            if (m && m[1].includes(',')) {
                const parts = m[1].split(',');
                return parts[0].includes(':') ? parts[1].trim() : parts[0].trim();
            }
            return null;
        };

        for (let i = index; i < nodes.length; i++) {
            const meta = nodes[i].querySelector(SEL.metadata);
            if (meta) { const d = extract(meta); if (d) return d; }
        }
        for (let i = index - 1; i >= 0; i--) {
            const meta = nodes[i].querySelector(SEL.metadata);
            if (meta) { const d = extract(meta); if (d) return d; }
        }
        return new Date().toLocaleDateString('en-US');
    }

    /* ── Scroll Container Detection ── */

    function findScrollContainer() {
        let container = document.querySelector(SEL.scrollContainer);

        if (!container || container.scrollHeight <= container.clientHeight) {
            const row = document.querySelector(SEL.messageRow);
            if (row) {
                let el = row.parentElement;
                while (el && el !== document.body) {
                    const style = window.getComputedStyle(el);
                    if (el.scrollHeight > el.clientHeight && ['auto', 'scroll'].includes(style.overflowY)) {
                        container = el;
                        break;
                    }
                    el = el.parentElement;
                }
            }
        }

        return container;
    }

    /* ── Media / Deleted Message Detection ── */

    function classifyMediaContent(node) {
        const iconCheck = (keyword) => node.querySelector(`span[data-icon*="${keyword}"]`);

        if (iconCheck('recalled')) return '[Mensaje eliminado]';
        if (node.querySelector('img[alt*="Sticker"], img[alt*="sticker"]')) return '[Sticker]';
        if (iconCheck('audio') || node.querySelector('audio')) return '[Audio / Nota de voz]';
        if (iconCheck('video') || node.querySelector('video')) return '[Video]';
        if (iconCheck('gif')) return '[GIF]';
        if (node.querySelector('img[src^="blob:"], img[src^="data:image"]')) return '[Imagen]';
        if (iconCheck('document')) return '[Archivo]';
        if (iconCheck('contact')) return '[Contacto]';
        if (iconCheck('location')) return '[Ubicación]';

        return '[Contenido Multimedia]';
    }

    /* ── Node → Message Object ── */

    function parseMessageNode(node, nodesArray, index) {
        let timeString = extractTimestampString(node);
        let messageTime = parseWhatsAppTime(timeString);

        // Fallback for nodes without full metadata (only bare time visible)
        if (messageTime === 0) {
            const fallback = getFallbackTime(node);
            if (fallback) {
                const sender = node.querySelector('.message-out') ? 'Yo'
                    : node.querySelector('.message-in') ? 'Contacto'
                        : 'Desconocido';
                const dateStr = getClosestDateString(nodesArray, index);
                timeString = `[${fallback}, ${dateStr}] ${sender}: `;
                messageTime = parseWhatsAppTime(timeString);
            }
        }

        if (messageTime === 0) return null;

        // Quoted text
        const quotedEl = node.querySelector(SEL.quotedText);
        let quotedText = '';
        if (quotedEl) {
            quotedText = extractTextWithEmojis(quotedEl);
            if (!quotedText.trim()) {
                if (quotedEl.querySelector('span[data-icon*="image"], img')) quotedText = 'Imagen/Sticker';
                else if (quotedEl.querySelector('span[data-icon*="video"]')) quotedText = 'Video';
                else if (quotedEl.querySelector('span[data-icon*="audio"]')) quotedText = 'Audio';
                else if (quotedEl.querySelector('span[data-icon*="gif"]')) quotedText = 'GIF';
                else quotedText = 'Multimedia';
            }
        }

        // Message body
        const textEls = Array.from(node.querySelectorAll(SEL.messageText));
        const validEls = textEls.filter(el => !el.classList.contains('quoted-mention') && !el.closest('.quoted-mention'));
        let msgText = validEls.length > 0 ? extractTextWithEmojis(validEls[0]) : '';

        if (!msgText.trim() || node.querySelector('span[data-icon*="recalled"]')) {
            msgText = classifyMediaContent(node);
        }

        return { timeString, messageTime, quotedText, msgText };
    }

    /* ── Main Extraction Loop ── */

    async function runExtraction(startTime, endTime) {
        const scrollContainer = findScrollContainer();
        if (!scrollContainer) {
            alert('WA-Exporter: No se encontró el contenedor de scroll.');
            return [];
        }

        let lastSignature = null;
        let stagnateCount = 0;
        const messagesMap = new Map();

        while (true) {
            const nodesArray = Array.from(document.querySelectorAll(SEL.messageRow));

            // Harvest visible messages
            nodesArray.forEach((node, i) => {
                const parsed = parseMessageNode(node, nodesArray, i);
                if (!parsed || parsed.messageTime < startTime || parsed.messageTime > endTime) return;

                let raw = parsed.timeString || `[${new Date(parsed.messageTime).toISOString()}] `;
                if (parsed.quotedText) raw += `[Respondiendo a: "${parsed.quotedText}"] `;
                raw += parsed.msgText;

                const key = `${parsed.messageTime}-${raw.substring(0, 50)}`;
                if (!messagesMap.has(key)) {
                    messagesMap.set(key, { timestamp: parsed.messageTime, rawFormat: raw.trim() });
                }
            });

            // Find the oldest real timestamp in the current DOM
            let oldestTime = 0, oldestSig = '', oldestNode = null;
            for (let i = 0; i < nodesArray.length; i++) {
                let ts = parseWhatsAppTime(extractTimestampString(nodesArray[i]));
                if (ts === 0) {
                    const fb = getFallbackTime(nodesArray[i]);
                    if (fb) ts = parseWhatsAppTime(`[${fb}, ${getClosestDateString(nodesArray, i)}] x: `);
                }
                if (ts > 0) {
                    oldestTime = ts;
                    oldestSig = ts + nodesArray[i].textContent.substring(0, 30);
                    oldestNode = nodesArray[i];
                    break;
                }
            }

            // Stop conditions
            if (nodesArray.length === 0) break;
            if (oldestTime > 0 && oldestTime <= startTime) break;

            if (oldestSig === lastSignature && oldestSig !== '') {
                if (++stagnateCount > STAGNATION_LIMIT) break;
            } else {
                stagnateCount = 0;
                lastSignature = oldestSig;
            }

            // Scroll up aggressively
            if (oldestNode) oldestNode.scrollIntoView({ behavior: 'instant', block: 'start' });
            scrollContainer.scrollBy(0, -1500);
            scrollContainer.scrollTop = Math.max(scrollContainer.scrollTop - SCROLL_JUMP_PX, 0);
            scrollContainer.dispatchEvent(new WheelEvent('wheel', { deltaY: -SCROLL_JUMP_PX, bubbles: true }));
            scrollContainer.dispatchEvent(new Event('scroll', { bubbles: true }));

            await new Promise(r => setTimeout(r, SCROLL_DELAY_MS));
        }

        return Array.from(messagesMap.values()).sort((a, b) => a.timestamp - b.timestamp);
    }
}