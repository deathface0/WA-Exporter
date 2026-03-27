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
                if (child.getAttribute('aria-hidden') === 'true') {
                    continue;
                }
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
        const spans = Array.from(node.querySelectorAll('span')).reverse();
        for (let span of spans) {
            const text = span.textContent || span.innerText;
            if (text && /^\d{1,2}:\d{2}(?:\s*(?:AM|PM|am|pm|a\.?\s*m\.|p\.?\s*m\.))?$/.test(text.trim())) {
                return text.trim();
            }
        }
        return null;
    }

    function getClosestValidDateStr(nodes, index) {
        for (let i = index; i < nodes.length; i++) {
            let meta = nodes[i].querySelector(SELECTORS.metadata);
            if (meta) {
                let match = meta.getAttribute('data-pre-plain-text').match(/\[(.*?)\]/);
                if (match && match[1].includes(',')) {
                    let parts = match[1].split(',');
                    return parts[0].includes(':') ? parts[1].trim() : parts[0].trim();
                }
            }
        }
        for (let i = index - 1; i >= 0; i--) {
            let meta = nodes[i].querySelector(SELECTORS.metadata);
            if (meta) {
                let match = meta.getAttribute('data-pre-plain-text').match(/\[(.*?)\]/);
                if (match && match[1].includes(',')) {
                    let parts = match[1].split(',');
                    return parts[0].includes(':') ? parts[1].trim() : parts[0].trim();
                }
            }
        }
        return new Date().toLocaleDateString('en-US');
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
            console.error("[WA-Exporter] Could not find the scroll container! The script cannot scroll.");
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
                    const validTextElements = allTextElements.filter(el => !el.classList.contains('quoted-mention') && !el.closest('.quoted-mention'));
                    const quotedElement = node.querySelector(SELECTORS.quotedText);

                    let quotedText = "";
                    if (quotedElement) {
                        quotedText = extractTextWithEmojis(quotedElement);
                        if (!quotedText.trim()) {
                            const qHtml = quotedElement.innerHTML;
                            if (qHtml.includes('data-icon="image"') || qHtml.includes('<img')) quotedText = "Imagen/Sticker";
                            else if (qHtml.includes('data-icon="video"')) quotedText = "Video";
                            else if (qHtml.includes('data-icon="audio"') || qHtml.includes('Voice message') || qHtml.includes('ptt-status')) quotedText = "Audio / Nota de voz";
                            else if (qHtml.includes('data-icon="gif"')) quotedText = "GIF";
                            else quotedText = "Multimedia";
                        }
                    }

                    let messageText = "";
                    if (validTextElements.length > 0) {
                        messageText = extractTextWithEmojis(validTextElements[0]);
                    }

                    const nodeHtml = node.innerHTML;

                    if (!messageText.trim() || nodeHtml.includes('data-icon="recalled"')) {
                        if (nodeHtml.includes('data-icon="recalled"')) {
                            messageText = "Mensaje eliminado";
                        } else if (nodeHtml.includes('alt="Sticker"') || nodeHtml.includes('alt="sticker"')) {
                            messageText = "[Sticker]";
                        } else if (nodeHtml.includes('aria-label="Voice message"') || nodeHtml.includes('aria-label="Play voice message"') || nodeHtml.includes('data-icon="ptt-status"')) {
                            messageText = "[Audio]";
                        } else if (nodeHtml.includes('data-icon="video"') || node.querySelector('video')) {
                            messageText = "[Video]";
                        } else if (nodeHtml.includes('data-icon="gif"')) {
                            messageText = "[GIF]";
                        } else if (nodeHtml.includes('blob:') || nodeHtml.includes('data:image')) {
                            messageText = "[Imagen]";
                        } else if (nodeHtml.includes('data-icon="document"')) {
                            messageText = "[Archivo]";
                        } else if (nodeHtml.includes('data-icon="contact"')) {
                            messageText = "[Contacto]";
                        } else if (nodeHtml.includes('data-icon="location"')) {
                            messageText = "[Ubicación]";
                        } else {
                            messageText = messageText.trim() ? "Mensaje eliminado" : "[Contenido Multimedia]";
                        }
                    }

                    if (messageText || timeString) {
                        let rawFormat = timeString || `[${new Date(messageTime).toISOString()}] `;

                        if (quotedText) {
                            rawFormat += `[Respondiendo a: "${quotedText}"] `;
                        }

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

        return Array.from(extractedMessagesMap.values()).sort((a, b) => a.timestamp - b.timestamp);
    }

    function extractTimestampString(node) {
        const metadataNode = node.querySelector(SELECTORS.metadata);
        if (metadataNode) {
            return metadataNode.getAttribute('data-pre-plain-text');
        }
        return null;
    }

    function parseWhatsAppTime(timeStr) {
        if (!timeStr) return 0;

        const match = timeStr.match(/\[(.*?)\]/);
        if (!match) return 0;

        let cleanedStr = match[1].trim();
        cleanedStr = cleanedStr.replace(/[\u200E\u200F\u202A-\u202E]/g, '');

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
                        const swappedDate = `${dateParts[1]}/${dateParts[0]}/${dateParts[2]} ${timePart}`;
                        parsedDate = new Date(swappedDate);
                    }
                }
            }
        }

        return isNaN(parsedDate.getTime()) ? 0 : parsedDate.getTime();
    }
}