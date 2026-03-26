if (!window.waExporterInjected) {
    window.waExporterInjected = true;

    const SELECTORS = {
        scrollContainer: '#main [data-scrolltracepolicy="wa.web.conversation.messages"], #main .copyable-area',
        messageRow: '#main div[role="row"]',
        messageText: '[data-testid="selectable-text"], span.selectable-text, span.copyable-text',
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
                if (child.tagName === 'IMG' && child.alt) {
                    text += child.alt;
                } else {
                    text += extractTextWithEmojis(child);
                }
            }
        }
        return text;
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
        } else {
            console.log("[WA-Exporter] Scroll container found:", scrollContainer);
        }

        let fetching = true;
        let lastSignature = null;
        let stagnateCount = 0;
        let scrollIterations = 0;
        const extractedMessagesMap = new Map();

        while (fetching) {
            scrollIterations++;
            console.log(`[WA-Exporter] --- Scroll Iteration ${scrollIterations} ---`);
            const currentNodes = document.querySelectorAll(SELECTORS.messageRow);
            console.log(`[WA-Exporter] Found ${currentNodes.length} message nodes in DOM.`);

            currentNodes.forEach(node => {
                const timeString = extractTimestampString(node);
                const messageTime = parseWhatsAppTime(timeString);

                if (messageTime > 0 && messageTime >= startTime && messageTime <= endTime) {
                    const allTextElements = Array.from(node.querySelectorAll(SELECTORS.messageText));
                    const validTextElements = allTextElements.filter(el => !el.classList.contains('quoted-mention') && !el.closest('.quoted-mention'));
                    const quotedElement = node.querySelector(SELECTORS.quotedText);

                    let quotedText = "";
                    if (quotedElement) {
                        quotedText = extractTextWithEmojis(quotedElement);
                    }

                    let messageText = "";
                    if (validTextElements.length > 0) {
                        messageText = extractTextWithEmojis(validTextElements[0]);
                    }

                    if (messageText || timeString) {
                        let rawFormat = timeString || `[${new Date(messageTime).toISOString()}] `;

                        if (quotedText) {
                            rawFormat += `[Respondiendo a: "${quotedText}"] `;
                        }
                        rawFormat += messageText;

                        const uniqueKey = `${messageTime}-${rawFormat.substring(0, 50)}`; // Unique enough signature
                        if (!extractedMessagesMap.has(uniqueKey)) {
                            extractedMessagesMap.set(uniqueKey, {
                                timestamp: messageTime,
                                rawFormat: rawFormat.trim()
                            });
                        }
                    }
                }
            });

            if (currentNodes.length > 0) {
                let oldestTime = 0;
                let oldestSignature = "";
                let oldestActualNode = null;
                
                for (const node of currentNodes) {
                    const ts = parseWhatsAppTime(extractTimestampString(node));
                    if (ts > 0) {
                        oldestTime = ts;
                        oldestSignature = ts.toString() + node.textContent.substring(0, 30);
                        oldestActualNode = node;
                        break;
                    }
                }

                console.log(`[WA-Exporter] Oldest message time in DOM: ${new Date(oldestTime).toLocaleString()}`);

                if (oldestTime > 0 && oldestTime <= startTime) {
                    console.log(`[WA-Exporter] Reached or surpassed start time! Stopping fetch.`);
                    fetching = false; 
                    break;
                }

                if (oldestSignature === lastSignature && oldestSignature !== "") {
                    stagnateCount++;
                    console.log(`[WA-Exporter] Stagnation detected (${stagnateCount}/4). Oldest msg hasn't changed.`);
                    if (stagnateCount > 4) {
                        console.log(`[WA-Exporter] Aborting: Hit top of chat. No new messages loading.`);
                        fetching = false; 
                        break;
                    }
                } else {
                    stagnateCount = 0;
                    lastSignature = oldestSignature;
                }

                if (fetching) {
                    console.log(`[WA-Exporter] Executing scroll...`);
                    
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
                console.log(`[WA-Exporter] No messages found in DOM! Aborting.`);
                fetching = false; 
            }
        }

        console.log(`[WA-Exporter] Extraction finished! Gathered ${extractedMessagesMap.size} valid messages.`);
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
        let parsedDate = new Date(cleanedStr);

        if (isNaN(parsedDate.getTime())) {
            const parts = cleanedStr.split(', ');
            if (parts.length === 2) {
                const timePart = parts[0];
                const datePart = parts[1];

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