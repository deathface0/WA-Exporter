(function () {
    'use strict';

    if (typeof browser === 'undefined') {
        window.browser = chrome;
    }

    window.WAExporter = window.WAExporter || {};

    const pad = n => n.toString().padStart(2, '0');

    let isAborted = false;
    let noIdCollisions = 0; // Counts cases where a no-ID key was already in the map

    function createMessageKey(msg) {
        if (msg.id) return msg.id;
        // Without an ID, use a content-based signature for deduplication.
        // This correctly merges overlapping viewport scans of the same message,
        // but will collapse genuinely distinct messages with identical
        // sender + timestamp + content. extractFiberId() in parsers.js
        // recovers IDs for most user messages; this fallback primarily
        // affects system/decorative elements.
        const contentStr = msg.content || msg.caption || msg.systemText || msg.type || '';
        const sig = `${msg.timestamp}_${msg.sender}_${contentStr}`;
        return 'no_id_' + (sig.length > 500 ? sig.substring(0, 500) + '_' + sig.length : sig);
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    const MONTHS = {
        'january': 0, 'jan': 0, 'enero': 0, 'ene': 0,
        'february': 1, 'feb': 1, 'febrero': 1,
        'march': 2, 'mar': 2, 'marzo': 2,
        'april': 3, 'apr': 3, 'abril': 3, 'abr': 3,
        'may': 4, 'mayo': 4,
        'june': 5, 'jun': 5, 'junio': 5,
        'july': 6, 'jul': 6, 'julio': 6,
        'august': 7, 'aug': 7, 'agosto': 7, 'ago': 7,
        'september': 8, 'sep': 8, 'septiembre': 8, 'setiembre': 8,
        'october': 9, 'oct': 9, 'octubre': 9,
        'november': 10, 'nov': 10, 'noviembre': 10,
        'december': 11, 'dec': 11, 'diciembre': 11, 'dic': 11
    };

    const DAYS_OF_WEEK = {
        'sunday': 0, 'domingo': 0,
        'monday': 1, 'lunes': 1,
        'tuesday': 2, 'martes': 2,
        'wednesday': 3, 'miércoles': 3, 'miercoles': 3,
        'thursday': 4, 'jueves': 4,
        'friday': 5, 'viernes': 5,
        'saturday': 6, 'sábado': 6, 'sabado': 6
    };

    function parseDateHeader(text) {
        if (!text) return null;
        text = text.trim().toLowerCase().replace(/[\u200e\u200f\s]+/g, ' ');
        const now = new Date();

        if (text.includes('today') || text.includes('hoy')) {
            return new Date(now.getFullYear(), now.getMonth(), now.getDate());
        }
        if (text.includes('yesterday') || text.includes('ayer')) {
            const y = new Date(now);
            y.setDate(y.getDate() - 1);
            return new Date(y.getFullYear(), y.getMonth(), y.getDate());
        }

        // Relative weekday check
        for (const [dayName, dayIndex] of Object.entries(DAYS_OF_WEEK)) {
            if (text === dayName || text.startsWith(dayName + ' ') || text.endsWith(' ' + dayName)) {
                let diff = now.getDay() - dayIndex;
                if (diff <= 0) diff += 7;
                const d = new Date(now);
                d.setDate(d.getDate() - diff);
                return new Date(d.getFullYear(), d.getMonth(), d.getDate());
            }
        }

        // Date with month name
        const esMatch = text.match(/(\d{1,2})\s*(?:de)?\s*([a-záéíóúñ]+)(?:\s*(?:de)?\s*(\d{2,4}))?/i);
        if (esMatch && MONTHS[esMatch[2].toLowerCase()] !== undefined) {
            const day = parseInt(esMatch[1], 10);
            const month = MONTHS[esMatch[2].toLowerCase()];
            let year = esMatch[3] ? parseInt(esMatch[3], 10) : now.getFullYear();
            if (year < 100) year += 2000;
            return new Date(year, month, day);
        }

        // Standard numeric date: DD/MM/YYYY or MM/DD/YYYY
        const dMatch = text.match(/(\d{1,2})[\/\.-](\d{1,2})[\/\.-](\d{2,4})/);
        if (dMatch) {
            const p1 = parseInt(dMatch[1], 10);
            const p2 = parseInt(dMatch[2], 10);
            let y = parseInt(dMatch[3], 10);
            if (y < 100) y += 2000;

            if (p1 > 12) {
                return new Date(y, p2 - 1, p1);
            } else if (p2 > 12) {
                return new Date(y, p1 - 1, p2);
            } else {
                const lang = (navigator.language || '').toLowerCase();
                if (lang === 'en-us' || lang === 'en') {
                    return new Date(y, p1 - 1, p2); // MDY
                }
                return new Date(y, p2 - 1, p1); // DMY
            }
        }

        const parsed = Date.parse(text);
        if (!isNaN(parsed)) {
            return new Date(parsed);
        }

        return null;
    }

    function scanVisibleMessages(messageMap, contextState) {
        const SELECTORS = window.WAExporter.SELECTORS;
        const main = document.querySelector('#main');
        if (!main) return;

        // Collect all date headers and message rows in DOM order, filtering out header/footer and nested child elements
        const allElements = Array.from(main.querySelectorAll(`${SELECTORS.messageRow}, ${SELECTORS.dateDivider}`));
        const rows = allElements.filter(el => {
            if (el.closest('header, footer, [data-testid="conversation-header"], [data-testid="chat-footer"]')) {
                return false;
            }
            // If it's a message row, ensure it's not nested inside another message row (e.g. inside link preview cards)
            if (el.matches(SELECTORS.messageRow) && el.parentElement && el.parentElement.closest(SELECTORS.messageRow)) {
                return false;
            }
            return true;
        });

        const parsedRows = [];
        rows.forEach(row => {
            // Check if this element IS a date divider or CONTAINS one
            const isDivider = row.matches(SELECTORS.dateDivider);
            const containsDivider = !isDivider && row.querySelector(SELECTORS.dateDivider);

            if (isDivider || containsDivider) {
                const dividerEl = isDivider ? row : containsDivider;
                const text = dividerEl.textContent.trim();
                const parsed = parseDateHeader(text);
                if (parsed) {
                    contextState.dividerDate = parsed;
                    contextState.date = parsed;
                }
                if (isDivider && !row.matches(SELECTORS.messageRow)) {
                    return;
                }
            }

            const msgEl = row.matches(SELECTORS.msgContainer) ? row : (row.querySelector(SELECTORS.msgContainer) || row);
            if (!msgEl) return;

            try {
                const parsedMsg = window.WAExporter.Parsers.parseDOMMessage(
                    msgEl,
                    contextState.dividerDate || contextState.date,
                    contextState.lastMsg,
                    contextState.myName
                );

                if (parsedMsg && ((parsedMsg.content && parsedMsg.content.trim() !== '') || parsedMsg.mediaUrl)) {
                    contextState.lastMsg = parsedMsg;
                    if (parsedMsg.timestamp) {
                        contextState.date = new Date(parsedMsg.timestamp);
                    }

                    if (window.WAExporter.Parsers.isOutgoingMessage(msgEl) && parsedMsg.sender && parsedMsg.sender !== 'Me' && !contextState.myName) {
                        contextState.myName = parsedMsg.sender;
                    }

                    const key = createMessageKey(parsedMsg);
                    parsedRows.push({ key, parsedMsg, row });
                }
            } catch (err) {
                console.warn('[WA-Exporter Scroller] Error parsing DOM message:', err);
            }
        });

        if (parsedRows.length === 0) return;

        // Assign DOM sequence indices to preserve visual order across scroll chunks
        let anchorIndex = contextState.lowestIndex;
        let anchorRowIdx = parsedRows.length;

        for (let i = 0; i < parsedRows.length; i++) {
            if (messageMap.has(parsedRows[i].key)) {
                anchorIndex = messageMap.get(parsedRows[i].key).domIndex;
                anchorRowIdx = i;
                break; // Align with the FIRST known message in this viewport
            }
        }

        let currentDomIndex = anchorIndex - anchorRowIdx;

        parsedRows.forEach(item => {
            if (!messageMap.has(item.key)) {
                item.parsedMsg.domIndex = currentDomIndex;
                messageMap.set(item.key, item.parsedMsg);
                
                if (currentDomIndex < contextState.lowestIndex) contextState.lowestIndex = currentDomIndex;
                if (currentDomIndex > contextState.highestIndex) contextState.highestIndex = currentDomIndex;
            } else if (item.key.startsWith('no_id_')) {
                // A no-ID key collision: this row produced a key already in the map.
                // It may be a harmless overlapping re-scan, or it may be a genuinely
                // distinct message that was collapsed. We cannot distinguish the two
                // without a stable ID, so we count it for the export summary.
                noIdCollisions++;
            }
            currentDomIndex++;
        });
    }

    async function waitForNewDOMNodes(scrollContainer, timeoutMs = 1500) {
        return new Promise(resolve => {
            let timer = null;
            const observer = new MutationObserver(() => {
                if (timer) clearTimeout(timer);
                observer.disconnect();
                resolve(true);
            });

            observer.observe(scrollContainer, { childList: true, subtree: true });

            timer = setTimeout(() => {
                observer.disconnect();
                resolve(false);
            }, timeoutMs);
        });
    }

    function checkAndClickLoadOlderMessages() {
        const main = document.querySelector('#main') || document;
        const buttons = main.querySelectorAll('button');
        for (const btn of buttons) {
            const text = (btn.textContent || '').toLowerCase().trim();
            // Strict: Must match phone history sync banner
            if (
                (text.includes('older messages') && text.includes('phone')) ||
                (text.includes('mensajes más antiguos') && text.includes('teléfono')) ||
                (text.includes('messages plus anciens') && text.includes('téléphone')) ||
                (text.includes('ältere nachrichten') && text.includes('telefon')) ||
                (text.includes('mensagens mais antigas') && text.includes('telemóvel')) ||
                (text.includes('messaggi più vecchi') && text.includes('telefono'))
            ) {
                console.log('[WA-Exporter Scroller] Found phone sync button:', btn);
                try {
                    btn.click();
                    btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
                    btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
                    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                    return true;
                } catch (e) {
                    console.warn('[WA-Exporter Scroller] Failed to click sync button:', e);
                }
            }
        }
        return false;
    }

    function formatDebugDate(ts) {
        if (!ts) return 'N/A';
        const d = new Date(ts);
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }

    async function startExtraction(options = {}) {
        isAborted = false;
        noIdCollisions = 0;
        const startTime = Date.now();
        const mode = options.mode || 'all';
        const targetCount = options.count || 100;
        const startDate = options.start || 0;
        const endDate = options.end || Infinity;

        const messageMap = new Map();
        const contextState = {
            date: null,
            dividerDate: null,
            lastMsg: null,
            myName: null,
            lowestIndex: 0,
            highestIndex: 0
        };

        console.group('%c[WA-Exporter] 🚀 DOM Scroller Extraction Started', 'color: #00a884; font-weight: bold; font-size: 13px;');
        console.log(`📋 Mode: %c${mode.toUpperCase()}`, 'font-weight: bold; color: #128c7e;');
        if (mode === 'date') {
            console.log(`📅 Target Date Range: %c${formatDebugDate(startDate)} %cto %c${formatDebugDate(endDate)}`, 'color: #0288d1; font-weight: bold;', 'color: inherit;', 'color: #0288d1; font-weight: bold;');
        } else if (mode === 'count') {
            console.log(`🔢 Target Count: %c${targetCount} messages`, 'color: #0288d1; font-weight: bold;');
        } else {
            console.log('♾️ Target: All available history');
        }

        const scrollContainer = window.WAExporter.findScrollContainer();
        if (!scrollContainer) {
            console.error('[WA-Exporter] ❌ Could not find WhatsApp Web chat scroll container.');
            console.groupEnd();
            throw new Error('Could not find WhatsApp Web chat scroll container.');
        }

        let consecutiveNoNewMessages = 0;
        const maxRetries = 10;
        let lastSize = 0;
        let stopReason = 'Unknown';

        function reportProgress(phase = 'scrolling') {
            if (window.WAExporter && window.WAExporter.State) {
                window.WAExporter.State.progress = {
                    count: messageMap.size,
                    mode: mode,
                    target: mode === 'count' ? targetCount : null,
                    phase: phase,
                    source: 'dom'
                };
            }

            try {
                browser.runtime.sendMessage({
                    type: 'extraction_progress',
                    count: messageMap.size,
                    mode: mode,
                    target: mode === 'count' ? targetCount : null,
                    phase: phase,
                    source: 'dom'
                }).catch(() => { });
            } catch (e) { }
        }

        // Initial scan
        scanVisibleMessages(messageMap, contextState);
        await sleep(50); // Allow async thumbnail fetches to resolve before scrolling
        lastSize = messageMap.size;
        reportProgress('scrolling');
        console.log(`👀 Initial scan in viewport: %c${messageMap.size} messages found.`, 'color: #25d366;');

        while (!isAborted) {
            if (mode === 'count' && messageMap.size >= targetCount) {
                stopReason = `Target count reached (${messageMap.size} >= ${targetCount})`;
                break;
            }

            if (mode === 'date') {
                const validMsgs = Array.from(messageMap.values()).filter(m => m.timestamp && typeof m.timestamp === 'number' && m.timestamp > 946684800000);
                const earliestMsg = validMsgs.reduce((earliest, msg) => {
                    return (!earliest || msg.timestamp < earliest.timestamp) ? msg : earliest;
                }, null);

                if (earliestMsg && earliestMsg.timestamp <= startDate) {
                    stopReason = `Earliest message (${formatDebugDate(earliestMsg.timestamp)}) reached target start date (${formatDebugDate(startDate)})`;
                    break;
                }
            }

            if (scrollContainer.scrollTop <= 20) {
                if (checkAndClickLoadOlderMessages()) {
                    console.log('%c[WA-Exporter] 📱 Phone sync button detected & clicked! Waiting for older batch from phone...', 'color: #0288d1; font-weight: bold;');
                    reportProgress('syncing_phone');
                    await sleep(2500);
                    await waitForNewDOMNodes(scrollContainer, 5000);
                    consecutiveNoNewMessages = 0;
                    scanVisibleMessages(messageMap, contextState);
                    if (messageMap.size > lastSize) {
                        const added = messageMap.size - lastSize;
                        lastSize = messageMap.size;
                        console.log(`[WA-Exporter] 📥 Phone sync loaded +${added} older messages (Total in memory: ${messageMap.size})`);
                        reportProgress('scrolling');
                    }
                    continue;
                }

                scrollContainer.scrollTop = 160;
                scrollContainer.dispatchEvent(new Event('scroll', { bubbles: true }));
                await sleep(150);
                scrollContainer.scrollTop = 0;
                scrollContainer.dispatchEvent(new Event('scroll', { bubbles: true }));
                scrollContainer.dispatchEvent(new WheelEvent('wheel', { deltaY: -800, bubbles: true }));

                // Wait generously for WhatsApp to query and render the next batch
                await waitForNewDOMNodes(scrollContainer, 2500);
                await sleep(450);

                scanVisibleMessages(messageMap, contextState);

                if (messageMap.size > lastSize) {
                    const added = messageMap.size - lastSize;
                    lastSize = messageMap.size;
                    consecutiveNoNewMessages = 0;
                    const earliestMsg = Array.from(messageMap.values()).reduce((earliest, msg) => (!earliest || msg.timestamp < earliest.timestamp) ? msg : earliest, null);
                    console.log(`[WA-Exporter] ⏫ Top reached: Loaded +${added} messages. Total: ${messageMap.size} | Earliest: ${formatDebugDate(earliestMsg?.timestamp)}`);
                    reportProgress('scrolling');
                    continue;
                } else {
                    consecutiveNoNewMessages++;
                    console.warn(`[WA-Exporter] ⏳ Waiting at top of viewport (attempt ${consecutiveNoNewMessages}/${maxRetries}) for WhatsApp to render older chunk...`);
                    if (consecutiveNoNewMessages >= maxRetries) {
                        // Final check before terminating
                        if (checkAndClickLoadOlderMessages()) {
                            console.log('%c[WA-Exporter] 📱 Phone sync button clicked on final retry! Waiting...', 'color: #0288d1;');
                            reportProgress('syncing_phone');
                            await sleep(2500);
                            await waitForNewDOMNodes(scrollContainer, 5000);
                            consecutiveNoNewMessages = 0;
                            scanVisibleMessages(messageMap, contextState);
                            continue;
                        }
                        stopReason = `Reached top of chat history (no new messages after ${maxRetries} attempts at scrollTop=0)`;
                        break;
                    }
                    continue;
                }
            }

            scrollContainer.scrollTop = Math.max(0, scrollContainer.scrollTop - 750);
            scrollContainer.dispatchEvent(new Event('scroll', { bubbles: true }));
            scrollContainer.dispatchEvent(new WheelEvent('wheel', { deltaY: -750, bubbles: true }));

            await waitForNewDOMNodes(scrollContainer, 1000);
            await sleep(200);

            scanVisibleMessages(messageMap, contextState);

            if (messageMap.size > lastSize) {
                lastSize = messageMap.size;
                consecutiveNoNewMessages = 0;
                reportProgress('scrolling');
            } else {
                consecutiveNoNewMessages++;
                if (consecutiveNoNewMessages >= maxRetries && scrollContainer.scrollTop <= 20) {
                    stopReason = `Reached top of chat history (scrollTop <= 20)`;
                    break;
                }
            }
        }
            if (isAborted) {
            stopReason = 'Extraction was cancelled by the user';
        }

        // Filter and sort messages by DOM visual order
        let sorted = Array.from(messageMap.values()).sort((a, b) => {
            if (typeof a.domIndex === 'number' && typeof b.domIndex === 'number') {
                return a.domIndex - b.domIndex;
            }
            return a.timestamp - b.timestamp;
        });
        const totalScanned = sorted.length;

        if (mode === 'date') {
            sorted = sorted.filter(m => m.timestamp >= startDate && m.timestamp <= endDate);
        } else if (mode === 'count') {
            if (sorted.length > targetCount) {
                sorted = sorted.slice(sorted.length - targetCount);
            }
        }

        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        const earliestFinal = sorted.length ? sorted[0] : null;
        const latestFinal = sorted.length ? sorted[sorted.length - 1] : null;

        console.log(`%c[WA-Exporter] 🏁 Extraction Stopped: %c${stopReason}`, 'color: #00a884; font-weight: bold;', 'color: #d32f2f; font-weight: bold;');
        console.table({
            'Reason Stopped': stopReason,
            'Total Messages Scanned': totalScanned,
            'Exported (After Filter)': sorted.length,
            'Earliest Exported Date': earliestFinal ? formatDebugDate(earliestFinal.timestamp) : 'None',
            'Latest Exported Date': latestFinal ? formatDebugDate(latestFinal.timestamp) : 'None',
            'Duration': `${duration}s`
        });
        console.groupEnd();

        let isPartial = isAborted;
        if (mode === 'count' && sorted.length < targetCount) isPartial = true;
        if (mode === 'date') {
            // Check if we actually reached the requested start date bounds
            const earliestScanned = Array.from(messageMap.values()).reduce((earliest, msg) => (!earliest || msg.timestamp < earliest.timestamp) ? msg : earliest, null);
            if (!earliestScanned || earliestScanned.timestamp > startDate) {
                // We stopped before reaching the target date (e.g. max retries or chat actually ended earlier than expected).
                // We must expose this coverage as partial/unknown to avoid false claims of completeness.
                isPartial = true;
            }
        }
        
        return {
            messages: sorted,
            isPartial: isPartial,
            noIdCollisions: noIdCollisions,
            source: 'dom',
            stopReason
        };
    }

    function abortExtraction() {
        isAborted = true;
    }

    window.WAExporter.Scroller = {
        startExtraction,
        abortExtraction,
        parseDateHeader
    };
})();
