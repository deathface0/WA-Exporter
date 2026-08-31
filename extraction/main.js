(function () {
    'use strict';

    if (typeof browser === 'undefined') {
        window.browser = chrome;
    }

    window.WAExporter = window.WAExporter || {};

    // Persistent extraction state surviving popup closes
    window.WAExporter.State = window.WAExporter.State || {
        status: 'idle', // 'idle' | 'extracting' | 'completed' | 'error'
        request: null,
        progress: { count: 0, phase: 'idle', source: 'database' },
        result: null,
        error: null,
        startedAt: null,
        completedAt: null
    };

    let activeExtractionPromise = null;

    if (window.__waMainListenerAttached) return;
    window.__waMainListenerAttached = true;

    function broadcastProgress(count, phase, source) {
        try {
            browser.runtime.sendMessage({
                type: 'extraction_progress',
                count: count,
                phase: phase,
                source: source
            }).catch(() => { });
        } catch (e) { }
    }

    function broadcastCompleted(result) {
        try {
            browser.runtime.sendMessage({
                type: 'extraction_completed',
                result: result
            }).catch(() => { });
        } catch (e) { }
    }

    function broadcastError(errorMessage) {
        try {
            browser.runtime.sendMessage({
                type: 'extraction_error',
                error: errorMessage
            }).catch(() => { });
        } catch (e) { }
    }

    function isIconOrNoiseText(text) {
        if (!text) return true;
        const lower = text.toLowerCase().trim();
        return /^(?:ic-|wds-|tail-|default-|avatar|menu|search|more|status|document|multi-select|checkbox|icon)/i.test(lower) ||
            /^(?:online|en línea|typing|escribiendo|recording audio|grabando audio|click here for group info|haz clic aquí para ver la información del grupo|group info|info\. del grupo)$/i.test(lower);
    }

    function getActiveChatTitle() {
        const header = document.querySelector('#main header, header[data-testid="conversation-header"]');
        if (!header) return null;

        // 1. Try explicit testid or title element
        const explicitTitle = header.querySelector('[data-testid="conversation-info-header-chat-title"]');
        if (explicitTitle && explicitTitle.textContent.trim()) {
            const t = explicitTitle.textContent.trim();
            if (!isIconOrNoiseText(t)) return t;
        }

        // 2. Clone header, remove icons, svgs, avatars, buttons
        const clone = header.cloneNode(true);
        clone.querySelectorAll('svg, [data-icon], img, [data-testid="menu"], [data-testid="search"]').forEach(el => el.remove());

        const titleSpans = Array.from(clone.querySelectorAll('span[dir="auto"], div[dir="auto"], h1, h2, h3, div[role="button"] span'))
            .map(el => el.textContent.trim())
            .filter(t => t && !isIconOrNoiseText(t));

        if (titleSpans.length > 0) {
            return titleSpans[0];
        }

        return null;
    }

    window.WAExporter.getActiveChatTitle = getActiveChatTitle;
    window.WAExporter.isIconOrNoiseText = isIconOrNoiseText;

    async function handleGetChatInfo() {
        const domTitle = getActiveChatTitle();

        let resolvedName = domTitle;
        let resolvedId = domTitle;
        let msgCount = 0;
        let source = 'dom';

        // 1. Try IndexedDB first (fastest and most accurate)
        if (window.WAExporter && window.WAExporter.queryDB) {
            try {
                const idbResult = await window.WAExporter.queryDB('count', {}, 500);
                if (idbResult && idbResult.chatId) {
                    resolvedName = domTitle || idbResult.chatName || (idbResult.chatId.includes('@') ? idbResult.chatId.split('@')[0] : idbResult.chatId);
                    resolvedId = idbResult.chatId;
                    msgCount = idbResult.count || 0;
                    source = 'database';
                }
            } catch (e) {
                console.warn('[WA-Exporter] IDB chat info query failed, trying DOM fallback:', e.message);
            }
        }

        // 2. DOM fallback
        if (source === 'dom' && domTitle) {
            const selectors = window.WAExporter.SELECTORS || {};
            const visibleRows = document.querySelectorAll(selectors.messageRow || 'div.message-in, div.message-out, div[role="row"]');
            resolvedName = domTitle;
            resolvedId = domTitle;
            msgCount = visibleRows.length;
            source = 'dom';
        }

        if (!resolvedName) {
            return { chatName: null, chatId: null, totalMessages: 0, error: 'Please open a chat in WhatsApp Web.' };
        }

        // If chat changed while idle/completed, reset extraction state to prevent cross-chat cache leaks
        if (window.WAExporter.State.chatName && window.WAExporter.State.chatName !== resolvedName) {
            if (window.WAExporter.State.status !== 'extracting') {
                window.WAExporter.State.status = 'idle';
                window.WAExporter.State.result = null;
                window.WAExporter.State.request = null;
                window.WAExporter.State.error = null;
                window.WAExporter.State.progress = { count: 0, phase: 'idle', source: 'database' };
            }
        }

        window.WAExporter.State.chatName = resolvedName;
        window.WAExporter.State.chatId = resolvedId;

        return {
            chatName: resolvedName,
            chatId: resolvedId,
            totalMessages: msgCount,
            source: source
        };
    }

    async function handleExtractChat(request) {
        // If an extraction is already running, attach to it
        if (window.WAExporter.State.status === 'extracting' && activeExtractionPromise) {
            return activeExtractionPromise;
        }

        const currentTitle = getActiveChatTitle();
        window.WAExporter.State.chatName = currentTitle || window.WAExporter.State.chatName;
        window.WAExporter.State.status = 'extracting';
        window.WAExporter.State.request = request;
        window.WAExporter.State.progress = { count: 0, phase: 'starting', source: 'database' };
        window.WAExporter.State.result = null;
        window.WAExporter.State.error = null;
        window.WAExporter.State.startedAt = Date.now();

        activeExtractionPromise = (async () => {
            try {
                // 1. Primary Strategy: IndexedDB (Only accept if it completely satisfies the request)
                if (window.WAExporter && window.WAExporter.queryDB) {
                    try {
                        console.log('[WA-Exporter] Checking IndexedDB cache...');
                        window.WAExporter.State.progress = { count: 0, phase: 'reading_database', source: 'database' };
                        broadcastProgress(0, 'reading_database', 'database');

                        const idbMessages = await window.WAExporter.queryDB('extract', request, 600);

                        if (Array.isArray(idbMessages) && idbMessages.length > 0) {
                            let isComplete = false;
                            if (request.mode === 'count') {
                                isComplete = idbMessages.length >= (request.count || 100);
                            } else if (request.mode === 'date' && request.start) {
                                const earliest = idbMessages.reduce((min, m) => (!min || m.timestamp < min.timestamp) ? m : min, null);
                                isComplete = earliest && earliest.timestamp <= request.start;
                            }

                            if (isComplete) {
                                console.log(`[WA-Exporter] IndexedDB completely satisfied request (${idbMessages.length} messages).`);
                                const res = {
                                    data: idbMessages,
                                    source: 'database',
                                    isPartial: false
                                };
                                window.WAExporter.State.status = 'completed';
                                window.WAExporter.State.result = res;
                                window.WAExporter.State.completedAt = Date.now();
                                broadcastCompleted(res);
                                handleBackgroundAutoAction(res, request);
                                return res;
                            }
                            console.log(`[WA-Exporter] IndexedDB returned only ${idbMessages.length} cached messages (incomplete for ${request.mode} mode). Falling back to DOM scrolling...`);
                        }
                    } catch (err) {
                        console.warn('[WA-Exporter] IndexedDB query skipped, using DOM scrolling:', err.message);
                    }
                }

                // 2. Fallback Strategy: Progressive DOM Scrolling
                if (window.WAExporter && window.WAExporter.Scroller) {
                    console.log('[WA-Exporter] Starting fallback DOM scroll extraction...');
                    window.WAExporter.State.progress = { count: 0, phase: 'scrolling', source: 'dom' };
                    broadcastProgress(0, 'scrolling', 'dom');

                    const scrollResult = await window.WAExporter.Scroller.startExtraction(request);
                    const res = {
                        data: scrollResult.messages || [],
                        source: 'dom',
                        isPartial: !!scrollResult.isPartial
                    };
                    window.WAExporter.State.status = 'completed';
                    window.WAExporter.State.result = res;
                    window.WAExporter.State.completedAt = Date.now();
                    broadcastCompleted(res);
                    handleBackgroundAutoAction(res, request);
                    return res;
                }

                throw new Error('Neither IndexedDB nor DOM scroller available.');
            } catch (error) {
                window.WAExporter.State.status = 'error';
                window.WAExporter.State.error = error.message;
                window.WAExporter.State.completedAt = Date.now();
                broadcastError(error.message);
                throw error;
            } finally {
                activeExtractionPromise = null;
            }
        })();

        return activeExtractionPromise;
    }

    /* ── In-Page Auto Action Handlers & Toast Notifications ── */

    function pad(n) {
        return String(n).padStart(2, '0');
    }

    function buildExportMetadata(messages, params = {}, chatTitle = 'WhatsApp Chat') {
        const now = new Date();
        const exportDateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

        const mode = params.mode || 'all';
        let scopeStr = 'All Messages';
        if (mode === 'date') {
            const s = params.startTime;
            const e = params.endTime;
            const sFmt = s ? new Date(s).toLocaleString() : 'Start';
            const eFmt = e ? new Date(e).toLocaleString() : 'End';
            scopeStr = `Date Range (${sFmt} to ${eFmt})`;
        } else if (mode === 'count') {
            const count = params.count || params.messageCount || messages.length;
            scopeStr = `Last ${count} Messages`;
        } else {
            scopeStr = `All Messages (${messages.length.toLocaleString()})`;
        }

        return {
            chatName: chatTitle || 'WhatsApp Chat',
            exportDate: exportDateStr,
            exportTimestamp: now.getTime(),
            scope: mode,
            scopeLabel: scopeStr,
            totalMessages: messages.length
        };
    }

    function formatAsTxt(messages, meta) {
        const valid = (messages || []).filter(m => (m.content && m.content.trim() !== '') || m.mediaUrl);
        const header = [
            '==================================================',
            `  WhatsApp Chat Export: ${meta.chatName}`,
            `  Exported On: ${meta.exportDate}`,
            `  Scope: ${meta.scopeLabel}`,
            `  Total Messages: ${valid.length.toLocaleString()}`,
            '==================================================',
            '',
            ''
        ].join('\n');

        const body = valid.map(m => m.rawFormat || `[${new Date(m.timestamp).toLocaleTimeString()}] ${m.sender}: ${m.content}`).join('\n');
        return header + body;
    }

    function formatAsJson(messages, meta) {
        const valid = (messages || []).filter(m => (m.content && m.content.trim() !== '') || m.mediaUrl);
        return JSON.stringify({
            metadata: {
                chatName: meta.chatName,
                exportedAt: meta.exportDate,
                exportTimestamp: meta.exportTimestamp,
                scope: meta.scope,
                scopeLabel: meta.scopeLabel,
                totalMessages: valid.length
            },
            messages: valid
        }, null, 2);
    }

    function escapeCsvCell(val) {
        if (val === null || val === undefined) return '""';
        const str = String(val).replace(/"/g, '""');
        return `"${str}"`;
    }

    function formatAsCsv(messages, meta) {
        const valid = (messages || []).filter(m => (m.content && m.content.trim() !== '') || m.mediaUrl);
        const metaComments = [
            `# WhatsApp Chat Export: ${meta.chatName}`,
            `# Exported On: ${meta.exportDate}`,
            `# Scope: ${meta.scopeLabel} | Total Messages: ${valid.length}`
        ];

        const headers = ['Timestamp', 'Date', 'Time', 'Sender', 'Type', 'Content', 'QuotedSender', 'QuotedContent', 'MediaURL'];
        const rows = valid.map(m => {
            const d = new Date(m.timestamp);
            const dateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
            const timeStr = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
            const quotedSender = m.quotedMessage?.sender || '';
            const quotedContent = m.quotedMessage?.content || '';

            return [
                escapeCsvCell(m.timestamp),
                escapeCsvCell(dateStr),
                escapeCsvCell(timeStr),
                escapeCsvCell(m.sender),
                escapeCsvCell(m.type),
                escapeCsvCell(m.content),
                escapeCsvCell(quotedSender),
                escapeCsvCell(quotedContent),
                escapeCsvCell(m.mediaUrl || '')
            ].join(',');
        });

        return [...metaComments, headers.join(','), ...rows].join('\r\n');
    }

    function formatMessages(messages, format, params, chatTitle) {
        const meta = buildExportMetadata(messages, params, chatTitle);
        switch (format) {
            case 'json':
                return { text: formatAsJson(messages, meta), mime: 'application/json', ext: 'json' };
            case 'csv':
                return { text: formatAsCsv(messages, meta), mime: 'text/csv;charset=utf-8;', ext: 'csv' };
            case 'txt':
            default:
                return { text: formatAsTxt(messages, meta), mime: 'text/plain;charset=utf-8;', ext: 'txt' };
        }
    }

    function generateFilename(chatTitle, params = {}, ext = 'txt') {
        const cleanTitle = (chatTitle || 'chat').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 25) || 'chat';
        const ts = Date.now();
        const mode = params.mode || 'all';

        if (mode === 'date') {
            const start = params.start ? new Date(params.start).toISOString().split('T')[0] : 'start';
            const end = params.end ? new Date(params.end).toISOString().split('T')[0] : 'end';
            return `WA_${cleanTitle}_${start}_to_${end}_${ts}.${ext}`;
        } else if (mode === 'count') {
            const count = params.count || params.messageCount || 'count';
            return `WA_${cleanTitle}_${count}msgs_${ts}.${ext}`;
        }
        return `WA_${cleanTitle}_all_${ts}.${ext}`;
    }

    async function copyToClipboard(text) {
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(text);
                return true;
            }
        } catch (e) { }
        try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.top = '-9999px';
            ta.style.left = '-9999px';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.focus();
            ta.select();
            const ok = document.execCommand('copy');
            ta.remove();
            return ok;
        } catch (e) {
            return false;
        }
    }

    function triggerDownload(filename, text, mime) {
        try {
            const blob = new Blob([text], { type: mime });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            setTimeout(() => {
                a.remove();
                URL.revokeObjectURL(url);
            }, 1000);
        } catch (e) {
            console.warn('[WA-Exporter] Download failed:', e);
        }
    }

    function showToast(message, isError = false) {
        try {
            const existing = document.getElementById('wa-exporter-toast');
            if (existing) existing.remove();

            const toast = document.createElement('div');
            toast.id = 'wa-exporter-toast';
            toast.textContent = message;
            Object.assign(toast.style, {
                position: 'fixed',
                top: '20px',
                left: '50%',
                transform: 'translateX(-50%)',
                background: isError ? 'linear-gradient(135deg, #ea0038, #b8002a)' : 'linear-gradient(135deg, #00a884, #008f6f)',
                color: '#ffffff',
                padding: '12px 24px',
                borderRadius: '24px',
                boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
                zIndex: '9999999',
                fontFamily: 'Segoe UI, Helvetica Neue, Arial, sans-serif',
                fontSize: '14px',
                fontWeight: '600',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                pointerEvents: 'none',
                opacity: '0',
                transform: 'translate(-50%, -20px)',
                transition: 'all 0.3s cubic-bezier(0.16, 1, 0.3, 1)'
            });

            document.body.appendChild(toast);
            requestAnimationFrame(() => {
                toast.style.opacity = '1';
                toast.style.transform = 'translate(-50%, 0)';
            });

            setTimeout(() => {
                toast.style.opacity = '0';
                toast.style.transform = 'translate(-50%, -20px)';
                setTimeout(() => toast.remove(), 400);
            }, 4500);
        } catch (e) { }
    }

    function handleBackgroundAutoAction(res, request) {
        if (!res || !res.data || !res.data.length || !request) return;

        const intent = request.intent;
        const format = request.format || 'txt';
        const chatTitle = window.WAExporter.State.chatName || 'WhatsApp Chat';

        if (intent === 'download') {
            const formatted = formatMessages(res.data, format, request, chatTitle);
            const filename = generateFilename(chatTitle, request, formatted.ext);
            triggerDownload(filename, formatted.text, formatted.mime);
            showToast(`📥 Export complete! Downloaded ${res.data.length.toLocaleString()} messages.`);
        } else if (intent === 'copy') {
            const formatted = formatMessages(res.data, format, request, chatTitle);
            copyToClipboard(formatted.text).then(ok => {
                if (ok) {
                    showToast(`📋 Export complete! Copied ${res.data.length.toLocaleString()} messages to clipboard.`);
                } else {
                    showToast(`📋 Export complete (${res.data.length.toLocaleString()} messages ready in popup).`);
                }
            });
        }
    }

    browser.runtime.onMessage.addListener((request, _sender, sendResponse) => {
        if (request.action === 'get_chat_info') {
            handleGetChatInfo()
                .then(res => sendResponse(res))
                .catch(err => sendResponse({ chatId: null, totalMessages: 0, error: err.message }));
            return true;
        }

        if (request.action === 'get_extraction_state') {
            sendResponse({ state: window.WAExporter.State });
            return false;
        }

        if (request.action === 'clear_extraction_state') {
            window.WAExporter.State = {
                status: 'idle',
                request: null,
                progress: { count: 0, phase: 'idle', source: 'database' },
                result: null,
                error: null,
                startedAt: null,
                completedAt: null
            };
            sendResponse({ status: 'cleared' });
            return false;
        }

        if (request.action === 'extract_chat') {
            handleExtractChat(request)
                .then(res => sendResponse(res))
                .catch(err => sendResponse({ data: null, error: err.message }));
            return true;
        }

        if (request.action === 'cancel_extraction') {
            if (window.WAExporter && window.WAExporter.Scroller) {
                window.WAExporter.Scroller.abort();
            }
            sendResponse({ status: 'aborted' });
            return false;
        }
    });
})();
