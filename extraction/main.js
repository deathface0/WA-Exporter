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

    // One message listener per tab. The popup re-injects this script on every open, so a newer
    // copy (e.g. after an extension reload or update) replaces the previous listener, unless an
    // export is running: that listener owns its progress and cancellation.
    if (window.__waMainListener) {
        if (window.WAExporter.State.status === 'extracting') return;
        try { browser.runtime.onMessage.removeListener(window.__waMainListener); } catch (e) { }
    }

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

    // Cancelling keeps what was collected: a phase that stops on abort returns true instead of
    // throwing, and the caller exports the messages so far as partial.
    async function untilAborted(fn, signal) {
        try {
            await fn();
        } catch (err) {
            if ((signal && signal.aborted) || err.message === 'Aborted') return true;
            throw err;
        }
        return !!(signal && signal.aborted);
    }

    function completeExtraction(res, request) {
        if (res.stopReason === 'aborted') console.log(`[WA-Exporter] Cancelled: returning ${res.data.length} collected messages as partial.`);
        window.WAExporter.State.status = 'completed';
        window.WAExporter.State.result = res;
        window.WAExporter.State.completedAt = Date.now();
        broadcastCompleted(res);
        handleBackgroundAutoAction(res, request);
        return res;
    }

    /**
     * WA-JS only reads the local cache. When older history is still on the phone, the DOM
     * engine scrolls up and taps WhatsApp's "older messages" notice (what the user would do),
     * then WA-JS resumes paging to read the synced messages exactly. DOM entries only fill
     * what WA-JS still cannot see. Errors keep the first WA-JS result.
     */
    // Chats where a phone sync brought nothing, keyed by chat + oldest local message:
    // WhatsApp keeps offering the phone notice, so later exports skip it for a while.
    const OLDER_SYNC_KEY = 'olderSyncExhausted';
    const OLDER_SYNC_TTL_MS = 7 * 24 * 60 * 60 * 1000;

    async function readExhausted() {
        try {
            const stored = await browser.storage.local.get(OLDER_SYNC_KEY);
            const entries = (stored && stored[OLDER_SYNC_KEY]) || {};
            const now = Date.now();
            Object.keys(entries).forEach(k => { if (!(now - entries[k] < OLDER_SYNC_TTL_MS)) delete entries[k]; });
            return entries;
        } catch (e) {
            return {};
        }
    }

    async function syncOlderHistory(wajsRes, request, signal, onWajsProgress) {
        const Engine = window.WAExporter.WajsEngine;
        const Mapper = window.WAExporter.WajsMapper;
        const Scroller = window.WAExporter.Scroller;
        if (!Scroller) return wajsRes;

        // Opt-in (popup: "Load older messages from phone"): it scrolls the chat and asks the phone.
        if (request.syncOlderFromPhone !== true && request.debugForceOlder !== true) {
            return Object.assign({}, wajsRes, { olderSync: { skipped: 'disabled', history: wajsRes.history } });
        }
        const exhaustedKey = `${wajsRes.resume.chatId}|${wajsRes.resume.anchor}`;
        const exhausted = await readExhausted();
        if (exhausted[exhaustedKey] && request.debugForceOlder !== true) {
            console.log('[WA-Exporter] Older-history sync skipped: the last one for this chat brought nothing.');
            // Same outcome as that sync: for "all", the chat start was already reached.
            const isPartial = (request.mode || 'all') === 'all' ? false : wajsRes.isPartial;
            return Object.assign({}, wajsRes, { isPartial, olderSync: { skipped: 'exhausted', history: wajsRes.history } });
        }

        window.WAExporter.State.progress = { count: wajsRes.messages.length, phase: 'wajs_sync_older', source: 'dom' };
        broadcastProgress(wajsRes.messages.length, 'wajs_sync_older', 'dom');

        let scrollResult;
        try {
            // The scroller expects the view at the newest message.
            const container = window.WAExporter.findScrollContainer && window.WAExporter.findScrollContainer();
            if (container) container.scrollTop = container.scrollHeight;
            scrollResult = await Scroller.startExtraction(Object.assign({}, request, { maxPhoneSyncClicks: 1 }));
        } catch (err) {
            if (signal.aborted) throw new Error('Aborted');
            console.warn('[WA-Exporter] Older-history sync via DOM failed, keeping WA-JS result:', err.message);
            return Object.assign({}, wajsRes, { olderSync: { error: err.message, history: wajsRes.history } });
        }
        if (signal.aborted) throw new Error('Aborted');

        const resumed = await Engine.run(request, signal, onWajsProgress, wajsRes.resume);
        if (resumed.olderPass === 'chat_changed') {
            // The DOM messages belong to whatever chat is open now: never merge them.
            console.warn('[WA-Exporter] Chat changed during older-history sync, keeping WA-JS result.');
            return Object.assign({}, wajsRes, { olderSync: { chatChanged: true, history: wajsRes.history } });
        }
        const domMessages = scrollResult.messages || [];
        // Oldest timestamp WA-JS saw (any type): the DOM only adds history before it.
        const oldestT = resumed.resume && resumed.resume.oldestT;
        const merged = Mapper.mergeWithDom(resumed.messages, domMessages, request,
            { domOnlyBefore: Number.isFinite(oldestT) ? oldestT * 1000 : Infinity });
        const wajsCount = merged.filter(m => m.engine === 'wajs').length;
        if (resumed.messages.length === wajsRes.messages.length && merged.length === wajsCount) {
            exhausted[exhaustedKey] = Date.now();
            try { await browser.storage.local.set({ [OLDER_SYNC_KEY]: exhausted }); } catch (e) { }
        }
        console.log(`[WA-Exporter] Older-history sync: ${resumed.messages.length - wajsRes.messages.length} more from WA-JS, ${merged.length - wajsCount} DOM-only.`);
        return Object.assign({}, resumed, {
            messages: merged,
            isPartial: resumed.isPartial && scrollResult.isPartial !== false,
            olderSync: {
                firstPass: wajsRes.messages.length,
                secondPass: resumed.messages.length,
                domMessages: merged.length - wajsCount,
                domPartial: !!scrollResult.isPartial,
                history: resumed.history
            }
        });
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

        // DOM only: opening the popup must not inject anything into the page (no IndexedDB
        // query, which needs db/page-script.js in the MAIN world).
        const resolvedName = domTitle;
        const resolvedId = domTitle;
        let msgCount = 0;
        const source = 'dom';

        if (domTitle) {
            const selectors = window.WAExporter.SELECTORS || {};
            const visibleRows = document.querySelectorAll(selectors.messageRow || 'div.message-in, div.message-out, div[role="row"]');
            msgCount = visibleRows.length;
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
                let fallbackReason = null;
                let wajsPartial = [];

                // 0. WA-JS engine (Auto, the default since v3.0; 'wajs' is its v3.0-beta name).
                // Any failure falls through to the DOM path.
                if (request.engine !== 'dom' && window.WAExporter.WajsEngine) {
                    const Engine = window.WAExporter.WajsEngine;
                    const signal = window.WAExporter.State.abortController.signal;
                    const onWajsProgress = (count, phase, total) => {
                        window.WAExporter.State.progress = { count, phase, source: 'wajs' };
                        broadcastProgress(count, phase, 'wajs', total ? { total } : {});
                    };
                    try {
                        let wajsRes;
                        let aborted = false;
                        try {
                            wajsRes = await Engine.run(request, signal, onWajsProgress);
                            aborted = signal.aborted;
                            if (wajsRes.needsOlder && !aborted) {
                                let synced = null;
                                aborted = await untilAborted(async () => {
                                    synced = await syncOlderHistory(wajsRes, request, signal, onWajsProgress);
                                }, signal);
                                if (synced) wajsRes = synced;
                            }
                            // Local media caches only; release the host before any AI calls.
                            if (!aborted) {
                                aborted = await untilAborted(() => Engine.enrichMedia(wajsRes.messages, {
                                    thumbnails: request.captureThumbnails !== false || !!(request.enableAiCaptions && request.geminiApiKey),
                                    audio: !!(request.enableAiTranscription && request.geminiApiKey && window.WAExporter.Gemini),
                                    maxSize: parseInt(request.thumbnailSize, 10) || 160,
                                    network: {
                                        enabled: request.downloadMissingMedia === true,
                                        maxAgeDays: request.mediaMaxAgeDays,
                                        maxDownloads: request.maxMediaDownloads
                                    }
                                }, signal, onWajsProgress), signal);
                            }
                        } finally {
                            await Engine.release();
                        }
                        if (!aborted) aborted = await untilAborted(() => runMediaAndAiPipeline(wajsRes.messages, request), signal);
                        return completeExtraction({
                            data: wajsRes.messages,
                            source: wajsRes.olderSync && wajsRes.olderSync.domMessages ? 'wajs+dom' : 'wajs',
                            engine: 'wajs',
                            isPartial: wajsRes.isPartial || aborted,
                            stopReason: aborted ? 'aborted' : wajsRes.stopReason,
                            olderSync: wajsRes.olderSync || null,
                            fallbackReason: null,
                            waVersion: wajsRes.waVersion,
                            wajsVersion: wajsRes.wajsVersion
                        }, request);
                    } catch (err) {
                        if (err.name === 'WajsUnavailable') {
                            fallbackReason = err.reason;
                        } else if (err.name === 'WajsMidRunError') {
                            fallbackReason = 'midrun: ' + err.message;
                            wajsPartial = err.partial || [];
                        } else {
                            throw err;
                        }
                        console.warn('[WA-Exporter] WA-JS engine failed, falling back to DOM:', fallbackReason);
                        broadcastProgress(wajsPartial.length, 'engine_fallback', 'dom', { reason: fallbackReason });
                    }
                }

                // 1. DOM scroller, merged with whatever WA-JS collected before a mid-run failure.
                // (The direct IndexedDB read was retired in v3.0: WhatsApp now encrypts columns of
                // model-storage, and WA-JS reads the same data through WhatsApp's storage layer.)
                const Scroller = window.WAExporter.Scroller;
                if (!Scroller) throw new Error('DOM scroller not available.');
                const signal = window.WAExporter.State.abortController.signal;
                window.WAExporter.State.progress = { count: wajsPartial.length, phase: 'scrolling', source: 'dom' };
                broadcastProgress(wajsPartial.length, 'scrolling', 'dom');

                const scrollResult = await Scroller.startExtraction(request);
                const merged = window.WAExporter.WajsMapper.mergeWithDom(wajsPartial, scrollResult.messages || [], request);
                let aborted = signal.aborted;
                if (!aborted) aborted = await untilAborted(() => runMediaAndAiPipeline(merged, request), signal);
                return completeExtraction({
                    data: merged,
                    source: 'dom',
                    engine: 'dom',
                    fallbackReason,
                    isPartial: aborted || !!scrollResult.isPartial,
                    stopReason: aborted ? 'aborted' : (scrollResult.stopReason || null)
                }, request);
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
            // WA-JS messages never use the DOM right-click capture; their audio comes from enrichMedia().
            .filter(item => item.msg && item.msg.engine !== 'wajs' && ['ptt', 'audio'].includes(item.msg.type) && !item.msg.audioData) : [];

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

        const Formatters = window.WAExporter.Formatters;

        if (intent === 'download') {
            const formatted = Formatters.formatMessages(res.data, format, request, chatTitle, res);
            const filename = Formatters.generateFilename(chatTitle, request, formatted.ext);
            triggerDownload(filename, formatted.text, formatted.mime);
            showToast(`📥 Export complete! Downloaded ${res.data.length.toLocaleString()} messages.`);
        } else if (intent === 'copy') {
            const formatted = Formatters.formatMessages(res.data, format, request, chatTitle, res);
            copyToClipboard(formatted.text).then(ok => {
                if (ok) {
                    showToast(`📋 Export complete! Copied ${res.data.length.toLocaleString()} messages to clipboard.`);
                } else {
                    showToast(`📋 Export complete (${res.data.length.toLocaleString()} messages ready in popup).`);
                }
            });
        }
    }

    window.__waMainListener = (request, _sender, sendResponse) => {
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

        // Dev probe (phase 0): inject WA-JS and run the read-only health check.
        if (request.action === 'wajs_probe') {
            const Wajs = window.WAExporter.Wajs;
            if (!Wajs) {
                sendResponse({ ok: false, error: 'WA-JS client not loaded' });
                return false;
            }
            Wajs.ensureInjected(request.version || null)
                .then(inj => Wajs.call('wajs_health', { expectedChatTitle: request.expectedChatTitle || null })
                    .then(health => sendResponse({ injection: inj, health })))
                .catch(err => sendResponse({ ok: false, error: err.message }));
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
    };
    browser.runtime.onMessage.addListener(window.__waMainListener);
})();
