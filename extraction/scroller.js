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

        // Standard numeric date: DD/MM/YYYY or MM/DD/YYYY. Same order as data-pre-plain-text when known.
        const dMatch = text.match(/(\d{1,2})[\/\.-](\d{1,2})[\/\.-](\d{2,4})/);
        const Parsers = window.WAExporter.Parsers;
        if (dMatch && Parsers && Parsers.parseDateString && Parsers.dateFormat && Parsers.dateFormat()) {
            const p = Parsers.parseDateString(dMatch[0]);
            if (p) return new Date(p.year, p.month, p.day);
        }
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

    /**
     * Message rows and date dividers in DOM order. Current builds render dividers as plain
     * children of the message list (div > div > span "8/23/2026" / "Today", no data-testid),
     * so they are taken from the list's children; the old divider selector is kept as fallback.
     */
    function collectRowsAndDividers(main, SELECTORS) {
        const legacy = Array.from(main.querySelectorAll(`${SELECTORS.messageRow}, ${SELECTORS.dateDivider}`));
        legacy.dividers = new WeakSet();
        const firstMsg = main.querySelector('[data-id]');
        let list = null;
        for (let e = firstMsg; e && e !== main; e = e.parentElement) {
            if (e.children.length > 3 && e.querySelectorAll(':scope > * [data-id]').length > 1) { list = e; break; }
        }
        if (!list) return legacy;

        const out = [];
        // Per scan: the virtualized list recycles nodes, so nothing is stored on them.
        out.dividers = new WeakSet();
        for (const child of list.children) {
            const rows = child.querySelectorAll(SELECTORS.messageRow);
            if (rows.length || child.matches(SELECTORS.messageRow)) {
                if (child.matches(SELECTORS.messageRow)) out.push(child);
                rows.forEach(r => out.push(r));
                continue;
            }
            const text = (child.textContent || '').trim();
            if (text && text.length < 40 && parseDateHeader(text)) {
                out.dividers.add(child);
                out.push(child);
            }
        }
        return out.length ? out : legacy;
    }

    /**
     * Visual-order indices for one viewport. known[i] is the index of an already collected row,
     * or null for a new one. New rows go between their known neighbours (fractional if needed),
     * so media rendered late inside known ranges never collide; rows above everything known
     * go below lowestIndex, since the scroller moves up.
     */
    function assignDomIndices(known, lowestIndex) {
        const out = known.slice();
        let i = 0;
        while (i < out.length) {
            if (out[i] !== null && out[i] !== undefined) { i++; continue; }
            let end = i;
            while (end + 1 < out.length && (out[end + 1] === null || out[end + 1] === undefined)) end++;
            const run = end - i + 1;
            const prev = i > 0 ? out[i - 1] : null;
            const next = end + 1 < out.length ? out[end + 1] : null;
            for (let k = 0; k < run; k++) {
                if (prev !== null && next !== null) out[i + k] = prev + (next - prev) * (k + 1) / (run + 1);
                else if (next !== null) out[i + k] = next - (run - k);
                // Below the last known row: the next known one may sit just outside the viewport.
                else if (prev !== null) out[i + k] = prev + (k + 1) * 1e-3;
                else out[i + k] = lowestIndex - (run - k);
            }
            i = end + 1;
        }
        return out;
    }

    function expandGroupedRows(parsedRows) {
        const out = [];
        parsedRows.forEach(item => {
            const grouped = /^grouped-[a-z]+--(.+)$/i.exec(item.parsedMsg.id || '');
            if (!grouped) return out.push(item);
            grouped[1].split('-').filter(Boolean).forEach((id, i) => {
                const msg = i === 0 ? item.parsedMsg : Object.assign({}, item.parsedMsg);
                msg.id = id;
                out.push({ key: createMessageKey(msg), parsedMsg: msg, row: item.row });
            });
        });
        return out;
    }

    function scanVisibleMessages(messageMap, contextState) {
        const SELECTORS = window.WAExporter.SELECTORS;
        const main = document.querySelector('#main');
        if (!main) return;

        // Collect all date headers and message rows in DOM order, filtering out header/footer and nested child elements
        const allElements = collectRowsAndDividers(main, SELECTORS);
        const listedDividers = allElements.dividers;
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

        // Day context comes from this viewport only (date dividers and messages with an exact
        // data-pre-plain-text date). Carrying it over from the previous, newer viewport put
        // undated media days or weeks off while scrolling up.
        const scan = { dividerDate: null, date: null, lastMsg: null };
        const sequence = []; // dividers and parsed messages, in DOM order

        let parsedRows = [];
        rows.forEach(row => {
            // Check if this element IS a date divider or CONTAINS one
            const listed = listedDividers.has(row);
            const isDivider = listed || row.matches(SELECTORS.dateDivider);
            const containsDivider = !isDivider && row.querySelector(SELECTORS.dateDivider);

            if (isDivider || containsDivider) {
                const dividerEl = isDivider ? row : containsDivider;
                const text = dividerEl.textContent.trim();
                const parsed = parseDateHeader(text);
                if (parsed) {
                    scan.dividerDate = parsed;
                    scan.date = parsed;
                    sequence.push({ divider: true });
                }
                if (isDivider && (listed || !row.matches(SELECTORS.messageRow))) {
                    return;
                }
            }

            const msgEl = row.matches(SELECTORS.msgContainer) ? row : (row.querySelector(SELECTORS.msgContainer) || row);
            if (!msgEl) return;

            try {
                const parsedMsg = window.WAExporter.Parsers.parseDOMMessage(
                    msgEl,
                    scan.date || scan.dividerDate,
                    scan.lastMsg,
                    contextState.myName
                );

                if (parsedMsg && ((parsedMsg.content && parsedMsg.content.trim() !== '') || parsedMsg.mediaUrl)) {
                    sequence.push({ msg: parsedMsg });
                    if (parsedMsg.dateSource !== 'guess') {
                        scan.lastMsg = parsedMsg;
                        scan.date = new Date(parsedMsg.timestamp);
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

        // Rows above the first dated one take the day of the next dated message, unless a
        // date divider sits in between (then the day stays unknown until an older viewport).
        sequence.forEach((item, i) => {
            if (!item.msg || item.msg.dateSource !== 'guess') return;
            for (let j = i + 1; j < sequence.length; j++) {
                if (sequence[j].divider) break;
                const next = sequence[j].msg;
                if (next.dateSource !== 'guess') {
                    window.WAExporter.Parsers.restampDay(item.msg, new Date(next.timestamp), 'context');
                    break;
                }
            }
        });

        // Several stickers sent in a row share one bubble (data-id "grouped-sticker--<id1>-<id2>"):
        // export one message per id so they match the WA-JS ids and the real message count.
        parsedRows = expandGroupedRows(parsedRows);

        // Assign DOM sequence indices to preserve visual order across scroll chunks
        const indices = assignDomIndices(
            parsedRows.map(item => (messageMap.has(item.key) ? messageMap.get(item.key).domIndex : null)),
            contextState.lowestIndex
        );

        const rank = window.WAExporter.Parsers.DATE_SOURCE_RANK;
        parsedRows.forEach((item, i) => {
            const known = messageMap.get(item.key);
            // A later viewport may know the day better: update in place (thumbnail captures hold this object).
            if (known && rank[item.parsedMsg.dateSource] > rank[known.dateSource]) {
                known.timestamp = item.parsedMsg.timestamp;
                known.dateSource = item.parsedMsg.dateSource;
                known.rawFormat = item.parsedMsg.rawFormat;
            }
            if (!known) {
                const domIndex = indices[i];
                item.parsedMsg.domIndex = domIndex;
                messageMap.set(item.key, item.parsedMsg);

                if (domIndex < contextState.lowestIndex) contextState.lowestIndex = domIndex;
                if (domIndex > contextState.highestIndex) contextState.highestIndex = domIndex;
            } else if (item.key.startsWith('no_id_')) {
                // A no-ID key collision: this row produced a key already in the map.
                // It may be a harmless overlapping re-scan, or it may be a genuinely
                // distinct message that was collapsed. We cannot distinguish the two
                // without a stable ID, so we count it for the export summary.
                noIdCollisions++;
            }
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

    /**
     * The message list is virtualized: scrollTop = scrollHeight only reaches the end of the
     * loaded chunk. Keep scrolling down until nothing new renders and the view sits at the bottom.
     */
    async function scrollToNewest(container, maxRounds = 40) {
        // Done once the view sits at the bottom and the list height holds for two rounds
        // (unrelated DOM updates, e.g. receipts, must not keep it waiting).
        let stableRounds = 0;
        for (let i = 0; i < maxRounds; i++) {
            if (isAborted) return false;
            const height = container.scrollHeight;
            container.scrollTop = container.scrollHeight;
            container.dispatchEvent(new Event('scroll', { bubbles: true }));
            container.dispatchEvent(new WheelEvent('wheel', { deltaY: 800, bubbles: true }));
            await waitForNewDOMNodes(container, 600);
            await sleep(150);
            const atBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 5;
            stableRounds = atBottom && container.scrollHeight === height ? stableRounds + 1 : 0;
            if (stableRounds >= 2) return true;
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
        // Each tap on "older messages from your phone" asks the phone for history.
        const maxPhoneSyncClicks = Number.isInteger(options.maxPhoneSyncClicks) ? options.maxPhoneSyncClicks : Infinity;
        let phoneSyncClicks = 0;
        const tapPhoneSync = () => {
            if (phoneSyncClicks >= maxPhoneSyncClicks || !checkAndClickLoadOlderMessages()) return false;
            phoneSyncClicks++;
            return true;
        };

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

        // Always start from the newest message: the view may have been left anywhere.
        const atNewest = await scrollToNewest(scrollContainer);
        if (!atNewest) console.warn('[WA-Exporter] Could not confirm the view reached the newest message.');

        // Initial scan
        scanVisibleMessages(messageMap, contextState);
        await sleep(50); // Allow async thumbnail fetches to resolve before scrolling
        lastSize = messageMap.size;
        reportProgress('scrolling');
        console.log(`👀 Initial scan in viewport: %c${messageMap.size} messages found.`, 'color: #25d366;');

        // "Last N": collect a few more than N and rescan once after a pause before stopping, so
        // media rendered late at the top of the last viewport is not skipped (older rows above
        // it would otherwise take its place in the last N).
        const COUNT_MARGIN = 10;
        while (!isAborted) {
            if (mode === 'count' && messageMap.size >= targetCount + COUNT_MARGIN) {
                await sleep(600);
                scanVisibleMessages(messageMap, contextState);
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
                if (tapPhoneSync()) {
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
                        if (tapPhoneSync()) {
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
        resolveGuessedDates(sorted);
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

    /**
     * Days still unknown after scrolling (no dated neighbour in any viewport): take the day of
     * the nearest dated messages in visual order. Same day on both sides: that day. Otherwise
     * the day that keeps the order (time of day after the previous one, or before the next one).
     * messages: sorted by domIndex; updated in place.
     */
    function resolveGuessedDates(messages) {
        const Parsers = window.WAExporter.Parsers;
        const dated = i => messages[i] && messages[i].dateSource !== 'guess';
        const minutes = ts => { const d = new Date(ts); return d.getHours() * 60 + d.getMinutes(); };
        const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

        messages.forEach((m, i) => {
            if (m.dateSource !== 'guess') return;
            let p = i - 1;
            while (p >= 0 && !dated(p)) p--;
            let n = i + 1;
            while (n < messages.length && !dated(n)) n++;
            const prev = p >= 0 ? messages[p] : null;
            const next = n < messages.length ? messages[n] : null;
            if (!prev && !next) return;

            let day;
            if (prev && next && sameDay(prev.timestamp, next.timestamp)) day = prev.timestamp;
            else if (prev && minutes(m.timestamp) >= minutes(prev.timestamp)) day = prev.timestamp;
            else if (next && minutes(m.timestamp) <= minutes(next.timestamp)) day = next.timestamp;
            else day = (prev || next).timestamp;
            Parsers.restampDay(m, new Date(day), 'context');
        });
        return messages;
    }

    function abortExtraction() {
        isAborted = true;
    }

    window.WAExporter.Scroller = {
        startExtraction,
        abortExtraction,
        parseDateHeader,
        resolveGuessedDates,
        expandGroupedRows,
        assignDomIndices
    };
})();
