if (!window.waExporterInjected) {
    window.waExporterInjected = true;

    const SELECTORS = {
        scrollContainer: '#main [data-scrolltracepolicy="wa.web.conversation.messages"], #main .copyable-area',
        messageRow: '#main div[role="row"]',
        messageText: '[data-testid="selectable-text"], span.selectable-text, span.copyable-text, ._akbw, ._ah6t',
        quotedText: '.quoted-mention',
        metadata: '[data-pre-plain-text]'
    };

    browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === "extract_chat") {
            runExtraction(request.start, request.end).then(data => sendResponse({ data }));
            return true;
        }
    });

    function extractTextWithEmojis(element) {
        let text = "";
        for (let child of element.childNodes) {
            if (child.nodeType === Node.TEXT_NODE) {
                text += child.textContent;
            } else if (child.nodeType === Node.ELEMENT_NODE) {
                if (child.getAttribute('aria-hidden') === 'true') continue;
                if (child.tagName === 'IMG' && child.alt) {
                    text += child.alt;
                } else {
                    text += extractTextWithEmojis(child);
                }
            }
        }
        if (!text.trim() && element.textContent) {
            text = element.textContent.replace(/\s+/g, ' ').trim();
        }
        return text;
    }

    function getFallbackTime(node) {
        const elements = Array.from(node.querySelectorAll('span, div')).reverse();
        for (let el of elements) {
            const text = el.textContent || el.innerText;
            if (text && /^\d{1,2}:\d{2}(?:\s*(?:AM|PM|am|pm|a\.?\s*m\.|p\.?\s*m\.))?$/.test(text.trim())) {
                return text.trim();
            }
        }
        return null;
    }

    function getClosestValidDateStr(nodes, index) {
        function extractDate(node) {
            const meta = node.querySelector('[data-pre-plain-text]');
            if (!meta) return null;
            const raw = meta.getAttribute('data-pre-plain-text').replace(/[\u200E\u200F\u202A-\u202E]/g, '').trim();
            // Bracket format: "[1:59 PM, 3/25/2026] Author: "
            const bracketMatch = raw.match(/\[(.*?)\]/);
            if (bracketMatch) {
                const parts = bracketMatch[1].split(',');
                if (parts.length >= 2) {
                    return parts[0].includes(':') ? parts[1].trim() : parts[0].trim();
                }
            }
            // Non-bracket: "1:59 PM, 3/25/2026 Author: "
            const noBracket = raw.match(/^\d{1,2}:\d{2}(?:\s*[AP]M)?,\s*(.+?)\s+\w/i);
            if (noBracket) return noBracket[1].trim();
            return null;
        }

        for (let i = index; i < nodes.length; i++) {
            const d = extractDate(nodes[i]);
            if (d) return d;
        }
        for (let i = index - 1; i >= 0; i--) {
            const d = extractDate(nodes[i]);
            if (d) return d;
        }
        return new Date().toLocaleDateString('en-US');
    }

    function extractTimestampString(node) {
        const metadataNode = node.querySelector('[data-pre-plain-text]');
        if (metadataNode) {
            return metadataNode.getAttribute('data-pre-plain-text');
        }
        return null;
    }

    function parseWhatsAppTime(timeStr) {
        if (!timeStr) return 0;

        timeStr = timeStr.replace(/[\u200E\u200F\u202A-\u202E]/g, '');

        // Bracket format: "[1:59 PM, 3/25/2026] Author: "
        const bracketMatch = timeStr.match(/\[(.*?)\]/);
        if (bracketMatch) {
            let cleanedStr = bracketMatch[1].trim();
            let parsedDate = new Date(cleanedStr);
            if (isNaN(parsedDate.getTime())) {
                const parts = cleanedStr.split(',');
                if (parts.length >= 2) {
                    let timePart = parts[0].includes(':') ? parts[0].trim() : parts[1].trim();
                    let datePart = parts[0].includes(':') ? parts[1].trim() : parts[0].trim();
                    parsedDate = new Date(`${datePart} ${timePart}`);
                    if (isNaN(parsedDate.getTime())) {
                        const dateParts = datePart.split(/[\/\-]/);
                        if (dateParts.length === 3) {
                            parsedDate = new Date(`${dateParts[1]}/${dateParts[0]}/${dateParts[2]} ${timePart}`);
                        }
                    }
                }
            }
            return isNaN(parsedDate.getTime()) ? 0 : parsedDate.getTime();
        }

        // Non-bracket format: "1:59 PM, 3/27/2026 Author: "
        const noBracketMatch = timeStr.match(/^(\d{1,2}:\d{2}(?:\s*[AP]M)?),\s*(.+?)\s+[\w\s]+:\s*$/i);
        if (noBracketMatch) {
            const timePart = noBracketMatch[1].trim();
            const datePart = noBracketMatch[2].trim();
            let parsedDate = new Date(`${datePart} ${timePart}`);
            if (isNaN(parsedDate.getTime())) {
                const dateParts = datePart.split(/[\/\-]/);
                if (dateParts.length === 3) {
                    parsedDate = new Date(`${dateParts[1]}/${dateParts[0]}/${dateParts[2]} ${timePart}`);
                }
            }
            return isNaN(parsedDate.getTime()) ? 0 : parsedDate.getTime();
        }

        return 0;
    }

    async function runExtraction(startTime, endTime) {
        console.log(`[WA-Exporter] Starting extraction. Target window: ${new Date(startTime).toLocaleString()} to ${new Date(endTime).toLocaleString()}`);

        let scrollContainer = document.querySelector(SELECTORS.scrollContainer);

        if (!scrollContainer || scrollContainer.scrollHeight <= scrollContainer.clientHeight) {
            const row = document.querySelector(SELECTORS.messageRow);
            if (row) {
                let el = row.parentElement;
                while (el && el !== document.body) {
                    const style = window.getComputedStyle(el);
                    if (el.scrollHeight > el.clientHeight && (style.overflowY === 'auto' || style.overflowY === 'scroll')) {
                        scrollContainer = el;
                        break;
                    }
                    el = el.parentElement;
                }
            }
        }

        if (!scrollContainer) {
            console.error("[WA-Exporter] Could not find the scroll container!");
            alert("WA-Exporter Error: Scroll container not found.");
            return [];
        }

        let fetching = true;
        let lastSignature = null;
        let stagnateCount = 0;
        let scrollIterations = 0;
        const extractedMessagesMap = new Map();

        while (fetching) {
            scrollIterations++;
            console.log(`[WA-Exporter] --- Scroll Iteration ${scrollIterations} ---`);
            const nodesArray = Array.from(document.querySelectorAll(SELECTORS.messageRow));

            nodesArray.forEach((node, index) => {
                let timeString = extractTimestampString(node);
                let messageTime = parseWhatsAppTime(timeString);

                if (messageTime === 0) {
                    const fallbackTimeString = getFallbackTime(node);
                    if (fallbackTimeString) {
                        let sender = "Desconocido";
                        if (node.querySelector('.message-out')) sender = "Yo";
                        else if (node.querySelector('.message-in')) sender = "Contacto";

                        let dateStr = getClosestValidDateStr(nodesArray, index);
                        timeString = `[${fallbackTimeString}, ${dateStr}] ${sender}: `;
                        messageTime = parseWhatsAppTime(timeString);
                    }
                }

                if (messageTime > 0 && messageTime >= startTime && messageTime <= endTime) {
                    const allTextElements = Array.from(node.querySelectorAll(SELECTORS.messageText));
                    const validTextElements = allTextElements.filter(el =>
                        !el.classList.contains('quoted-mention') && !el.closest('.quoted-mention')
                    );
                    const quotedElement = node.querySelector(SELECTORS.quotedText);

                    let quotedText = "";
                    if (quotedElement) {
                        quotedText = extractTextWithEmojis(quotedElement);
                        if (!quotedText.trim()) {
                            const qHtml = quotedElement.innerHTML;
                            const qIcons = [...qHtml.matchAll(/data-icon="([^"]+)"/g)].map(m => m[1]);
                            const qHasIcon = (name) => qIcons.some(i => i.includes(name));

                            if (qHasIcon('image') || qHtml.includes('blob:') || qHtml.includes('data:image')) {
                                const qBlobImg = quotedElement.querySelector('img[src^="blob:"]');
                                if (qBlobImg && qBlobImg.hasAttribute('src')) {
                                    quotedText = `[Imagen citada: ${qBlobImg.getAttribute('src')}]`;
                                } else {
                                    quotedText = "[Imagen citada]";
                                }
                            } else if (qHasIcon('audio') || qHasIcon('ptt-status')) {
                                const qBlobAudio = quotedElement.querySelector('audio[src^="blob:"]');
                                if (qBlobAudio && qBlobAudio.hasAttribute('src')) {
                                    quotedText = `[Audio citado: ${qBlobAudio.getAttribute('src')}]`;
                                } else {
                                    quotedText = "[Audio citado]";
                                }
                            } else if (qHasIcon('video') || quotedElement.querySelector('video')) {
                                const qBlobVideo = quotedElement.querySelector('video[src^="blob:"]');
                                if (qBlobVideo && qBlobVideo.hasAttribute('src')) {
                                    quotedText = `[Video citado: ${qBlobVideo.getAttribute('src')}]`;
                                } else {
                                    quotedText = "[Video citado]";
                                }
                            } else {
                                const qFileTypeSpan = quotedElement.querySelector('span[data-meta-key="type"]');
                                if (qFileTypeSpan || ['document', 'pdf', 'xls', 'ppt', 'txt', 'zip', 'ms-office'].some(qHasIcon)) {
                                    const fType = qFileTypeSpan ? qFileTypeSpan.textContent.trim() : "";
                                    quotedText = fType ? `[Archivo ${fType} citado]` : "[Archivo citado]";
                                }
                            }
                        }
                    }

                    let messageText = "";
                    if (validTextElements.length > 0) {
                        messageText = extractTextWithEmojis(validTextElements[0]);
                    }

                    const nodeHtml = node.innerHTML;
                    let mediaTag = "";

                    const dataIcons = [...nodeHtml.matchAll(/data-icon="([^"]+)"/g)].map(m => m[1]);
                    const hasIcon = (name) => dataIcons.some(i => i.includes(name));

                    if (hasIcon('recalled')) {
                        mediaTag = "Mensaje eliminado";

                    } else if (hasIcon('sticker') || nodeHtml.includes('alt="Sticker"') || nodeHtml.includes('alt="sticker"')
                        || node.querySelector('img[src^="blob:"][class*="sticker"], canvas[class*="sticker"]')) {
                        mediaTag = "[Sticker]";

                        // Documents BEFORE audio — "audio" substring appears in some doc icon names
                    } else if (
                        node.querySelector('span[data-meta-key="type"]') ||
                        ['document', 'pdf', 'xls', 'ppt', 'txt', 'zip', 'ms-office'].some(hasIcon) ||
                        node.querySelector('span[data-testid*="media-file"], [data-testid="media-document"]')
                    ) {
                        const fileTypeSpan = node.querySelector('span[data-meta-key="type"]');
                        const fType = fileTypeSpan ? fileTypeSpan.textContent.trim() : "";

                        // Try to grab filename
                        const nameEl = node.querySelector('span[dir="auto"].ao3e, [data-testid="media-document-title"]')
                            || node.querySelector('span[dir="auto"]');
                        const fname = nameEl ? nameEl.textContent.trim() : null;

                        if (fname && fType) mediaTag = `[Archivo ${fType}: ${fname}]`;
                        else if (fname) mediaTag = `[Archivo: ${fname}]`;
                        else if (fType) mediaTag = `[Archivo ${fType}]`;
                        else mediaTag = "[Archivo]";

                        // Audio / PTT — checked AFTER documents
                    } else if (
                        hasIcon('ptt-status') || hasIcon('audio-play') ||
                        nodeHtml.includes('aria-label="Voice message"') ||
                        nodeHtml.includes('aria-label="Play voice message"') ||
                        node.querySelector('button[aria-label="Play voice message"]')
                    ) {
                        const blobAudio = node.querySelector('audio[src^="blob:"]');
                        if (blobAudio && blobAudio.hasAttribute('src')) {
                            mediaTag = `[Audio: ${blobAudio.getAttribute('src')}]`;
                        } else {
                            mediaTag = "[Audio]";
                        }

                        // GIF — WhatsApp renders GIFs as <video autoplay loop> or has data-icon="gif"
                    } else if (hasIcon('gif') || nodeHtml.includes('data-gif-attribution')
                        || node.querySelector('video[autoplay][loop]')) {
                        const blobGif = node.querySelector('video[src^="blob:"]');
                        if (blobGif && blobGif.hasAttribute('src')) {
                            mediaTag = `[GIF: ${blobGif.getAttribute('src')}]`;
                        } else {
                            mediaTag = "[GIF]";
                        }

                    } else if (hasIcon('video') || node.querySelector('video')) {
                        const blobVideo = node.querySelector('video[src^="blob:"]');
                        if (blobVideo && blobVideo.hasAttribute('src')) {
                            mediaTag = `[Video: ${blobVideo.getAttribute('src')}]`;
                        } else {
                            mediaTag = "[Video]";
                        }

                    } else if (hasIcon('contact')) {
                        mediaTag = "[Contacto]";

                    } else if (hasIcon('location')) {
                        mediaTag = "[Ubicación]";

                    } else if (hasIcon('image') || node.querySelector('img[src^="blob:"], img[src^="data:image"]')) {
                        const blobImg = node.querySelector('img[src^="blob:"]');
                        if (blobImg && blobImg.hasAttribute('src')) {
                            mediaTag = `[Imagen: ${blobImg.getAttribute('src')}]`;
                        } else {
                            mediaTag = "[Imagen]";
                        }
                    }

                    if (mediaTag === "Mensaje eliminado") {
                        messageText = "[Mensaje eliminado]";
                    } else if (mediaTag) {
                        messageText = messageText.trim() ? `${mediaTag} ${messageText.trim()}` : mediaTag;
                    } else if (!messageText.trim()) {
                        messageText = "[Contenido Multimedia]";
                    }

                    if (messageText || timeString) {
                        let rawFormat = timeString || `[${new Date(messageTime).toISOString()}] `;
                        if (quotedText) rawFormat += `[Respondiendo a: "${quotedText}"] `;
                        rawFormat += messageText;

                        let uniqueKey;
                        const msgNodeWithId = node.querySelector('[data-id]');
                        if (msgNodeWithId) {
                            uniqueKey = msgNodeWithId.getAttribute('data-id');
                        } else {
                            uniqueKey = `${messageTime}-${rawFormat.substring(0, 50)}`;
                        }

                        if (!extractedMessagesMap.has(uniqueKey)) {
                            extractedMessagesMap.set(uniqueKey, {
                                timestamp: messageTime,
                                rawFormat: rawFormat.trim()
                            });
                        }
                    }
                }
            });

            if (nodesArray.length > 0) {
                let oldestTime = 0;
                let oldestSignature = "";
                let oldestActualNode = null;

                for (let i = 0; i < nodesArray.length; i++) {
                    const node = nodesArray[i];
                    let ts = parseWhatsAppTime(extractTimestampString(node));

                    if (ts === 0) {
                        const fallbackTs = getFallbackTime(node);
                        if (fallbackTs) {
                            let dateStr = getClosestValidDateStr(nodesArray, i);
                            ts = parseWhatsAppTime(`[${fallbackTs}, ${dateStr}] Unknown: `);
                        }
                    }

                    if (ts > 0) {
                        oldestTime = ts;
                        oldestSignature = ts.toString() + node.textContent.substring(0, 30);
                        oldestActualNode = node;
                        break;
                    }
                }

                if (oldestTime > 0 && oldestTime <= startTime) {
                    fetching = false;
                    break;
                }

                if (oldestSignature === lastSignature && oldestSignature !== "") {
                    stagnateCount++;
                    if (stagnateCount > 4) {
                        fetching = false;
                        break;
                    }
                } else {
                    stagnateCount = 0;
                    lastSignature = oldestSignature;
                }

                if (fetching) {
                    if (oldestActualNode) {
                        oldestActualNode.scrollIntoView({ behavior: 'instant', block: 'start' });
                    }
                    scrollContainer.scrollBy(0, -1500);
                    scrollContainer.scrollTop -= 2000;
                    if (scrollContainer.scrollTop <= 100) {
                        scrollContainer.scrollTop = 0;
                    }
                    scrollContainer.dispatchEvent(new WheelEvent('wheel', { deltaY: -2000, bubbles: true }));
                    scrollContainer.dispatchEvent(new Event('scroll', { bubbles: true }));

                    await new Promise(resolve => setTimeout(resolve, 500));
                }
            } else {
                fetching = false;
            }
        }

        return Array.from(extractedMessagesMap.values())
            .sort((a, b) => a.timestamp - b.timestamp);
    }

}