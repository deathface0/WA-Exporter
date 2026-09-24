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

    function broadcastProgress(count, phase, source, extra = {}) {
        try {
            browser.runtime.sendMessage({
                type: 'extraction_progress',
                count: count,
                phase: phase,
                source: source,
                ...extra
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
        
        if (window.WAExporter.State.abortController) {
            window.WAExporter.State.abortController.abort();
        }
        window.WAExporter.State.abortController = new AbortController();
        // removed request.signal to prevent serialization issues
        
window.WAExporter.State.chatName = currentTitle || window.WAExporter.State.chatName;
        window.WAExporter.State.status = 'extracting';
        window.WAExporter.State.request = Object.assign({}, request);
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

                        let idbMessages = [];
                        let idbEarliest = null;
                        try {
                            const dbRes = await window.WAExporter.queryDB('extract', request, 600);
                            if (dbRes && Array.isArray(dbRes.data)) {
                                idbMessages = dbRes.data;
                                idbEarliest = dbRes.earliestAvailable;
                            } else if (Array.isArray(dbRes)) {
                                idbMessages = dbRes;
                            }
                        } catch (err) {
                            console.warn('[WA-Exporter] IndexedDB query failed:', err.message);
                        }

                        let isComplete = false;
                        if (Array.isArray(idbMessages) && idbMessages.length > 0) {
                            if (request.mode === 'count') {
                                isComplete = idbMessages.length >= (request.count || 100);
                            } else if (request.mode === 'date' && request.start) {
                                // We cannot prove contiguous cache coverage from IDB alone.
                                // We must either merge with DOM (isComplete = false) or mark it partial.
                                // We will force the DOM scroller to verify completeness by setting isComplete = false.
                                isComplete = false;
                            }
                        }

                        if (isComplete && Array.isArray(idbMessages) && idbMessages.length > 0) {
                            console.log(`[WA-Exporter] IndexedDB completely satisfied request (${idbMessages.length} messages).`);
                            const processedMessages = await runMediaAndAiPipeline(idbMessages, request);
                            if (window.WAExporter.State.abortController && window.WAExporter.State.abortController.signal.aborted) throw new Error("Aborted");
                            const res = {
                                data: processedMessages,
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

                        console.log(`[WA-Exporter] IndexedDB returned only ${idbMessages.length} cached messages. Incomplete or unsupported mode. Running DOM Scroller to merge...`);
                        
                        if (window.WAExporter && window.WAExporter.Scroller) {
                            window.WAExporter.State.progress = { count: idbMessages.length, phase: 'scrolling', source: 'dom' };
                            broadcastProgress(idbMessages.length, 'scrolling', 'dom');

                            const scrollResult = await window.WAExporter.Scroller.startExtraction(request);
                            const domMessages = scrollResult.messages || [];
                            
                            // Merge by ID, keeping unique items safely
                            const mergedMap = new Map();
                            let fallbackIdCounter = 0;
                            const getSig = (m) => m.id ? m.id : `no_id_${fallbackIdCounter++}_${m.timestamp}`;
                            
                            // Insert IDB messages first
                            idbMessages.forEach(m => {
                                mergedMap.set(getSig(m), m);
                            });
                            // Override/merge with DOM messages (they might have better thumbnails/current state)
                            domMessages.forEach(m => {
                                // If we don't have an ID, we don't overwrite IDB messages, we just append them.
                                mergedMap.set(getSig(m), m);
                            });

                            let merged = Array.from(mergedMap.values());
                            
                            // Preserve domIndex sorting for ties
                            merged.sort((a, b) => {
                                if (a.timestamp !== b.timestamp) {
                                    return a.timestamp - b.timestamp;
                                }
                                if (typeof a.domIndex === 'number' && typeof b.domIndex === 'number') {
                                    return a.domIndex - b.domIndex;
                                }
                                return 0;
                            });

                            // Re-apply filters on merged data
                            if (request.mode === 'date') {
                                const start = request.start || 0;
                                const end = request.end || Infinity;
                                merged = merged.filter(m => m.timestamp >= start && m.timestamp <= end);
                            } else if (request.mode === 'count') {
                                const count = request.count || 100;
                                if (merged.length > count) {
                                    merged = merged.slice(-count);
                                }
                            }

                            const processedMessages = await runMediaAndAiPipeline(merged, request);
                            if (window.WAExporter.State.abortController && window.WAExporter.State.abortController.signal.aborted) throw new Error("Aborted");
                            const res = {
                                data: processedMessages,
                                source: 'merged',
                                isPartial: !!scrollResult.isPartial
                            };
                            window.WAExporter.State.status = 'completed';
                            window.WAExporter.State.result = res;
                            window.WAExporter.State.completedAt = Date.now();
                            broadcastCompleted(res);
                            handleBackgroundAutoAction(res, request);
                            return res;
                        }

                    } catch (err) {
                        console.warn('[WA-Exporter] Orchestrator error:', err.message);
                        throw err;
                    }
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

    /**
     * Post-processing pipeline: captures thumbnails from RAM blob URLs and optionally runs Gemini AI captioning.
     */
    async function runMediaAndAiPipeline(messages, request) {
        const signal = window.WAExporter.State.abortController ? window.WAExporter.State.abortController.signal : null;
        if (signal && signal.aborted) throw new Error("Aborted");
        if (!Array.isArray(messages) || messages.length === 0) return messages;

        const shouldCaptureThumbnails = request && request.captureThumbnails !== false;
        const shouldRunAi = request && request.enableAiCaptions && request.geminiApiKey && window.WAExporter.Gemini;

        // 1. Thumbnail Capture Pipeline (needed for thumbnail export or AI vision captioning)
        if (shouldCaptureThumbnails || shouldRunAi) {
            // Count how many were already captured eagerly by parsers (inline canvas or async fetch)
            const earlyCaptured = messages.filter(m => m && m.thumbnail && ['image', 'video', 'gif', 'sticker'].includes(m.type)).length;

            const mediaItems = [];
            messages.forEach((m, idx) => {
                if (m && m.blobUrl && ['image', 'video', 'gif', 'sticker'].includes(m.type) && !m.thumbnail) {
                    mediaItems.push({ key: idx, blobUrl: m.blobUrl });
                }
            });

            if (mediaItems.length > 0) {
                console.log(`[WA-Exporter] 🖼️ ${earlyCaptured} thumbnails captured eagerly. Late-capturing ${mediaItems.length} remaining...`);
                broadcastProgress(mediaItems.length, 'capturing_thumbnails', 'dom');

                const maxSize = parseInt(request.thumbnailSize, 10) || 160;

                await Promise.all(mediaItems.map(async (item) => {
                    if (signal && signal.aborted) return;
                    const m = messages[item.key];
                    if (m && !m.thumbnail && item.blobUrl) {
                        try {
                            // Try fetch first (works even if Image() constructor would fail on revoked URLs)
                            const blob = await fetch(item.blobUrl).then(r => r.blob());
                            const localUrl = URL.createObjectURL(blob);
                            try {
                                const dataUri = await renderCanvasThumbnail(localUrl, maxSize);
                                if (dataUri) m.thumbnail = dataUri;
                            } finally {
                                URL.revokeObjectURL(localUrl);
                            }
                        } catch (fetchErr) {
                            // fetch failed (blob revoked), try direct Image as last resort
                            try {
                                const dataUri = await renderCanvasThumbnail(item.blobUrl, maxSize);
                                if (dataUri) m.thumbnail = dataUri;
                            } catch (err) { }
                        }
                    }
                }));
            } else if (earlyCaptured > 0) {
                console.log(`[WA-Exporter] 🖼️ All ${earlyCaptured} thumbnails were captured eagerly by parsers. No late capture needed.`);
            }

            const totalCaptured = messages.filter(m => m && m.thumbnail).length;
            const totalMedia = messages.filter(m => m && ['image', 'video', 'gif', 'sticker'].includes(m.type)).length;
            console.log(`[WA-Exporter] 🖼️ Successfully captured ${totalCaptured}/${totalMedia} thumbnails.`);
        }

        // Shared AI Request Budget
        const sharedAiBudget = { callsMade: 0, maxCalls: parseInt(request.maxAiRequests, 10) || 50 };
        // 2. Gemini AI Captioning Pipeline
        let processedCaptions = 0;
        if (shouldRunAi) {
            try {
                broadcastProgress(0, 'ai_captioning', 'ai', { total: 0, model: request.model || null });
                if (signal && signal.aborted) throw new Error("Aborted");
                await window.WAExporter.Gemini.processMessageCaptions(messages, {
                    apiKey: request.geminiApiKey,
                    signal: window.WAExporter.State.abortController ? window.WAExporter.State.abortController.signal : null,
                    budget: sharedAiBudget,
                    maxRequests: request.maxAiRequests || 50,
                    customPrompt: request.customPrompt,
                    model: request.model || null
                }, (curr, total, phaseLabel, activeModel) => {
                    broadcastProgress(curr, 'ai_captioning', 'ai', { total: total, model: activeModel || request.model || null });
                });
                processedCaptions = messages.filter(m => m && m.aiCaption).length;
            } catch (aiErr) {
                console.warn('[WA-Exporter] AI captioning encountered an error:', aiErr.message);
            }
        }

        // 2.5 Late Audio Capture Pipeline
        const shouldRunTranscription = request && request.enableAiTranscription && request.geminiApiKey && window.WAExporter.Gemini;
        const audioItems = shouldRunTranscription ? messages.map((m, idx) => ({ key: idx, msg: m }))
            .filter(item => item.msg && ['ptt', 'audio'].includes(item.msg.type) && !item.msg.audioData) : [];

        if (audioItems.length > 0) {
            console.log(`[WA-Exporter] 🎤 Processing late capture for ${audioItems.length} audio items sequentially...`);
            for (const item of audioItems) {
                if (signal && signal.aborted) throw new Error("Aborted");
                try {
                    let targetUrl = item.msg.audioBlobUrl;
                    
                    if (!targetUrl && item.msg.id && window.WAExporter.queryDB) {
                        try {
                            const dbResult = await window.WAExporter.queryDB('extract_audio_blob', { messageId: item.msg.id }, 2500);
                            if (dbResult) {
                                targetUrl = dbResult;
                                item.msg.audioBlobUrl = dbResult;
                                console.log('[WA-Exporter] Retrieved audio blob URL via queryDB:', targetUrl);
                            }
                        } catch (dbErr) {
                            console.warn('[WA-Exporter] Failed to get audio blob from queryDB:', dbErr);
                        }
                    }

                    if (!targetUrl) continue;

                    let base64 = null;
                    if (targetUrl.startsWith('data:')) {
                        base64 = targetUrl;
                    } else {
                        const blob = await fetch(targetUrl).then(r => r.blob());
                        base64 = await new Promise((resolve) => {
                            const reader = new FileReader();
                            reader.onloadend = () => resolve(reader.result);
                            reader.readAsDataURL(blob);
                        });
                    }
                    if (base64 && base64.startsWith('data:')) {
                        item.msg.audioData = base64;
                    }
                } catch (e) {
                    console.warn('[WA-Exporter] Audio blob fetch failed:', e);
                }
            }
        }

        // 3. Gemini AI Voice Note Transcription Pipeline
        if (shouldRunTranscription) {
            try {
                const totalQuota = parseInt(request.maxAiRequests, 10) || 50;
                const remainingQuota = Math.max(0, totalQuota - processedCaptions);
                if (remainingQuota > 0) {
                    broadcastProgress(0, 'ai_transcription', 'ai', { total: 0, model: request.model || null });
                    if (signal && signal.aborted) throw new Error("Aborted");
                    await window.WAExporter.Gemini.processMessageTranscriptions(messages, {
                        apiKey: request.geminiApiKey,
                    signal: window.WAExporter.State.abortController ? window.WAExporter.State.abortController.signal : null,
                        budget: sharedAiBudget,
                        maxRequests: request.maxAiRequests || 50,
                        model: request.model || null
                    }, (curr, total, phaseLabel, activeModel) => {
                        broadcastProgress(curr, 'ai_transcription', 'ai', { total: total, model: activeModel || request.model || null });
                    });
                } else {
                    console.log('[WA-Exporter] ℹ️ Max AI quota reached by image captions. Skipping voice transcription.');
                }
            } catch (trErr) {
                console.warn('[WA-Exporter] AI transcription encountered an error:', trErr.message);
            }
        }

        // Clean up internal properties: delete thumbnail and audioData after processed
        messages.forEach(m => {
            if (m) {
                if (!shouldCaptureThumbnails) {
                    delete m.thumbnail;
                }
                delete m.blobUrl;
                delete m.audioData;
                delete m.audioBlobUrl;
            }
        });

        return messages;
    }

    async function renderCanvasThumbnail(url, maxSize = 160) {
        if (!url || typeof url !== 'string') return null;
        try {
            const img = await new Promise((resolve, reject) => {
                const i = new Image();
                i.crossOrigin = 'anonymous';
                i.onload = () => resolve(i);
                i.onerror = () => reject(new Error('Image failed'));
                i.src = url;
            });
            let width = img.naturalWidth || img.width;
            let height = img.naturalHeight || img.height;
            if (!width || !height) return null;
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
            canvas.width = Math.max(1, width);
            canvas.height = Math.max(1, height);
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, width, height);
            let dataUrl = canvas.toDataURL('image/webp', 0.5);
            if (!dataUrl || !dataUrl.startsWith('data:image/webp')) {
                dataUrl = canvas.toDataURL('image/jpeg', 0.5);
            }
            return dataUrl;
        } catch (e) {
            return null;
        }
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

        const body = valid.map(m => {
            let extra = '';
            if (m.aiCaption) {
                extra += ` [AI: "${m.aiCaption}"]`;
            }
            if (m.aiTranscript) {
                extra += ` [Transcript: "${m.aiTranscript}"]`;
            }

            if (m.rawFormat) {
                return `${m.rawFormat}${extra}`;
            }

            let content = (m.content || '') + extra;
            return `[${new Date(m.timestamp).toLocaleTimeString()}] ${m.sender}: ${content}`;
        }).join('\n');

        return header + body;
    }

    function cleanMessageForExport(m, params = {}) {
        const includeThumbnails = params.captureThumbnails !== false;
        const item = {
            timestamp: m.timestamp,
            sender: m.sender,
            type: m.type,
            content: m.content
        };
        // Always delete thumbnail after processed by AI, or if thumbnails disabled
        if (includeThumbnails && m.thumbnail) {
            item.thumbnail = m.thumbnail;
        }
        if (m.aiCaption) {
            item.aiCaption = m.aiCaption;
        }
        if (m.aiTranscript) {
            item.aiTranscript = m.aiTranscript;
        }
        item.quotedMessage = m.quotedMessage || null;
        item.mediaUrl = m.mediaUrl || null;
        item.rawFormat = m.rawFormat;
        return item;
    }

    function formatAsJson(messages, meta, params = {}) {
        const valid = (messages || []).filter(m => (m.content && m.content.trim() !== '') || m.mediaUrl);
        const cleaned = valid.map(m => cleanMessageForExport(m, params));
        return JSON.stringify({
            metadata: {
                chatName: meta.chatName,
                exportedAt: meta.exportDate,
                exportTimestamp: meta.exportTimestamp,
                scope: meta.scope,
                scopeLabel: meta.scopeLabel,
                totalMessages: cleaned.length
            },
            messages: cleaned
        }, null, 2);
    }

    function escapeCsvCell(val) {
        if (val === null || val === undefined) return '""';
        const str = String(val).replace(/"/g, '""');
        return `"${str}"`;
    }

    function formatAsCsv(messages, meta, params = {}) {
        const includeThumbnails = params.captureThumbnails !== false;
        const valid = (messages || []).filter(m => (m.content && m.content.trim() !== '') || m.mediaUrl);
        const metaComments = [
            `# WhatsApp Chat Export: ${meta.chatName}`,
            `# Exported On: ${meta.exportDate}`,
            `# Scope: ${meta.scopeLabel} | Total Messages: ${valid.length}`
        ];

        const headers = ['Timestamp', 'Date', 'Time', 'Sender', 'Type', 'Content', 'AICaption', 'AITranscript', 'Thumbnail', 'QuotedSender', 'QuotedContent', 'MediaURL'];
        const rows = valid.map(m => {
            const d = new Date(m.timestamp);
            const dateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
            const timeStr = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
            const quotedSender = m.quotedMessage?.sender || '';
            const quotedContent = m.quotedMessage?.content || '';
            const thumbnailVal = includeThumbnails ? (m.thumbnail || '') : '';

            return [
                escapeCsvCell(m.timestamp),
                escapeCsvCell(dateStr),
                escapeCsvCell(timeStr),
                escapeCsvCell(m.sender),
                escapeCsvCell(m.type),
                escapeCsvCell(m.content),
                escapeCsvCell(m.aiCaption || ''),
                escapeCsvCell(m.aiTranscript || ''),
                escapeCsvCell(thumbnailVal),
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
                return { text: formatAsJson(messages, meta, params), mime: 'application/json', ext: 'json' };
            case 'csv':
                return { text: formatAsCsv(messages, meta, params), mime: 'text/csv;charset=utf-8;', ext: 'csv' };
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
            browser.runtime.sendMessage({ type: 'download_file', filename, text, mime }).then(res => {
                if (!res || !res.ok) throw new Error("Background download failed or unavailable");
            }).catch(() => {
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
            });
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
            if (window.WAExporter.State.abortController) {
                window.WAExporter.State.abortController.abort();
            }
            if (window.WAExporter && window.WAExporter.Scroller && window.WAExporter.Scroller.abortExtraction) {
                window.WAExporter.Scroller.abortExtraction();
            }
            sendResponse({ status: 'aborted' });
            return false;
        }
    });
})();
