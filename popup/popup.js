(function () {
    'use strict';

    // Popup view and wiring. Settings and the request contract: settings.js; talking to the
    // WhatsApp tab: session.js; texts: _locales via i18n.js.

    if (typeof browser === 'undefined') {
        window.browser = chrome;
    }

    const { Settings, Session, I18n, Formatters } = window.WAExporter;
    const { t, plural } = I18n;
    const $ = (id) => document.getElementById(id);

    const MESSAGE_PHASES = new Set(['starting', 'wajs_loading', 'wajs_paging', 'wajs_sync_older', 'engine_fallback', 'scrolling', 'syncing_phone']);

    const ui = {
        settings: null,
        tabId: null,
        chatTitle: null,
        busy: false,
        ownRequest: false,
        cache: null,           // { key, request, result }
        messagesRead: 0,
        targetCount: null
    };

    /* ── Rendering ── */

    function render() {
        const s = ui.settings;
        document.querySelectorAll('input[name="extractMode"]').forEach(r => { r.checked = r.value === s.extractMode; });
        document.querySelectorAll('input[name="exportFormat"]').forEach(r => { r.checked = r.value === s.exportFormat; });
        $('messageCount').value = s.messageCount;
        $('startTime').value = s.startTime;
        $('endTime').value = s.endTime;
        $('captureThumbnails').checked = s.captureThumbnails;
        $('syncOlderFromPhone').checked = s.syncOlderFromPhone;
        $('downloadMissingMedia').checked = s.downloadMissingMedia;
        renderDependent();
    }

    // Everything that depends on other values: visibility, notes, labels.
    function renderDependent() {
        const s = ui.settings;
        $('dateFields').hidden = s.extractMode !== 'date';

        const aiReady = Settings.hasAi(s);
        const ai = $('enableAiCaptions');
        ai.disabled = !aiReady;
        ai.checked = aiReady && s.enableAiCaptions;
        $('aiMissing').hidden = aiReady;
        $('aiNote').hidden = !ai.checked;

        const fast = s.extractEngine !== 'dom';
        document.querySelectorAll('.wajs-only').forEach(el => { el.hidden = !fast; });
        $('olderNote').hidden = !s.syncOlderFromPhone;
        $('mediaNote').hidden = !s.downloadMissingMedia;
        $('mediaNote').textContent = t('incMediaNote', [I18n.num(s.maxMediaDownloads), I18n.num(s.mediaMaxAgeDays)]);

        const usesNetwork = ai.checked || (fast && (s.syncOlderFromPhone || s.downloadMissingMedia));
        $('trust').textContent = t(usesNetwork ? 'trustNetwork' : 'trustLocal');
        $('downloadBtn').textContent = t('downloadAs', s.exportFormat.toUpperCase());
    }

    function setChat(title, metaKey) {
        $('chatName').textContent = title || t('noChatTitle');
        $('chatMeta').textContent = t(metaKey);
    }

    function setStatus(text, detail = '', isError = false) {
        const el = $('status');
        el.textContent = '';
        el.classList.toggle('error', isError);
        if (!text) return;
        el.append(text);
        if (detail) {
            const d = document.createElement('span');
            d.className = 'status-detail';
            d.textContent = detail;
            el.append(d);
        }
    }

    function setActionsEnabled(enabled) {
        $('downloadBtn').disabled = !enabled;
        $('copyBtn').disabled = !enabled;
    }

    function setBusy(busy) {
        ui.busy = busy;
        $('actions').hidden = busy;
        $('progress').hidden = !busy;
        if (busy) {
            ui.messagesRead = 0;
            setStatus('');
            showProgress({ count: 0, phase: 'starting' });
        }
    }

    function phaseText(phase, count, total) {
        switch (phase) {
            case 'starting': return t('phStarting');
            case 'wajs_loading': return t('phLoading');
            case 'wajs_media': return total ? t('phMediaCache', [I18n.num(count), I18n.num(total)]) : t('phReading');
            case 'wajs_media_download': return t('phMediaDownload', [I18n.num(count), I18n.num(total || count)]);
            case 'wajs_sync_older': return t('phOlder');
            case 'engine_fallback': return t('phFallback');
            case 'scrolling': return t('phScrolling');
            case 'syncing_phone': return t('phPhone');
            case 'capturing_thumbnails': return t('phThumbnails');
            case 'ai_captioning': return t('phAiImages', [I18n.num(count), I18n.num(total || count)]);
            case 'ai_transcription': return t('phAiAudio', [I18n.num(count), I18n.num(total || count)]);
            default: return t('phReading');
        }
    }

    function showProgress({ count = 0, phase = 'starting', total = null }) {
        if (MESSAGE_PHASES.has(phase)) ui.messagesRead = Math.max(ui.messagesRead, count || 0);
        $('progressCount').textContent = I18n.num(ui.messagesRead);
        $('progressUnit').textContent = t(ui.messagesRead === 1 ? 'counter_one' : 'counter_other');
        $('progressPhase').textContent = phaseText(phase, count, total);

        // Determinate when there is a known end: media/AI totals, or "last N" messages.
        let fraction = null;
        if (total) fraction = Math.min(1, count / total);
        else if (MESSAGE_PHASES.has(phase) && ui.targetCount) fraction = Math.min(1, ui.messagesRead / ui.targetCount);
        const bar = $('progressBar');
        bar.classList.toggle('indeterminate', fraction === null);
        $('progressFill').style.width = fraction === null ? '' : `${Math.round(fraction * 100)}%`;
        if (fraction === null) bar.removeAttribute('aria-valuenow');
        else bar.setAttribute('aria-valuenow', String(Math.round(fraction * 100)));
    }

    /* ── Results ── */

    function resultDetail(result) {
        const notes = [];
        if (result.stopReason === 'aborted') notes.push(t('partialCancelled'));
        else if (result.isPartial && result.olderSync && result.olderSync.skipped === 'disabled' && result.data.length) {
            notes.push(t('partialOlder', I18n.shortDate(result.data[0].timestamp)));
        } else if (result.isPartial) notes.push(t('partialGeneric'));
        if (result.fallbackReason) notes.push(t('usedClassic'));
        return notes.join(' ');
    }

    function formatterParams(request) {
        return {
            mode: request.mode,
            startTime: request.startTime,
            endTime: request.endTime,
            count: request.count,
            messageCount: request.count,
            captureThumbnails: request.captureThumbnails
        };
    }

    async function deliver(cacheEntry, action) {
        const { request, result } = cacheEntry;
        const format = ui.settings.exportFormat;
        const params = formatterParams(request);
        const formatted = Formatters.formatMessages(result.data, format, params, ui.chatTitle, result);
        if (action === 'copy') {
            await Session.copyToClipboard(formatted.text);
        } else {
            Session.download(Formatters.generateFilename(ui.chatTitle, params, formatted.ext), formatted.text, formatted.mime);
        }
        setStatus(plural(action === 'copy' ? 'doneCopied' : 'doneDownloaded', result.data.length), resultDetail(result));
    }

    /* ── Export ── */

    async function run(action) {
        if (ui.busy || !ui.tabId) return;
        let request;
        try {
            request = Settings.buildRequest(ui.settings, { intent: action });
        } catch (e) {
            setStatus(t(e.i18nKey || 'errCount'), '', true);
            return;
        }
        const key = Settings.keyOfRequest(ui.chatTitle, request);
        if (ui.cache && ui.cache.key === key && ui.cache.result.data.length) {
            await deliver(ui.cache, action);
            return;
        }

        ui.targetCount = request.mode === 'count' ? request.count : null;
        ui.ownRequest = true;
        setBusy(true);
        try {
            const result = await Session.extract(ui.tabId, request);
            setBusy(false);
            if (!result || result.error || !result.data) {
                setStatus(t('errExtraction', (result && result.error) || '—'), '', true);
                return;
            }
            ui.cache = { key, request, result };
            if (!result.data.length) {
                setStatus(t('noMessages'), resultDetail(result));
                return;
            }
            await deliver(ui.cache, action);
        } catch (e) {
            setBusy(false);
            setStatus(t('errExtraction', e.message), '', true);
        } finally {
            ui.ownRequest = false;
        }
    }

    async function cancel() {
        if (!ui.tabId) return;
        $('progressPhase').textContent = t('cancelling');
        try {
            await Session.cancel(ui.tabId);
        } catch (e) { }
    }

    /* ── Wiring ── */

    function persist(patch) {
        Object.assign(ui.settings, patch);
        Settings.save(patch);
        renderDependent();
    }

    function bind() {
        document.querySelectorAll('input[name="extractMode"]').forEach(r => r.addEventListener('change', () => persist({ extractMode: r.value })));
        document.querySelectorAll('input[name="exportFormat"]').forEach(r => r.addEventListener('change', () => persist({ exportFormat: r.value })));

        // Typing a count or a date selects its option.
        $('messageCount').addEventListener('focus', () => { if (ui.settings.extractMode !== 'count') { persist({ extractMode: 'count' }); render(); } });
        $('messageCount').addEventListener('change', (e) => persist({ messageCount: parseInt(e.target.value, 10) || Settings.DEFAULTS.messageCount }));
        $('startTime').addEventListener('change', (e) => persist({ startTime: e.target.value }));
        $('endTime').addEventListener('change', (e) => persist({ endTime: e.target.value }));

        $('captureThumbnails').addEventListener('change', (e) => persist({ captureThumbnails: e.target.checked }));
        $('enableAiCaptions').addEventListener('change', (e) => persist({ enableAiCaptions: e.target.checked }));
        $('syncOlderFromPhone').addEventListener('change', (e) => persist({ syncOlderFromPhone: e.target.checked }));
        $('downloadMissingMedia').addEventListener('change', (e) => persist({ downloadMissingMedia: e.target.checked }));

        $('exportForm').addEventListener('submit', (e) => { e.preventDefault(); run('download'); });
        $('copyBtn').addEventListener('click', () => run('copy'));
        $('cancelBtn').addEventListener('click', cancel);

        const openOptions = () => browser.runtime.openOptionsPage();
        $('openOptions').addEventListener('click', openOptions);
        $('aiSetup').addEventListener('click', openOptions);

        // Settings changed in the options page while the popup is open.
        browser.storage.onChanged.addListener((changes, area) => {
            if (area !== 'local') return;
            const patch = {};
            Object.keys(changes).forEach(k => { if (k in Settings.DEFAULTS) patch[k] = changes[k].newValue; });
            if (!Object.keys(patch).length) return;
            ui.settings = Settings.normalize(Object.assign({}, ui.settings, patch));
            renderDependent();
        });

        Session.onExtractionEvents({
            progress(msg) {
                if (!ui.busy) setBusy(true);
                showProgress({ count: msg.count, phase: msg.phase, total: msg.total });
            },
            async completed(result) {
                if (ui.ownRequest || !result || !result.data) return;
                setBusy(false);
                // The request that produced it lives in the tab's state.
                let request = null;
                try {
                    const state = await Session.getState(ui.tabId);
                    request = (state && state.request) || null;
                } catch (e) { }
                adoptBackgroundResult(result, request);
            },
            error(message) {
                if (ui.ownRequest) return;
                setBusy(false);
                setStatus(t('errExtraction', message || '—'), '', true);
            }
        });
    }

    // A result produced while the popup was closed (or by another popup): reuse it.
    function adoptBackgroundResult(result, request) {
        if (request) ui.cache = { key: Settings.keyOfRequest(ui.chatTitle, request), request, result };
        if (!result.data.length) return setStatus(t('noMessages'), resultDetail(result));
        setStatus(plural('doneReady', result.data.length), resultDetail(result));
    }

    async function connect() {
        setActionsEnabled(false);
        const res = await Session.connect();
        if (res.error) {
            setChat(null, res.error);
            return;
        }
        ui.tabId = res.tab.id;
        ui.chatTitle = res.info.chatName || t('noChatTitle');
        setChat(ui.chatTitle, 'metaReady');
        setActionsEnabled(true);

        try {
            const state = await Session.getState(ui.tabId);
            if (!state || (state.chatName && state.chatName !== ui.chatTitle)) return;
            if (state.status === 'extracting') {
                ui.targetCount = state.request && state.request.mode === 'count' ? state.request.count : null;
                setBusy(true);
                const p = state.progress || {};
                showProgress({ count: p.count || 0, phase: p.phase || 'wajs_paging' });
            } else if (state.status === 'completed' && state.result && state.result.data) {
                adoptBackgroundResult(state.result, state.request);
            }
        } catch (e) {
            console.warn('[WA-Exporter Popup] Could not read the extraction state:', e);
        }
    }

    document.addEventListener('DOMContentLoaded', async () => {
        I18n.apply();
        ui.settings = await Settings.load();
        render();
        bind();
        await connect();
    });
})();
