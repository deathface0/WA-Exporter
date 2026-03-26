if (!window.waExporterInjected) {
    window.waExporterInjected = true;

    const SELECTORS = {
        scrollContainer: '[data-scrolltracepolicy="wa.web.conversation.messages"], #main .copyable-area',
        messageRow: 'div[role="row"]',
        messageText: '[data-testid="selectable-text"], span.selectable-text, span.copyable-text',
        quotedContainer: 'div[aria-label="Quoted message"]',
        quotedMention: '.quoted-mention',
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
            return [];
        }

        let fetching = true;
        let lastOldestTime = null;
        let stagnateCount = 0;

        while (fetching) {
            scrollContainer.scrollBy(0, -1500);
            await new Promise(resolve => setTimeout(resolve, 800));

            const messageNodes = document.querySelectorAll(SELECTORS.messageRow);
            if (messageNodes.length > 0) {
                const oldestNode = messageNodes[0];
                const oldestTimeString = extractTimestampString(oldestNode);
                const oldestTime = parseWhatsAppTime(oldestTimeString);

                if (oldestTime > 0 && oldestTime <= startTime) {
                    fetching = false;
                }

                if (oldestTime === lastOldestTime) {
                    stagnateCount++;
                    if (stagnateCount > 3) fetching = false;
                } else {
                    stagnateCount = 0;
                    lastOldestTime = oldestTime;
                }
            } else {
                fetching = false;
            }
        }

        const allMessageNodes = document.querySelectorAll(SELECTORS.messageRow);
        const extractedData = [];

        allMessageNodes.forEach(node => {
            const timeString = extractTimestampString(node);
            const messageTime = parseWhatsAppTime(timeString);

            const allTextElements = Array.from(node.querySelectorAll(SELECTORS.messageText));
            const validTextElements = allTextElements.filter(el => !el.classList.contains('quoted-mention') && !el.closest('.quoted-mention'));

            const quotedContainer = node.querySelector(SELECTORS.quotedContainer);
            let quotedAuthor = "";
            let quotedText = "";

            if (quotedContainer) {
                const textEl = quotedContainer.querySelector(SELECTORS.quotedMention);
                const authorEl = Array.from(quotedContainer.querySelectorAll('span[dir="auto"]')).find(el => el !== textEl);

                if (authorEl) quotedAuthor = authorEl.textContent;
                if (textEl) quotedText = extractTextWithEmojis(textEl);
            } else {
                const fallbackQuotedText = node.querySelector(SELECTORS.quotedMention);
                if (fallbackQuotedText) {
                    quotedText = extractTextWithEmojis(fallbackQuotedText);
                    quotedAuthor = "Unknown";
                }
            }

            let messageText = "";
            let mediaInfo = "";
            const isDeleted = node.querySelector('[data-icon="recalled"]');

            if (isDeleted) {
                messageText = "[Deleted Message]";
            } else {
                if (validTextElements.length > 0) {
                    messageText = extractTextWithEmojis(validTextElements[0]);
                }

                if (node.querySelector('audio') || node.querySelector('[data-testid="audio-play"]') || node.querySelector('[data-icon="audio-play"]')) {
                    mediaInfo = '[Audio/Voice Message]';
                } else if (node.querySelector('video') || node.querySelector('[data-testid="video-play"]') || node.querySelector('[data-icon="video-play"]')) {
                    mediaInfo = '[Video]';
                } else if (node.querySelector('[data-testid="gif-symbol"]') || node.querySelector('[data-icon="gif"]')) {
                    mediaInfo = '[GIF]';
                } else if (node.querySelector('a[download]') || node.querySelector('[data-testid="document"]') || node.querySelector('[data-icon="document"]')) {
                    let docName = "";
                    const docTitles = node.querySelectorAll('span[dir="ltr"], span[title]');
                    for (let el of docTitles) {
                        if (el.textContent.match(/\.[a-zA-Z0-9]{2,4}$/)) {
                            docName = ": " + el.textContent;
                            break;
                        }
                    }
                    mediaInfo = `[Document${docName}]`;
                } else if (node.querySelector('img[src^="blob:"]') || node.querySelector('img[src^="mediasticker:"]')) {
                    mediaInfo = '[Image/Sticker]';
                }
            }

            if ((messageText || mediaInfo) && messageTime >= startTime && messageTime <= endTime) {
                let rawFormat = timeString || `[${new Date(messageTime).toISOString()}] `;

                if (quotedText && !isDeleted) {
                    rawFormat += `[Replying to ${quotedAuthor}: "${quotedText}"] `;
                }

                if (mediaInfo) {
                    rawFormat += `${mediaInfo} `;
                }

                rawFormat += messageText;

                extractedData.push({
                    timestamp: messageTime,
                    rawFormat: rawFormat.trim()
                });
            }
        });

        return extractedData;
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
                const dateParts = datePart.split(/[\/\-]/);
                if (dateParts.length === 3) {
                    const swappedDate = `${dateParts[1]}/${dateParts[0]}/${dateParts[2]} ${timePart}`;
                    parsedDate = new Date(swappedDate);
                }
            }
        }

        return isNaN(parsedDate.getTime()) ? 0 : parsedDate.getTime();
    }
}