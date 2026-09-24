(function () {
    'use strict';

    if (typeof browser === 'undefined') {
        window.browser = chrome;
    }

    /* ── Helpers ── */

    const $ = (id) => document.getElementById(id);
    const pad = (n) => n.toString().padStart(2, '0');

    function formatLocalDatetime(date) {
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    let activeChatTitle = 'Chat';
    let isExtracting = false;
    let cachedResult = null;
    let cachedParams = null;

    /* ── Init & State Persistence ── */

    document.addEventListener('DOMContentLoaded', async () => {
        const now = new Date();
        const yesterday = new Date(now.getTime() - 86400000);

        // Restore persisted inputs
        let storage = {};
        try {
            storage = await browser.storage.local.get([
                'startTime', 'endTime', 'extractMode', 'exportFormat', 'messageCount',
                'captureThumbnails', 'thumbnailResolution', 'enableAiCaptions', 'enableAiTranscription', 'geminiApiKey', 'maxAiRequests', 'advancedExpanded',
                'aiModelPreference', 'customAiPrompt', 'promptExpanded'
            ]);
        } catch (e) { }

        $('startTime').value = storage.startTime || formatLocalDatetime(yesterday);
        $('endTime').value = storage.endTime || formatLocalDatetime(now);
        if (storage.messageCount) $('messageCount').value = storage.messageCount;

        if (storage.extractMode) {
            const r = document.querySelector(`input[name="extractMode"][value="${storage.extractMode}"]`);
            if (r) r.checked = true;
        }

        if (storage.exportFormat) {
            const r = document.querySelector(`input[name="exportFormat"][value="${storage.exportFormat}"]`);
            if (r) r.checked = true;
        }

        // Restore Advanced & AI settings
        if (storage.captureThumbnails !== undefined) {
            $('toggleThumbnails').checked = !!storage.captureThumbnails;
        }
        if (storage.thumbnailResolution) {
            $('thumbnailResolution').value = storage.thumbnailResolution;
        }
        if (storage.enableAiCaptions !== undefined) {
            $('toggleAiCaptions').checked = !!storage.enableAiCaptions;
        }
        if (storage.enableAiTranscription !== undefined && $('toggleAiTranscription')) {
            $('toggleAiTranscription').checked = !!storage.enableAiTranscription;
        }
        if (storage.geminiApiKey) {
            $('geminiApiKey').value = storage.geminiApiKey;
        }
        if (storage.maxAiRequests) {
            $('maxAiRequests').value = storage.maxAiRequests;
        }
        if (storage.aiModelPreference && $('aiModelSelect')) {
            $('aiModelSelect').value = storage.aiModelPreference;
        }
        if (storage.customAiPrompt && $('customAiPrompt')) {
            $('customAiPrompt').value = storage.customAiPrompt;
        }
        if (storage.advancedExpanded) {
            $('advancedContent').style.display = 'flex';
            $('advancedToggleArrow').textContent = '▾';
        }
        if (storage.promptExpanded && $('promptContent')) {
            $('promptContent').style.display = 'flex';
            $('promptToggleArrow').textContent = '▾';
        }

        function updateCapacityBadge() {
            const calls = parseInt($('maxAiRequests').value, 10) || 50;
            const items = calls * 4;
            if ($('aiCapacityBadge')) {
                $('aiCapacityBadge').textContent = `≈ ${items} items`;
            }
        }

        updateCapacityBadge();
        toggleInputs();
        toggleAdvancedSections();

        // Persist on change & invalidate cache
        document.querySelectorAll('input[name="extractMode"]').forEach(r => {
            r.addEventListener('change', (e) => {
                browser.storage.local.set({ extractMode: e.target.value });
                toggleInputs();
                invalidateCache();
            });
        });

        document.querySelectorAll('input[name="exportFormat"]').forEach(r => {
            r.addEventListener('change', (e) => {
                browser.storage.local.set({ exportFormat: e.target.value });
            });
        });

        $('startTime').addEventListener('change', (e) => {
            browser.storage.local.set({ startTime: e.target.value });
            invalidateCache();
        });

        $('endTime').addEventListener('change', (e) => {
            browser.storage.local.set({ endTime: e.target.value });
            invalidateCache();
        });

        $('messageCount').addEventListener('change', (e) => {
            browser.storage.local.set({ messageCount: e.target.value });
            invalidateCache();
        });

        // Advanced & AI handlers
        $('advancedToggleBtn').addEventListener('click', () => {
            const content = $('advancedContent');
            const arrow = $('advancedToggleArrow');
            const isHidden = content.style.display === 'none';
            content.style.display = isHidden ? 'flex' : 'none';
            arrow.textContent = isHidden ? '▾' : '▸';
            browser.storage.local.set({ advancedExpanded: isHidden });
        });

        if ($('promptToggleBtn')) {
            $('promptToggleBtn').addEventListener('click', () => {
                const content = $('promptContent');
                const arrow = $('promptToggleArrow');
                const isHidden = content.style.display === 'none';
                content.style.display = isHidden ? 'flex' : 'none';
                arrow.textContent = isHidden ? '▾' : '▸';
                browser.storage.local.set({ promptExpanded: isHidden });
            });
        }

        if ($('resetPromptBtn')) {
            $('resetPromptBtn').addEventListener('click', () => {
                $('customAiPrompt').value = '';
                browser.storage.local.set({ customAiPrompt: '' });
                invalidateCache();
            });
        }

        if ($('customAiPrompt')) {
            $('customAiPrompt').addEventListener('input', (e) => {
                browser.storage.local.set({ customAiPrompt: e.target.value });
                invalidateCache();
            });
        }

        if ($('aiModelSelect')) {
            $('aiModelSelect').addEventListener('change', (e) => {
                browser.storage.local.set({ aiModelPreference: e.target.value });
                invalidateCache();
            });
        }

        $('toggleThumbnails').addEventListener('change', (e) => {
            browser.storage.local.set({ captureThumbnails: e.target.checked });
            toggleAdvancedSections();
            invalidateCache();
        });

        $('thumbnailResolution').addEventListener('change', (e) => {
            browser.storage.local.set({ thumbnailResolution: e.target.value });
            invalidateCache();
        });

        if ($('toggleAiCaptions')) {
            $('toggleAiCaptions').addEventListener('change', (e) => {
                browser.storage.local.set({ enableAiCaptions: e.target.checked });
                toggleAdvancedSections();
                invalidateCache();
            });
        }

        if ($('toggleAiTranscription')) {
            $('toggleAiTranscription').addEventListener('change', (e) => {
                browser.storage.local.set({ enableAiTranscription: e.target.checked });
                invalidateCache();
            });
        }

        $('geminiApiKey').addEventListener('input', (e) => {
            browser.storage.local.set({ geminiApiKey: e.target.value.trim() });
            $('apiKeyValidationStatus').style.display = 'none';
            invalidateCache();
        });

        $('maxAiRequests').addEventListener('input', () => {
            updateCapacityBadge();
        });

        $('maxAiRequests').addEventListener('change', (e) => {
            updateCapacityBadge();
            browser.storage.local.set({ maxAiRequests: e.target.value });
        });

        $('validateKeyBtn').addEventListener('click', async () => {
            const key = $('geminiApiKey').value.trim();
            const statusEl = $('apiKeyValidationStatus');
            if (!key) {
                statusEl.className = 'validation-status error';
                statusEl.textContent = '❌ Please enter an API key.';
                statusEl.style.display = 'block';
                return;
            }
            statusEl.className = 'validation-status';
            statusEl.textContent = '⏳ Checking key with Google AI Studio...';
            statusEl.style.display = 'block';

            try {
                const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`);
                if (res.status === 200) {
                    const data = await res.json();
                    const models = (data && data.models) ? data.models.length : 0;
                    statusEl.className = 'validation-status success';
                    statusEl.textContent = `✅ Valid! Connected to Google AI (${models} models available).`;
                } else {
                    statusEl.className = 'validation-status error';
                    statusEl.textContent = `❌ Invalid key (Status ${res.status}).`;
                }
            } catch (err) {
                statusEl.className = 'validation-status error';
                statusEl.textContent = `❌ Error checking key: ${err.message}`;
            }
        });

        // Listen for background extraction events
        browser.runtime.onMessage.addListener((message) => {
            if (!message) return;

            if (message.type === 'extraction_progress') {
                if (!isExtracting) {
                    isExtracting = true;
                    setProgressVisible(true);
                }
                updateProgress(message.count, message.phase, message.source, {
                    total: message.total,
                    model: message.model
                });
                setStatus('Extracting messages…', true);
            } else if (message.type === 'extraction_completed') {
                isExtracting = false;
                setProgressVisible(false);
                if (message.result && message.result.data) {
                    cachedResult = message.result;
                    cachedParams = getCurrentParams();
                    const msgCount = message.result.data.length;
                    const sourceMsg = message.result.source === 'database' ? 'via database' : 'via DOM scroll';
                    const partialNotice = message.result.isPartial ? ' (partial)' : '';
                    setStatus(`Done: ${msgCount.toLocaleString()} messages ready ${sourceMsg}${partialNotice}.`, false);
                    $('copyBtn').disabled = false;
                    $('downloadBtn').disabled = false;

                    if (msgCount === 0) {
                        alert('Extraction finished, but 0 messages were found. Ensure you have the chat open and the correct filters applied.');
                    }
                }
            } else if (message.type === 'extraction_error') {
                isExtracting = false;
                setProgressVisible(false);
                setStatus(`Extraction error: ${message.error || 'Unknown error'}`, false);
                $('copyBtn').disabled = false;
                $('downloadBtn').disabled = false;
            }
        });

        // Probe chat info and restore any active/completed background state
        await probeChatInfo();
    });

    function toggleInputs() {
        const mode = document.querySelector('input[name="extractMode"]:checked').value;
        $('dateInputs').style.display = mode === 'date' ? 'block' : 'none';
        $('countInput').style.display = mode === 'count' ? 'block' : 'none';
    }

    function toggleAdvancedSections() {
        const thumbsOn = $('toggleThumbnails').checked;
        $('thumbnailOptions').style.display = thumbsOn ? 'flex' : 'none';

        const aiOn = $('toggleAiCaptions').checked;
        $('aiOptions').style.display = aiOn ? 'flex' : 'none';
    }

    function invalidateCache() {
        cachedResult = null;
        cachedParams = null;
    }

    function getCurrentParams() {
        const mode = document.querySelector('input[name="extractMode"]:checked').value;
        const selectedModel = $('aiModelSelect') ? $('aiModelSelect').value : 'auto';
        const customPrompt = $('customAiPrompt') ? $('customAiPrompt').value.trim() : '';
        return {
            chatId: activeChatTitle,
            mode,
            startTime: $('startTime').value,
            endTime: $('endTime').value,
            messageCount: $('messageCount').value,
            captureThumbnails: $('toggleThumbnails').checked,
            thumbnailSize: $('thumbnailResolution').value,
            enableAiCaptions: $('toggleAiCaptions').checked,
            enableAiTranscription: $('toggleAiTranscription') ? $('toggleAiTranscription').checked : true,
            geminiApiKey: $('geminiApiKey').value.trim(),
            maxAiRequests: parseInt($('maxAiRequests').value, 10) || 50,
            model: selectedModel === 'auto' ? null : selectedModel,
            customPrompt: customPrompt || null
        };
    }

    function areParamsEqual(p1, p2) {
        if (!p1 || !p2) return false;
        if (p1.chatId && p2.chatId && p1.chatId !== p2.chatId) return false;
        if (p1.mode !== p2.mode) return false;
        if (p1.captureThumbnails !== p2.captureThumbnails) return false;
        if (p1.thumbnailSize !== p2.thumbnailSize) return false;
        if (p1.enableAiCaptions !== p2.enableAiCaptions) return false;
        if (p1.enableAiTranscription !== p2.enableAiTranscription) return false;
        if (p1.geminiApiKey !== p2.geminiApiKey) return false;
        if (p1.maxAiRequests !== p2.maxAiRequests) return false;
        if (p1.model !== p2.model) return false;
        if (p1.customPrompt !== p2.customPrompt) return false;
        if (p1.mode === 'date') {
            return p1.startTime === p2.startTime && p1.endTime === p2.endTime;
        }
        if (p1.mode === 'count') {
            return String(p1.messageCount) === String(p2.messageCount);
        }
        return true;
    }

    /* ── Content Script Injection ── */

    const REQUIRED_SCRIPTS = [
        'ai/gemini.js',
        'db/bridge.js',
        'extraction/selectors.js',
        'extraction/parsers.js',
        'extraction/scroller.js',
        'extraction/main.js'
    ];

    async function ensureInjected(tabId) {
        try {
            await browser.scripting.executeScript({
                target: { tabId: tabId },
                world: 'MAIN',
                files: ['db/page-script.js']
            });
        } catch (e) { }

        for (const file of REQUIRED_SCRIPTS) {
            try {
                await browser.scripting.executeScript({
                    target: { tabId: tabId },
                    files: [file]
                });
            } catch (err) { }
        }
    }

    /* ── Tab Helper ── */

    async function getActiveTab() {
        const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
        if (activeTab && activeTab.url && activeTab.url.includes('web.whatsapp.com')) {
            return activeTab;
        }

        try {
            const waTabs = await browser.tabs.query({ url: '*://web.whatsapp.com/*' });
            if (waTabs && waTabs.length > 0) {
                return waTabs[0];
            }
        } catch (e) { }

        return activeTab;
    }

    async function sendTabMessage(tabId, message, retries = 5) {
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                return await browser.tabs.sendMessage(tabId, message);
            } catch (err) {
                if (attempt === retries) throw err;
                await ensureInjected(tabId);
                await new Promise(resolve => setTimeout(resolve, 350));
            }
        }
    }

    /* ── Chat Insight Probe & State Restoration ── */

    async function probeChatInfo() {
        const insight = $('chatInsight');
        const insightText = $('insightText');

        insight.className = 'loading';
        insightText.textContent = 'Detecting chat…';
        insight.querySelector('.insight-icon').textContent = '⏳';

        try {
            const tab = await getActiveTab();
            if (!tab || !tab.url || !tab.url.includes('web.whatsapp.com')) {
                showInsight('warning', '⚠️', 'Navigate to WhatsApp Web first.');
                return;
            }

            await ensureInjected(tab.id);

            const info = await sendTabMessage(tab.id, { action: 'get_chat_info' });

            if (!info || !info.chatId) {
                showInsight('warning', '💬', 'Open a chat in WhatsApp Web.');
                return;
            }

            const newChatTitle = info.chatName || (info.chatId && info.chatId.includes('@') ? info.chatId.split('@')[0] : info.chatId) || 'WhatsApp Chat';

            // Invalidate cache if switched to a different chat
            if (activeChatTitle && activeChatTitle !== newChatTitle) {
                invalidateCache();
            }
            activeChatTitle = newChatTitle;

            const msgCount = info.totalMessages ? info.totalMessages.toLocaleString() : '0';
            const sourceLabel = info.source === 'database' ? 'cached in database' : 'visible in chat';
            showInsight('ready', '💬', `Ready: ${msgCount} messages (${sourceLabel})`, activeChatTitle);

            $('copyBtn').disabled = false;
            $('downloadBtn').disabled = false;

            // Restore any running or completed background extraction state
            await checkAndRestoreBackgroundState(tab.id);
        } catch (err) {
            console.error('[WA-Exporter Popup] probe error:', err);
            showInsight('warning', '❌', 'Could not connect to WhatsApp Web.');
        }
    }

    async function checkAndRestoreBackgroundState(tabId) {
        try {
            const response = await sendTabMessage(tabId, { action: 'get_extraction_state' });
            if (!response || !response.state) return;

            const state = response.state;

            // Only restore if the background state belongs to the currently active chat
            if (state.chatName && activeChatTitle && state.chatName !== activeChatTitle) {
                return;
            }

            if (state.status === 'extracting') {
                isExtracting = true;
                setProgressVisible(true);
                $('copyBtn').disabled = true;
                $('downloadBtn').disabled = true;
                updateProgress(state.progress?.count || 0, state.progress?.phase || 'scrolling', state.progress?.source || 'dom');
                setStatus('Extraction in progress in background…', true);
            } else if (state.status === 'completed' && state.result && state.result.data) {
                isExtracting = false;
                setProgressVisible(false);
                $('copyBtn').disabled = false;
                $('downloadBtn').disabled = false;
                cachedResult = state.result;
                cachedParams = state.request ? {
                    chatId: activeChatTitle,
                    mode: state.request.mode,
                    startTime: $('startTime').value,
                    endTime: $('endTime').value,
                    messageCount: $('messageCount').value,
                    captureThumbnails: $('toggleThumbnails').checked,
                    thumbnailSize: $('thumbnailResolution').value,
                    enableAiCaptions: $('toggleAiCaptions').checked,
                    geminiApiKey: $('geminiApiKey').value.trim(),
                    maxAiRequests: parseInt($('maxAiRequests').value, 10) || 50,
                    model: state.request.model || null,
                    customPrompt: state.request.customPrompt || null
                } : getCurrentParams();

                const sourceMsg = state.result.source === 'database' ? 'via database' : 'via DOM scroll';
                const partialNotice = state.result.isPartial ? ' (partial)' : '';
                setStatus(`Ready: ${state.result.data.length.toLocaleString()} messages extracted ${sourceMsg}${partialNotice}.`, false);
            }
        } catch (e) {
            console.warn('[WA-Exporter Popup] Failed to restore background state:', e);
        }
    }

    function showInsight(cls, icon, text, chatName = null) {
        const el = $('chatInsight');
        el.className = cls;
        el.querySelector('.insight-icon').textContent = icon;
        $('insightText').textContent = text;

        const chatBadge = $('chatNameBadge');
        const chatTitleText = $('activeChatName');

        if (chatName && chatBadge && chatTitleText) {
            chatTitleText.textContent = chatName;
            chatBadge.style.display = 'flex';
        } else if (chatBadge) {
            chatBadge.style.display = 'none';
        }
    }

    /* ── Progress & Status ── */

    function setStatus(msg, showSpinner = false) {
        const container = $('statusContainer');
        if (!container) return;

        if (msg) {
            $('statusMsg').textContent = msg;
            container.classList.add('visible');
        } else {
            container.classList.remove('visible');
        }

        $('spinner').classList.toggle('active', showSpinner);
    }

    function setProgressVisible(visible) {
        const pc = $('progressContainer');
        const cancelBtn = $('cancelBtn');
        const barFill = $('progressBarFill');
        const modelBadge = $('progressModelBadge');
        const batchDetail = $('progressBatchDetail');

        if (visible) {
            pc.classList.add('active');
            cancelBtn.style.display = 'flex';
        } else {
            pc.classList.remove('active');
            cancelBtn.style.display = 'none';
            if (barFill) {
                barFill.classList.add('indeterminate');
                barFill.style.width = '';
            }
            if (modelBadge) modelBadge.style.display = 'none';
            if (batchDetail) batchDetail.textContent = '';
        }
    }

    function updateProgress(count, phase = 'scrolling', source = 'dom', extra = {}) {
        const countEl = $('progressCountText');
        const phaseEl = $('progressPhaseText');
        const modelBadge = $('progressModelBadge');
        const batchDetail = $('progressBatchDetail');
        const barFill = $('progressBarFill');

        if (countEl) countEl.textContent = `${count.toLocaleString()} items`;

        if (phase === 'ai_captioning' || phase === 'ai_transcription') {
            const total = extra.total || count || 1;
            const pct = Math.min(100, Math.round((count / total) * 100));
            if (barFill) {
                barFill.classList.remove('indeterminate');
                barFill.style.width = `${pct}%`;
            }

            const isAudio = phase === 'ai_transcription';
            if (phaseEl) phaseEl.textContent = isAudio ? `AI Transcription (${count}/${total})` : `AI Captioning (${count}/${total})`;
            if (batchDetail) batchDetail.textContent = isAudio ? `Audio STT • ${pct}%` : `4 imgs/call • ${pct}%`;

            if (modelBadge) {
                const selectedModel = $('aiModelSelect') ? $('aiModelSelect').value : '';
                const modelName = extra.model || (selectedModel && selectedModel !== 'auto' ? selectedModel : 'gemini-3.5-flash-lite');

                // If model changed (fallback), trigger pulse animation
                if (modelBadge.dataset.currentModel && modelBadge.dataset.currentModel !== modelName) {
                    modelBadge.classList.remove('pulsing');
                    void modelBadge.offsetWidth; // trigger reflow to restart animation
                    modelBadge.classList.add('pulsing');
                }
                modelBadge.dataset.currentModel = modelName;

                modelBadge.textContent = modelName.replace(/^models\//, '');
                modelBadge.style.display = 'inline-block';
            }
        } else {
            if (phase === 'scrolling' && extra.targetCount && count > 0) {
                const pct = Math.min(100, Math.round((count / extra.targetCount) * 100));
                if (barFill) {
                    barFill.classList.remove('indeterminate');
                    barFill.style.width = `${pct}%`;
                }
            } else {
                if (barFill) {
                    barFill.classList.add('indeterminate');
                    barFill.style.width = '';
                }
            }
            if (modelBadge) modelBadge.style.display = 'none';
            if (batchDetail) batchDetail.textContent = '';

            if (phaseEl) {
                if (phase === 'complete') {
                    phaseEl.textContent = 'Extraction complete';
                } else if (phase === 'reading_database') {
                    phaseEl.textContent = 'Reading database…';
                } else if (phase === 'capturing_thumbnails') {
                    phaseEl.textContent = `Rendering thumbnails (${count})…`;
                } else {
                    if (phase === 'scrolling' && extra.targetCount && count > 0) {
                        const pct = Math.min(100, Math.round((count / extra.targetCount) * 100));
                        phaseEl.textContent = `Scrolling chat DOM (${pct}%)`;
                    } else {
                        phaseEl.textContent = source === 'dom' ? 'Scrolling chat DOM…' : 'Reading database…';
                    }
                }
            }
        }
    }

    /* ── Extraction Core ── */

    async function executeExtraction(intent = null, format = 'txt') {
        const mode = document.querySelector('input[name="extractMode"]:checked').value;
        const selectedModel = $('aiModelSelect') ? $('aiModelSelect').value : 'auto';
        const customPrompt = $('customAiPrompt') ? $('customAiPrompt').value.trim() : '';

        const payload = {
            action: 'extract_chat',
            mode,
            intent,
            format,
            captureThumbnails: $('toggleThumbnails').checked,
            thumbnailSize: $('thumbnailResolution').value,
            enableAiCaptions: $('toggleAiCaptions').checked,
            enableAiTranscription: $('toggleAiTranscription') ? $('toggleAiTranscription').checked : true,
            geminiApiKey: $('geminiApiKey').value.trim(),
            maxAiRequests: parseInt($('maxAiRequests').value, 10) || 50,
            model: selectedModel === 'auto' ? null : selectedModel,
            customPrompt: customPrompt || null
        };

        if (mode === 'date') {
            const startVal = $('startTime').value;
            const endVal = $('endTime').value;
            if (!startVal || !endVal) {
                alert('Please provide start and end timestamps.');
                return null;
            }
            const startTime = new Date(startVal).getTime();
            const endTime = new Date(endVal).getTime();
            if (startTime > endTime) {
                alert('Start timestamp must be before end timestamp.');
                return null;
            }
            payload.start = startTime;
            payload.end = endTime;
            payload.startTime = startVal;
            payload.endTime = endVal;
        } else if (mode === 'count') {
            const count = parseInt($('messageCount').value, 10);
            if (!count || count <= 0) {
                alert('Invalid message count.');
                return null;
            }
            payload.count = count;
        }

        const tab = await getActiveTab();
        if (!tab || !tab.url || !tab.url.includes('web.whatsapp.com')) {
            alert('Please navigate to WhatsApp Web.');
            return null;
        }

        await ensureInjected(tab.id);
        const response = await sendTabMessage(tab.id, payload);

        if (response?.error) {
            console.warn('[WA-Exporter Popup] extraction error response:', response.error);
            alert(response.error);
            return null;
        }

        return response;
    }

    /* ── Formatters ── */

    function buildExportMetadata(messages, params = {}) {
        const chat = activeChatTitle || 'WhatsApp Chat';
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
            const count = params.messageCount || params.count || messages.length;
            scopeStr = `Last ${count} Messages`;
        } else {
            scopeStr = `All Messages (${messages.length.toLocaleString()})`;
        }

        return {
            chatName: chat,
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
            let content = m.content || '';
            if (m.aiCaption) {
                content += ` [AI: "${m.aiCaption}"]`;
            }
            if (m.aiTranscript) {
                content += ` [AI Transcript: "${m.aiTranscript}"]`;
            }
            if (m.rawFormat) {
                let text = m.rawFormat;
                if (m.aiCaption) text += ` [AI: "${m.aiCaption}"]`;
                if (m.aiTranscript) text += ` [AI Transcript: "${m.aiTranscript}"]`;
                return text;
            }
            return `[${new Date(m.timestamp).toLocaleTimeString()}] ${m.sender}: ${content}`;
        }).join('\n');

        return header + body;
    }

    function cleanMessageForExport(m, params = {}) {
        const includeThumbnails = params && params.captureThumbnails !== false;
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
        let str = String(val);
        if (/^[=+\-@]/.test(str)) {
            str = "'" + str;
        }
        str = str.replace(/"/g, '""');
        return `"${str}"`;
    }

    function formatAsCsv(messages, meta, params = {}) {
        const includeThumbnails = params && params.captureThumbnails !== false;
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

    function formatMessages(messages, format, params) {
        const meta = buildExportMetadata(messages, params);
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

    /* ── Export Actions (Copy / Download) ── */

    async function copyToClipboard(text) {
        try {
            await navigator.clipboard.writeText(text);
        } catch (e) {
            const ta = Object.assign(document.createElement('textarea'), { value: text });
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            ta.remove();
        }
    }

    function triggerDownload(filename, text, mime) {
        browser.runtime.sendMessage({ type: 'download_file', filename, text, mime }).then(res => {
            if (!res || !res.ok) throw new Error("Background download failed");
        }).catch(() => {
            const blob = new Blob([text], { type: mime });
            const url = URL.createObjectURL(blob);
            const a = Object.assign(document.createElement('a'), { href: url, download: filename });
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
        });
    }

    function generateFilename(ext) {
        const mode = document.querySelector('input[name="extractMode"]:checked').value;
        const cleanTitle = activeChatTitle.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 25) || 'chat';
        const ts = Date.now();

        if (mode === 'date') {
            const start = $('startTime').value.split('T')[0];
            const end = $('endTime').value.split('T')[0];
            return `WA_${cleanTitle}_${start}_to_${end}_${ts}.${ext}`;
        } else if (mode === 'count') {
            return `WA_${cleanTitle}_${$('messageCount').value}msgs_${ts}.${ext}`;
        }
        return `WA_${cleanTitle}_all_${ts}.${ext}`;
    }

    /* ── Main Action Handler ── */

    async function handleAction(action) {
        if (isExtracting) return;

        const copyBtn = $('copyBtn');
        const downloadBtn = $('downloadBtn');
        const origCopyText = copyBtn.innerHTML;
        const origDownloadText = downloadBtn.innerHTML;

        const format = document.querySelector('input[name="exportFormat"]:checked').value;
        const currentParams = getCurrentParams();

        // 1. If we already have valid cached extraction results matching current parameters, export immediately!
        if (cachedResult && cachedResult.data && cachedResult.data.length > 0 && areParamsEqual(cachedParams, currentParams)) {
            const formatted = formatMessages(cachedResult.data, format, currentParams);

            if (action === 'copy') {
                await copyToClipboard(formatted.text);
                copyBtn.innerHTML = '<span>✔️</span> Copied!';
            } else {
                const filename = generateFilename(formatted.ext);
                triggerDownload(filename, formatted.text, formatted.mime);
                downloadBtn.innerHTML = '<span>✔️</span> Downloaded!';
            }

            setTimeout(() => {
                copyBtn.innerHTML = origCopyText;
                downloadBtn.innerHTML = origDownloadText;
            }, 2500);
            return;
        }

        // 2. Otherwise, start a fresh extraction
        isExtracting = true;
        copyBtn.disabled = true;
        downloadBtn.disabled = true;

        setProgressVisible(true);
        updateProgress(0, 'starting');
        setStatus('Extracting messages…', true);

        try {
            const response = await executeExtraction(action, format);

            if (!response || !response.data) {
                setStatus('');
                return;
            }

            cachedResult = response;
            cachedParams = currentParams;

            const messages = response.data;
            const source = response.source || 'database';
            const isPartial = !!response.isPartial;

            if (!messages.length) {
                setStatus('No messages found for the selected filter.', false);
                return;
            }

            const formatted = formatMessages(messages, format, currentParams);

            if (action === 'copy') {
                await copyToClipboard(formatted.text);
                copyBtn.innerHTML = '<span>✔️</span> Copied!';
            } else {
                const filename = generateFilename(formatted.ext);
                triggerDownload(filename, formatted.text, formatted.mime);
                downloadBtn.innerHTML = '<span>✔️</span> Downloaded!';
            }

            const sourceMsg = source === 'database' ? 'via database' : 'via DOM scroll';
            const partialNotice = isPartial ? ' (partial)' : '';
            setStatus(`Done: ${messages.length.toLocaleString()} messages exported ${sourceMsg}${partialNotice}.`, false);
        } catch (err) {
            console.error('[WA-Exporter Popup] extraction execution failed:', err);
            setStatus('An error occurred during extraction.', false);
        } finally {
            isExtracting = false;
            setProgressVisible(false);

            setTimeout(() => {
                copyBtn.innerHTML = origCopyText;
                downloadBtn.innerHTML = origDownloadText;
                copyBtn.disabled = false;
                downloadBtn.disabled = false;
            }, 3000);
        }
    }

    async function handleCancel() {
        try {
            const tab = await getActiveTab();
            if (tab?.id) {
                await sendTabMessage(tab.id, { action: 'cancel_extraction' });
            }
            setStatus('Cancelling… returning collected messages.', true);
        } catch (e) {
            console.warn('[WA-Exporter Popup] cancel error:', e);
        }
    }

    /* ── Event Listeners ── */

    $('copyBtn').addEventListener('click', () => handleAction('copy'));
    $('downloadBtn').addEventListener('click', () => handleAction('download'));
    $('cancelBtn').addEventListener('click', handleCancel);
})();
