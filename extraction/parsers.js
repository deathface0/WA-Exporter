(function () {
    'use strict';

    window.WAExporter = window.WAExporter || {};

    const SELECTORS = window.WAExporter.SELECTORS || {};

    const pad = n => n.toString().padStart(2, '0');

    function extractTextWithEmojis(element) {
        if (!element) return '';
        let text = '';
        element.childNodes.forEach(node => {
            if (node.nodeType === Node.TEXT_NODE) {
                text += node.textContent;
            } else if (node.nodeType === Node.ELEMENT_NODE) {
                // Ignore SVG icons and data-icon spans which contain hidden UI text like "ic-imagePhoto" or "ic-keyboard-voice-filled"
                if (node.tagName === 'SVG' || node.hasAttribute('data-icon')) {
                    return;
                }
                if (node.tagName === 'IMG' && node.alt) {
                    text += node.alt;
                } else {
                    text += extractTextWithEmojis(node);
                }
            }
        });
        return text.trim();
    }

    /**
     * Parses the WhatsApp native data-pre-plain-text attribute
     */
    function parsePrePlainText(msgEl) {
        try {
            const copyable = msgEl.querySelector('div.copyable-text[data-pre-plain-text]') ||
                (msgEl.getAttribute && msgEl.getAttribute('data-pre-plain-text') ? msgEl : null);
            if (!copyable) return null;

            const pre = copyable.getAttribute('data-pre-plain-text');
            if (!pre) return null;

            const match = pre.match(/^\[([^,]+),\s*([^\]]+)\]\s*(.*?):\s*$/);
            if (match) {
                return {
                    timeRaw: match[1].trim(),
                    dateRaw: match[2].trim(),
                    senderRaw: match[3].trim()
                };
            }
        } catch (e) {
            console.warn('[WA-Exporter Parsers] Error parsing pre-plain-text:', e);
        }
        return null;
    }

    function parseTimeText(timeStr) {
        if (!timeStr) return null;
        timeStr = timeStr.trim().toLowerCase().replace(/[\u200e\u200f\s]+/g, ' ');

        // 24h format: "14:30" or "14:30:15"
        const match24 = timeStr.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
        if (match24) {
            return { hours: parseInt(match24[1], 10), minutes: parseInt(match24[2], 10) };
        }

        // 12h format: "2:30 pm" or "02:30 am"
        const match12 = timeStr.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm)$/i);
        if (match12) {
            let hours = parseInt(match12[1], 10);
            const minutes = parseInt(match12[2], 10);
            const isPM = match12[3].toLowerCase() === 'pm';
            if (isPM && hours < 12) hours += 12;
            if (!isPM && hours === 12) hours = 0;
            return { hours, minutes };
        }

        return null;
    }

    let detectedDateFormat = null; // 'DMY' or 'MDY'

    function detectDateFormatFromSample(dateStr) {
        if (!dateStr) return;
        const parts = dateStr.trim().split(/[\/\.\-]/);
        if (parts.length === 3) {
            const p0 = parseInt(parts[0], 10);
            const p1 = parseInt(parts[1], 10);
            if (p0 > 12 && p1 <= 12) {
                detectedDateFormat = 'DMY';
            } else if (p1 > 12 && p0 <= 12) {
                detectedDateFormat = 'MDY';
            }
        }
    }

    function parseDateString(dateStr, contextDate = null) {
        if (!dateStr) return null;
        dateStr = dateStr.trim();

        // Handle DD/MM/YYYY, MM/DD/YYYY, YYYY-MM-DD
        const parts = dateStr.split(/[\/\.\-]/);
        if (parts.length === 3) {
            let p0 = parseInt(parts[0], 10);
            let p1 = parseInt(parts[1], 10);
            let p2 = parseInt(parts[2], 10);

            if (p2 < 100) p2 += 2000;

            if (p0 > 1000) {
                // YYYY-MM-DD
                return { year: p0, month: p1 - 1, day: p2 };
            } else if (p0 > 12) {
                // Definitely DD/MM/YYYY
                detectedDateFormat = 'DMY';
                return { year: p2, month: p1 - 1, day: p0 };
            } else if (p1 > 12) {
                // Definitely MM/DD/YYYY
                detectedDateFormat = 'MDY';
                return { year: p2, month: p0 - 1, day: p1 };
            } else {
                // Ambiguous: p0 <= 12 and p1 <= 12
                // 1. Check against contextDate if available
                if (contextDate instanceof Date && !isNaN(contextDate.getTime())) {
                    const ctxMonth1 = contextDate.getMonth() + 1; // 1-12
                    if (p0 === ctxMonth1 && p1 !== ctxMonth1) {
                        return { year: p2, month: p0 - 1, day: p1 }; // MDY
                    } else if (p1 === ctxMonth1 && p0 !== ctxMonth1) {
                        return { year: p2, month: p1 - 1, day: p0 }; // DMY
                    }
                }

                // 2. Check detected format from earlier explicit messages
                if (detectedDateFormat === 'MDY') {
                    return { year: p2, month: p0 - 1, day: p1 };
                } else if (detectedDateFormat === 'DMY') {
                    return { year: p2, month: p1 - 1, day: p0 };
                }

                // 3. Fallback to browser locale
                const lang = (navigator.language || '').toLowerCase();
                if (lang === 'en-us' || lang === 'en') {
                    return { year: p2, month: p0 - 1, day: p1 }; // MDY
                }
                return { year: p2, month: p1 - 1, day: p0 }; // DMY
            }
        }

        return null;
    }

    function findTimeInElement(el) {
        if (!el) return null;

        // 1. Explicit msg-meta
        const meta = el.querySelector('[data-testid="msg-meta"], span[data-testid="msg-meta"], div[data-testid="msg-meta"]');
        if (meta && meta.textContent) {
            const parsed = parseTimeText(meta.textContent);
            if (parsed) return parsed;
        }

        // 2. Aria-labels
        const ariaEls = el.querySelectorAll('[aria-label]');
        for (const a of ariaEls) {
            const label = a.getAttribute('aria-label');
            const parsed = parseTimeText(label);
            if (parsed) return parsed;
        }

        // 3. Leaf text nodes matching time format
        const allNodes = el.querySelectorAll('span, div');
        for (let i = allNodes.length - 1; i >= 0; i--) {
            const node = allNodes[i];
            if (node.children.length === 0) {
                const txt = node.textContent.trim().replace(/[\u200e\u200f\s]+/g, ' ');
                if (/^(\d{1,2}:\d{2}(?:\s*(?:am|pm|AM|PM))?)$/i.test(txt)) {
                    const parsed = parseTimeText(txt);
                    if (parsed) return parsed;
                }
            }
        }

        // 4. Regex scan of element text
        const match = el.textContent.match(/(\b\d{1,2}:\d{2}(?:\s*(?:am|pm|AM|PM))?\b)/i);
        if (match) {
            const parsed = parseTimeText(match[1]);
            if (parsed) return parsed;
        }

        return null;
    }

    function extractTimestamp(msgEl, currentDateContext, prePlain, lastKnownMsg) {
        if (prePlain && prePlain.timeRaw && prePlain.dateRaw) {
            const parsedTime = parseTimeText(prePlain.timeRaw);
            const parsedDate = parseDateString(prePlain.dateRaw, currentDateContext);

            if (parsedTime && parsedDate) {
                const d = new Date(parsedDate.year, parsedDate.month, parsedDate.day, parsedTime.hours, parsedTime.minutes, 0, 0);
                const dateStr = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
                const timeStr = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
                return { timestamp: d.getTime(), dateStr, timeStr };
            }
        }

        // Fallback for pure media (images, stickers, docs): check DOM metadata
        const parsedTime = findTimeInElement(msgEl);
        let baseDate;

        if (currentDateContext) {
            baseDate = new Date(currentDateContext);
        } else if (lastKnownMsg && lastKnownMsg.timestamp) {
            baseDate = new Date(lastKnownMsg.timestamp);
        } else {
            baseDate = new Date();
        }

        if (parsedTime) {
            baseDate.setHours(parsedTime.hours, parsedTime.minutes, 0, 0);
            // If the resulting timestamp is in the future (e.g. 10:13 AM when it is currently 00:30 AM), adjust to yesterday
            if (baseDate.getTime() > Date.now() + 60000 && !currentDateContext) {
                baseDate.setDate(baseDate.getDate() - 1);
            }
        } else if (lastKnownMsg && lastKnownMsg.timestamp) {
            // If message has no visible time badge (e.g. sticker), inherit previous message time
            const prevD = new Date(lastKnownMsg.timestamp);
            baseDate.setHours(prevD.getHours(), prevD.getMinutes(), 0, 0);
        }

        const ts = baseDate.getTime();
        const dateStr = `${pad(baseDate.getDate())}/${pad(baseDate.getMonth() + 1)}/${baseDate.getFullYear()}`;
        const timeStr = `${pad(baseDate.getHours())}:${pad(baseDate.getMinutes())}`;

        return { timestamp: ts, dateStr, timeStr };
    }

    function isOutgoingMessage(msgEl) {
        if (!msgEl) return false;
        const row = msgEl.closest ? (msgEl.closest('[role="row"]') || msgEl.closest('.message-in, .message-out') || msgEl) : msgEl;

        // 1. Delivery checkmarks / ack icons / SVG titles (ONLY present on outgoing messages)
        const checkmarkSelectors = [
            '[data-icon*="check"]',
            '[data-icon*="dblcheck"]',
            '[data-icon*="delivered"]',
            '[data-icon*="read"]',
            '[data-icon="msg-time"]',
            '[data-testid="msg-check"]',
            '[data-testid="msg-dblcheck"]',
            '[data-testid="status-check"]',
            '[data-icon="tail-out"]',
            '[data-testid="tail-out"]'
        ].join(', ');

        if (row.querySelector && row.querySelector(checkmarkSelectors)) return true;
        if (msgEl.querySelector && msgEl.querySelector(checkmarkSelectors)) return true;

        // 2. Scan all SVG titles inside row and msgEl
        const svgTitles = Array.from(row.querySelectorAll ? row.querySelectorAll('svg title, svg') : [])
            .concat(Array.from(msgEl.querySelectorAll ? msgEl.querySelectorAll('svg title, svg') : []));
        for (const svg of svgTitles) {
            const titleText = svg.textContent || svg.getAttribute('title') || '';
            if (/\b(?:delivered|check|dblcheck|read|time|sent|ack|wds-ic-delivered|ic-check)\b/i.test(titleText)) {
                return true;
            }
        }

        // 3. Scan aria-labels for delivery statuses (Sent, Delivered, Read, etc.)
        const ariaLabels = Array.from(row.querySelectorAll ? row.querySelectorAll('[aria-label]') : [])
            .concat(Array.from(msgEl.querySelectorAll ? msgEl.querySelectorAll('[aria-label]') : []));
        for (const el of ariaLabels) {
            const label = el.getAttribute('aria-label') || '';
            if (/\b(?:sent|enviado|delivered|entregado|read|le[ií]do|pending|pendiente|sending|enviando)\b/i.test(label)) {
                return true;
            }
        }

        // 4. WhatsApp Web data-id format: true_remoteJid_msgId
        const dataIdEl = (row.getAttribute && row.getAttribute('data-id')) ? row : (row.querySelector && (row.querySelector('[data-id]') || row.querySelector('[id*="true_"]')));
        if (dataIdEl) {
            const dataId = dataIdEl.getAttribute('data-id') || dataIdEl.getAttribute('id') || '';
            if (dataId.startsWith('true_') || dataId.includes('_true_')) return true;
            if (dataId.startsWith('false_') || dataId.includes('_false_')) return false;
        }

        // 5. CSS class check
        if ((row.classList && row.classList.contains('message-out')) || (row.querySelector && row.querySelector('.message-out')) ||
            (msgEl.classList && msgEl.classList.contains('message-out')) || (msgEl.querySelector && msgEl.querySelector('.message-out'))) {
            return true;
        }

        if ((row.classList && row.classList.contains('message-in')) || (row.querySelector && row.querySelector('.message-in')) ||
            (msgEl.classList && msgEl.classList.contains('message-in')) || (msgEl.querySelector && msgEl.querySelector('.message-in'))) {
            return false;
        }

        return false;
    }

    function isIconOrNoiseText(text) {
        if (!text) return true;
        const lower = text.toLowerCase().trim();
        return /^(?:ic-|wds-|tail-|default-|avatar|menu|search|more|status|document|multi-select|checkbox|icon)/i.test(lower) ||
            /^(?:online|en línea|typing|escribiendo|recording audio|grabando audio|click here for group info|haz clic aquí para ver la información del grupo|group info|info\. del grupo)$/i.test(lower);
    }

    function attachThumbnail(parsedData, mediaElement, blobUrl, maxSize = 160) {
        if (!mediaElement && !blobUrl) return;

        const extractAndSet = (el) => {
            try {
                let width = el.naturalWidth || el.videoWidth || el.width || el.clientWidth;
                let height = el.naturalHeight || el.videoHeight || el.height || el.clientHeight;
                if (!width || !height) return false;

                if (width > height) {
                    if (width > maxSize) {
                        height = Math.round((height * maxSize) / width);
                        width = maxSize;
                    }
                } else {
                    if (height > maxSize) {
                        width = Math.round((width * maxSize) / height);
                        height = maxSize;
                    }
                }

                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(el, 0, 0, width, height);
                parsedData.thumbnail = canvas.toDataURL('image/jpeg', 0.8);
                return true;
            } catch (e) {
                return false;
            }
        };

        // 1. Try synchronous capture if already loaded in the DOM
        if (mediaElement && extractAndSet(mediaElement)) return;

        // 2. If not loaded (width/height 0), fetch the blob immediately before WhatsApp revokes it
        if (blobUrl) {
            fetch(blobUrl)
                .then(res => res.blob())
                .then(blob => {
                    const img = new Image();
                    img.onload = () => {
                        extractAndSet(img);
                        URL.revokeObjectURL(img.src);
                    };
                    img.src = URL.createObjectURL(blob);
                })
                .catch(() => {});
        }
    }

    /**
     * Internal generic tools for parsing messages
     */
    function extractSender(msgEl, prePlain, myName) {
        const outgoing = isOutgoingMessage(msgEl);

        if (outgoing) {
            return myName || (prePlain && prePlain.senderRaw ? prePlain.senderRaw : 'Me');
        }

        // 2. Pre-plain text author if incoming
        if (prePlain && prePlain.senderRaw && !isIconOrNoiseText(prePlain.senderRaw)) {
            return prePlain.senderRaw;
        }

        // 3. Group chat author element check (specific author spans only)
        const authorEl = msgEl.querySelector(SELECTORS.senderName || '[data-testid="msg-author"]');
        if (authorEl && authorEl.textContent.trim()) {
            const t = authorEl.textContent.trim();
            if (!isIconOrNoiseText(t)) return t;
        }

        // 4. Fallback to active chat title from conversation header
        const activeTitle = (typeof window.WAExporter?.getActiveChatTitle === 'function')
            ? window.WAExporter.getActiveChatTitle()
            : null;
        if (activeTitle && !isIconOrNoiseText(activeTitle)) {
            return activeTitle;
        }

        const headerTitle = document.querySelector(SELECTORS.chatTitle || '#main header [data-testid="conversation-info-header-chat-title"]');
        if (headerTitle && headerTitle.textContent.trim()) {
            const t = headerTitle.textContent.trim();
            if (!isIconOrNoiseText(t)) return t;
        }

        return 'Contact';
    }

    function parseQuotedMessage(msgEl) {
        const quotedEl = msgEl.querySelector(SELECTORS.quotedMsg || '[data-testid="quoted-message"], div[aria-label*="Quoted"], div[aria-label*="Respond"]');
        if (!quotedEl) return null;

        // 1. Author of quoted message
        const authorEl = quotedEl.querySelector('[data-testid="author"], span[data-testid="author"], span._11JPr, span[dir="auto"]');
        let sender = authorEl ? authorEl.textContent.trim() : '';

        // 2. Clone quotedEl and remove authorEl
        const clone = quotedEl.cloneNode(true);
        const clonedAuthor = clone.querySelector('[data-testid="author"], span[data-testid="author"], span._11JPr, span[dir="auto"]');
        if (clonedAuthor) {
            clonedAuthor.remove();
        }

        // 3. Detect media tag
        let mediaTag = '';
        if (quotedEl.querySelector(SELECTORS.mediaImage || 'img')) {
            mediaTag = '[Image]';
        } else if (quotedEl.querySelector(SELECTORS.mediaVideo || 'video, [data-icon="video"]')) {
            mediaTag = '[Video]';
        } else if (quotedEl.querySelector(SELECTORS.mediaAudio || '[data-testid="audio-player"]')) {
            mediaTag = '[Audio]';
        } else if (quotedEl.querySelector(SELECTORS.mediaDocument || '[data-testid="document-message"]')) {
            mediaTag = '[Document]';
        } else if (quotedEl.querySelector(SELECTORS.mediaSticker || '[data-testid="sticker"]')) {
            mediaTag = '[Sticker]';
        } else if (quotedEl.querySelector(SELECTORS.mediaContact || '[data-testid="vcard"]')) {
            mediaTag = '[Contact]';
        } else if (quotedEl.querySelector('[data-icon*="view-once"]')) {
            mediaTag = '[View Once Message]';
        }

        // 4. Extract text from clone (or link)
        const linkEl = clone.querySelector('a[href^="http"], a[href^="https"]');
        let text = linkEl && linkEl.href ? linkEl.href : extractTextWithEmojis(clone);

        if (sender && text.startsWith(sender)) {
            text = text.slice(sender.length).trim();
        }

        if (!mediaTag) {
            if (/ic-keyboard-voice|Voice message|Mensaje de voz/i.test(text)) mediaTag = '[Voice Note]';
            else if (/ic-imagePhoto/i.test(text)) mediaTag = '[Image]';
            else if (/ic-video/i.test(text)) mediaTag = '[Video]';
            else if (/ic-gif/i.test(text)) mediaTag = '[GIF]';
            else if (/view once message|mensaje de visualizaci/i.test(text)) mediaTag = '[View Once Message]';
        }

        // Strip UI text artifacts and connected durations (e.g. ic-keyboard-voice-filled0:21 or Mensaje de voz0:21)
        text = text.replace(/(?:ic-[a-zA-Z0-9\-]+|wds-[a-zA-Z0-9\-]+|Voice message|Mensaje de voz)(?:\s*:?\d{1,2}:\d{2})?/gi, '');
        // Strip standalone durations like 0:21, :52, :40, 1:05
        text = text.replace(/^:?\d{1,2}:\d{2}$/, '');
        text = text.replace(/[\u200e\u200f]+/g, '').trim();

        // If it's a voice note or audio quote and only duration remains, discard text
        if ((mediaTag === '[Voice Note]' || mediaTag === '[Audio]' || mediaTag === '[View Once Message]') && /^:?\d{1,2}:\d{2}$/.test(text)) {
            text = '';
        }

        let finalContent = text;
        if (mediaTag && text) {
            finalContent = `${mediaTag} ${text}`;
        } else if (mediaTag && !text) {
            finalContent = mediaTag;
        }

        if (!finalContent) {
            finalContent = '[Media]';
        }

        return {
            sender: sender || 'Contact',
            content: finalContent
        };
    }

    function parseDeletedMessage(msgEl) {
        const deletedEl = msgEl.querySelector(SELECTORS.deletedMsg || '[data-testid="recalled"]');
        const text = msgEl.textContent || '';
        if (deletedEl || text.includes('This message was deleted') || text.includes('Eliminaste este mensaje') || text.includes('Se eliminó este mensaje')) {
            return { type: 'revoked', content: '[Deleted message]', mediaUrl: null };
        }
        return null;
    }

    function parseViewOnceMessage(msgEl) {
        if (msgEl.querySelector('[data-icon*="view-once"]')) {
            return { type: 'view_once', content: '[View Once Message]', mediaUrl: null };
        }
        const text = msgEl.textContent || '';
        if (text.includes('You received a view once message') || text.includes('view once message')) {
            return { type: 'view_once', content: '[View Once Message]', mediaUrl: null };
        }
        return null;
    }

    /**
     * Cleans raw filename strings by removing action verbs (Download, Descargar, etc.), quotes, badges, and icon tags.
     */
    function cleanFilename(raw) {
        if (!raw) return '';
        let str = String(raw).trim();

        // 1. If wrapped in quotes or contains quotes like Download "filename.ext", extract inside quotes
        const quoteMatch = str.match(/["'«“]([^"'»”]+)["'»”]/);
        if (quoteMatch && quoteMatch[1] && (quoteMatch[1].includes('.') || quoteMatch[1].length > 3)) {
            str = quoteMatch[1];
        }

        // 2. Remove common action prefixes across languages
        str = str.replace(/^(?:download|descargar|télécharger|herunterladen|baixar|scarica|open|abrir|view|ver)\s+/i, '');

        // 3. Remove document type badge prefix if followed by filename (e.g. PDFTicket -> Ticket, but NOT Ticket.pdf)
        str = str.replace(/^(?:PDF|DOCX?|XLSX?|PPTX?|JPG|JPEG|PNG|MP[34]|TXT|ZIP|RAR|APK|EPUB)(?=[A-Z0-9_\-\s])/i, '').trim();

        // 4. Remove internal icon artifacts and file size suffix
        str = str.replace(/^(?:tail-(?:in|out))?(?:document-.*?icon)?/i, '').trim();
        str = str.replace(/•\s*\d+(?:\.\d+)?\s*(?:kB|MB|GB|B)\b.*/i, '').trim();
        str = str.replace(/\b\d+\s*(?:pages?|p[aá]ginas?|slides?|diapositivas?)\b.*/i, '').trim();

        // 5. If filename has a valid extension (e.g. .pdf, .docx, .jpeg, .jpg, .png), cleanly capture up to the end of the extension
        const extMatch = str.match(/^(.*?\.(?:pdf|docx?|xlsx?|pptx?|txt|zip|rar|apk|epub|jpg|jpeg|png|webp|mp3|mp4|m4a|ogg|wav|gif|avi|mkv|mov))\b/i);
        if (extMatch && extMatch[1]) {
            str = extMatch[1].trim();
        }

        // 6. Remove leading/trailing quotes
        str = str.replace(/^["'«“]+|["'»”]+$/g, '').trim();

        return str;
    }

    function parseDocumentMessage(msgEl) {
        // Exclude link previews / URL cards unless there is an explicit document icon
        if (msgEl.querySelector('[data-testid="link-preview"], .rich-preview, a[href^="http"], a[href^="https"]')) {
            const isExplicitDoc = msgEl.querySelector('[data-icon*="document"], [data-icon*="pdf"], [data-testid="document-message"], [data-testid*="document-"]');
            if (!isExplicitDoc) {
                return null;
            }
        }

        const docContainer = msgEl.querySelector(SELECTORS.mediaDocument || '[data-testid="document-message"]');
        const hasDocIcon = msgEl.querySelector('[data-icon*="document"], [data-icon*="pdf"], [data-testid="document-message"], [data-testid*="document-"], [data-testid="document-thumb"], span[data-icon*="document"]') !== null;

        // If no explicit document container or icon, it is NOT a document
        if (!docContainer && !hasDocIcon) {
            return null;
        }

        // 1. Direct title span inside the middle container
        let filename = '';
        const titleEl = msgEl.querySelector('div[style*="flex-grow: 1"] > div:first-child span[dir="auto"], [data-testid="document-title"], [data-testid="document-message"] span[dir="auto"]');
        if (titleEl) {
            filename = cleanFilename(titleEl.getAttribute('title') || titleEl.textContent);
        }

        // 2. Search for any child span that has a valid file extension
        if (!filename || filename === 'document') {
            const spans = Array.from(msgEl.querySelectorAll('span[dir="auto"], span[title], div[dir="auto"], span'));
            for (const span of spans) {
                if (span.getAttribute('data-testid') === 'type' || span.hasAttribute('data-meta-key') || span.classList.contains('x1pg5gke')) continue;
                const text = (span.getAttribute('title') || span.textContent || '').trim();
                if (text && /\.(?:pdf|docx?|xlsx?|pptx?|txt|zip|rar|apk|epub|jpg|jpeg|png|webp|mp3|mp4|m4a|ogg|wav)\b/i.test(text)) {
                    filename = cleanFilename(text);
                    if (filename && filename !== 'document') break;
                }
            }
        }

        if (!filename) {
            filename = cleanFilename(msgEl.textContent);
        }

        if (!filename || filename === 'document') {
            filename = 'document';
        }

        const textEl = msgEl.querySelector(SELECTORS.msgText || '.selectable-text.copyable-text');
        let caption = textEl ? extractTextWithEmojis(textEl) : '';
        if (caption) {
            caption = cleanFilename(caption);
        }

        const content = caption && caption !== filename ? `[Document] ${filename} - ${caption}` : `[Document] ${filename}`;

        return {
            type: 'document',
            content: content,
            mediaUrl: null
        };
    }

    function parseStickerMessage(msgEl) {
        const sticker = msgEl.querySelector(SELECTORS.mediaSticker || '[data-testid="sticker"]');
        const hasStickerIcon = msgEl.querySelector('[data-icon="sticker"], [data-testid="sticker"]') !== null;
        if (!sticker && !hasStickerIcon) return null;

        let blobUrl = null;
        if (sticker && sticker.src && (sticker.src.startsWith('blob:') || sticker.src.startsWith('data:'))) {
            blobUrl = sticker.src;
        }

        const parsedData = {
            type: 'sticker',
            content: '[Sticker]',
            mediaUrl: null,
            blobUrl: blobUrl
        };
        attachThumbnail(parsedData, sticker, blobUrl);
        return parsedData;
    }

    function parseImageMessage(msgEl) {
        // Exclude link previews / URL cards (YouTube, Facebook, Instagram, TikTok, etc.)
        if (msgEl.querySelector('[data-testid="link-preview"], .rich-preview, a[href^="http"], a[href^="https"]')) {
            return null;
        }

        const blobImg = msgEl.querySelector('img[src^="blob:"]') || msgEl.querySelector('img[src^="data:"]');
        const img = blobImg || msgEl.querySelector(SELECTORS.mediaImage || 'img');
        const hasImageIcon = msgEl.querySelector('[data-icon*="image"], [data-testid="image-thumb"]') !== null;
        if (!img && !hasImageIcon) return null;

        // Check if it's an emoji img inside text (ignore)
        if (img && (img.classList.contains('emoji') || img.hasAttribute('data-emoji-char'))) return null;

        let blobUrl = null;
        if (img && img.src && (img.src.startsWith('blob:') || img.src.startsWith('data:'))) {
            blobUrl = img.src;
        }

        const textEl = msgEl.querySelector(SELECTORS.msgText || '.selectable-text.copyable-text');
        let caption = textEl ? extractTextWithEmojis(textEl) : '';
        caption = caption.replace(/^(?:view\s+(?:photo|image)|ver\s+(?:foto|imagen)|open\s+photo)\s*/i, '').trim();

        const content = caption ? `[Image] ${caption}` : '[Image]';

        const parsedData = {
            type: 'image',
            content: content,
            mediaUrl: null,
            blobUrl: blobUrl
        };
        attachThumbnail(parsedData, img, blobUrl);
        return parsedData;
    }

    function parseVideoMessage(msgEl) {
        // Exclude link previews / URL cards (YouTube, Facebook, Instagram, TikTok, etc.)
        if (msgEl.querySelector('[data-testid="link-preview"], .rich-preview, a[href^="http"], a[href^="https"]')) {
            return null;
        }

        const video = msgEl.querySelector(SELECTORS.mediaVideo || 'video');
        const hasVideoIcon = msgEl.querySelector('[data-icon="video"], [data-icon="gif"]') !== null;
        if (!video && !hasVideoIcon) return null;

        let blobUrl = null;
        let mediaElement = video;
        if (video) {
            if (video.poster && (video.poster.startsWith('blob:') || video.poster.startsWith('data:'))) {
                blobUrl = video.poster;
            } else if (video.src && (video.src.startsWith('blob:') || video.src.startsWith('data:'))) {
                blobUrl = video.src;
            }
        }
        if (!blobUrl) {
            const posterImg = msgEl.querySelector('img[src^="blob:"], img[src^="data:"]');
            if (posterImg && posterImg.src) {
                blobUrl = posterImg.src;
                mediaElement = posterImg;
            }
        }

        const textEl = msgEl.querySelector(SELECTORS.msgText || '.selectable-text.copyable-text');
        let caption = textEl ? extractTextWithEmojis(textEl) : '';
        caption = caption.replace(/^(?:play\s+video|reproducir\s+video|watch\s+video|ver\s+video)\s*/i, '').trim();

        const isGif = msgEl.querySelector('[data-icon="gif"], [data-testid="gif"]') !== null;
        const tag = isGif ? '[GIF]' : '[Video]';
        const content = caption ? `${tag} ${caption}` : tag;

        const parsedData = {
            type: isGif ? 'gif' : 'video',
            content: content,
            mediaUrl: null,
            blobUrl: blobUrl
        };
        attachThumbnail(parsedData, mediaElement, blobUrl);
        return parsedData;
    }

    function parseAudioMessage(msgEl) {
        const audio = msgEl.querySelector(SELECTORS.mediaAudio || '[data-testid="audio-player"]');
        const hasAudioIcon = msgEl.querySelector('[data-icon*="ptt"], [data-icon*="audio"], [data-testid="audio-player"]') !== null;
        if (!audio && !hasAudioIcon) return null;

        const isPTT = msgEl.querySelector('[data-icon*="ptt"], [data-testid*="ptt"]') !== null;
        const tag = isPTT ? '[Voice Note]' : '[Audio]';

        return {
            type: isPTT ? 'ptt' : 'audio',
            content: tag,
            mediaUrl: null
        };
    }

    function parseContactMessage(msgEl) {
        const hasContactIndicator = msgEl.querySelector(SELECTORS.mediaContact || '[data-testid="vcard"]') !== null ||
            msgEl.querySelector('[data-icon="default-user"], [data-icon="avatar-contact"]') !== null ||
            (msgEl.textContent && (msgEl.textContent.includes('Message') || msgEl.textContent.includes('Add to group') || msgEl.textContent.includes('Enviar mensaje') || msgEl.textContent.includes('Añadir a un grupo') || msgEl.textContent.includes('Ver contacto') || msgEl.textContent.includes('View contact')));

        if (!hasContactIndicator) return null;

        // Find name element inside contact card
        const nameEl = msgEl.querySelector('[data-testid="contact-name"], span[dir="auto"], div[dir="auto"]');
        let name = nameEl ? nameEl.textContent.trim() : '';

        // Clean action words
        name = name.replace(/(?:Message|Add to group|Enviar mensaje|Añadir a un grupo|View contact|Ver contacto|Guardar contacto).*/gi, '').trim();

        if (!name || /^(?:Message|Add to group|Enviar mensaje|Añadir|View contact)$/i.test(name)) {
            const clone = msgEl.cloneNode(true);
            clone.querySelectorAll('button, [role="button"], [data-testid="msg-meta"], [data-icon], svg, [data-testid="author"], span._11JPr, span._2103K').forEach(el => el.remove());
            name = clone.textContent.trim();
        }

        name = name.replace(/[\u200e\u200f]+/g, '').trim();
        if (!name) name = 'Contact';

        return {
            type: 'vcard',
            content: `[Contact] ${name}`,
            mediaUrl: null
        };
    }

    function parsePollMessage(msgEl) {
        const pollBubble = msgEl.querySelector(SELECTORS.mediaPoll || '[data-testid="poll-bubble"]');
        const isPoll = pollBubble !== null ||
            msgEl.querySelector('[data-testid="poll-view-votes"], [data-testid="poll-component"], [data-testid="poll-results"], [data-icon*="poll"]') !== null ||
            (msgEl.textContent && (msgEl.textContent.includes('View votes') || msgEl.textContent.includes('Ver votos') || msgEl.textContent.includes('Select one or more') || msgEl.textContent.includes('Selecciona una o más')));

        if (!isPoll) return null;

        // 1. Extract Question
        let question = '';
        const questionEl = msgEl.querySelector('[data-testid="poll-bubble"] .selectable-text span, [data-testid="poll-bubble"] span.selectable-text, .selectable-text');
        if (questionEl) {
            question = extractTextWithEmojis(questionEl) || questionEl.textContent.trim();
        }

        // Clean UI icon artifacts from question
        question = (question || 'Poll')
            .replace(/\b(?:multi-select-icon-filled|poll-refreshed-thin|ic-[a-zA-Z0-9\-]+|wds-ic-[a-zA-Z0-9\-]+|tail-in|tail-out)\b/gi, '')
            .replace(/[\u200e\u200f]+/g, '')
            .trim();

        if (!question) question = 'Poll';

        // 2. Extract Options & Votes using input[aria-label] or option row testids
        const optionsList = [];

        // Method A: Check input elements with aria-label (e.g. aria-label="opt1 0 votes")
        const optionInputs = msgEl.querySelectorAll('input[type="checkbox"][aria-label], input[type="radio"][aria-label], input[id*="option-"][aria-label]');
        if (optionInputs.length > 0) {
            optionInputs.forEach(input => {
                const label = input.getAttribute('aria-label') || '';
                const m = label.match(/^(.*?)\s+(\d+)\s*(?:votes?|votos?)?$/i);
                if (m && m[1].trim()) {
                    optionsList.push(`${m[1].trim()} (${m[2]} votes)`);
                } else if (label) {
                    optionsList.push(`${label.trim()}`);
                }
            });
        }

        // Method B: Check data-testid="poll-option-row-label-*"
        if (optionsList.length === 0) {
            const labelEls = msgEl.querySelectorAll('[data-testid^="poll-option-row-label-"]');
            if (labelEls.length > 0) {
                labelEls.forEach(labelEl => {
                    const optName = labelEl.textContent.trim();
                    const rowContainer = labelEl.closest('[role="button"], div.x1c4vz4f') || labelEl.parentElement;
                    let votes = '0';
                    if (rowContainer) {
                        const numSpans = Array.from(rowContainer.querySelectorAll('span')).filter(s => /^\d+$/.test(s.textContent.trim()));
                        if (numSpans.length > 0) {
                            votes = numSpans[numSpans.length - 1].textContent.trim();
                        }
                    }
                    if (optName) {
                        optionsList.push(`${optName} (${votes} votes)`);
                    }
                });
            }
        }

        // Method C: Fallback parsing using aria-label of pollBubble
        if (optionsList.length === 0 && pollBubble && pollBubble.hasAttribute('aria-label')) {
            const ariaLabel = pollBubble.getAttribute('aria-label');
            const topVotesMatch = ariaLabel.match(/Top vote counts:\s*(.*?)(?:\.|$)/i);
            if (topVotesMatch && topVotesMatch[1]) {
                const parts = topVotesMatch[1].split(',').map(p => p.trim());
                parts.forEach(p => {
                    const pm = p.match(/^(.*?):\s*(\d+)/);
                    if (pm) {
                        optionsList.push(`${pm[1].trim()} (${pm[2]} votes)`);
                    }
                });
            }
        }

        const optionsFormatted = optionsList.length > 0 ? `: ${optionsList.join(' | ')}` : '';
        const content = `[Poll] ${question}${optionsFormatted}`;

        return {
            type: 'poll',
            content: content,
            mediaUrl: null
        };
    }

    function parseLocationMessage(msgEl) {
        const locationLink = msgEl.querySelector(SELECTORS.mediaLocation || 'a[href*="maps"]');
        if (!locationLink) return null;

        return {
            type: 'location',
            content: `[Location] ${locationLink.href}`,
            mediaUrl: locationLink.href
        };
    }

    function parseTextMessage(msgEl) {
        const textEl = msgEl.querySelector(SELECTORS.msgText || '.selectable-text.copyable-text');
        if (textEl) {
            const text = extractTextWithEmojis(textEl);
            if (text && text.trim()) {
                return {
                    type: 'chat',
                    content: text.trim(),
                    mediaUrl: null
                };
            }
        }

        // Check if there is an explicit link (e.g. Instagram, YouTube, website URL)
        const linkEl = msgEl.querySelector('a[href^="http"], a[href^="https"]');
        if (linkEl && linkEl.href) {
            return {
                type: 'chat',
                content: linkEl.href,
                mediaUrl: null
            };
        }

        // Clean fallback: clone node and remove timestamps/icons before grabbing text
        try {
            const clone = msgEl.cloneNode(true);
            const removeSelectors = '[data-testid="msg-meta"], [data-testid="quoted-message"], button, svg, [data-icon], header, [data-testid="link-preview"]';
            clone.querySelectorAll(removeSelectors).forEach(el => el.remove());
            const text = clone.textContent.trim();
            if (text) {
                return {
                    type: 'chat',
                    content: text,
                    mediaUrl: null
                };
            }
        } catch (e) { }

        return null;
    }

    // Main dispatcher using strategy pattern in order of specificity
    const parsers = [
        parseDeletedMessage,
        parseViewOnceMessage,
        parseStickerMessage,
        parsePollMessage,
        parseContactMessage,
        parseDocumentMessage,
        parseImageMessage,
        parseVideoMessage,
        parseAudioMessage,
        parseLocationMessage,
        parseTextMessage
    ];

    function parseDOMMessage(msgEl, dateContext, lastKnownMsg, myName) {
        const prePlain = parsePrePlainText(msgEl);
        const sender = extractSender(msgEl, prePlain, myName);
        const { timestamp, dateStr, timeStr } = extractTimestamp(msgEl, dateContext, prePlain, lastKnownMsg);
        const quoted = parseQuotedMessage(msgEl);

        // Clone msgEl and strip out the quoted-message element so it doesn't pollute the main message text/media
        let mainMsgEl = msgEl;
        try {
            if (msgEl.querySelector('[data-testid="quoted-message"], div[aria-label*="Quoted"], div[aria-label*="Respond"]')) {
                const clone = msgEl.cloneNode(true);
                clone.querySelectorAll('[data-testid="quoted-message"], div[aria-label*="Quoted"], div[aria-label*="Respond"]').forEach(el => el.remove());
                mainMsgEl = clone;
            }
        } catch (e) { }

        let parsedData = null;
        for (const parser of parsers) {
            parsedData = parser(mainMsgEl);
            if (parsedData) break;
        }

        // If no content and no media, it's not a real message (e.g. placeholder, reaction bar, system divider)
        if (!parsedData || (!parsedData.content && !parsedData.mediaUrl)) {
            return null;
        }

        const quotedSender = quoted && quoted.sender && quoted.sender !== 'Contact' ? `${quoted.sender}: ` : '';
        const quotedPrefix = quoted ? `[Replying to ${quotedSender}"${quoted.content}"] ` : '';
        const rawFormat = `[${timeStr}, ${dateStr}] ${sender}: ${quotedPrefix}${parsedData.content}`;

        let msgId = msgEl.getAttribute('data-id');
        if (!msgId) {
            const parent = msgEl.closest('[data-id]');
            if (parent) msgId = parent.getAttribute('data-id');
        }

        // Mutate parsedData in-place so that any async thumbnail captures
        // (from attachThumbnail's fetch fallback) write to the SAME object
        // that gets stored in the scroller's messageMap.
        parsedData.id = msgId || null;
        parsedData.timestamp = timestamp;
        parsedData.sender = sender;
        parsedData.quotedMessage = quoted;
        parsedData.rawFormat = rawFormat;
        if (!parsedData.blobUrl) parsedData.blobUrl = null;
        if (!parsedData.thumbnail) parsedData.thumbnail = null;

        return parsedData;
    }

    window.WAExporter.Parsers = {
        parseDOMMessage,
        extractSender,
        extractTimestamp,
        parseQuotedMessage,
        extractTextWithEmojis,
        parsePrePlainText,
        cleanFilename,
        isOutgoingMessage
    };
})();
