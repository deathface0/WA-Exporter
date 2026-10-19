(function () {
    'use strict';

    // Shared by the popup and the options page. Storage keys are the v2/v3 ones, so existing
    // settings carry over; buildRequest() produces the extract_chat payload main.js expects.

    const root = typeof window !== 'undefined' ? window : globalThis;
    root.WAExporter = root.WAExporter || {};

    const pad = n => n.toString().padStart(2, '0');

    const DEFAULTS = {
        // Per export (popup)
        extractMode: 'count',
        messageCount: 100,
        startTime: '',
        endTime: '',
        exportFormat: 'txt',
        captureThumbnails: true,
        enableAiCaptions: false,      // "Use Gemini" for this export (master switch)
        syncOlderFromPhone: false,
        downloadMissingMedia: false,
        // Set once (options page)
        extractEngine: 'auto',
        thumbnailResolution: '160',
        mediaMaxAgeDays: 14,
        maxMediaDownloads: 30,
        geminiApiKey: '',
        aiModelPreference: 'auto',
        maxAiRequests: 50,
        customAiPrompt: '',
        aiDescribeImages: true,
        enableAiTranscription: true
    };

    const MODES = ['count', 'date', 'all'];
    const FORMATS = ['txt', 'json', 'csv'];
    const RESOLUTIONS = ['120', '160', '256'];
    const MEDIA_AGE_LIMIT = 30;

    // 'wajs' (v3.0 betas) is stored for some users; it always meant WA-JS with DOM fallback.
    function normalizeEngine(value) {
        return value === 'dom' ? 'dom' : 'auto';
    }

    function clampInt(value, min, max, fallback) {
        const n = parseInt(value, 10);
        if (!Number.isFinite(n)) return fallback;
        return Math.min(max, Math.max(min, n));
    }

    function formatLocalDatetime(date) {
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    /** Stored values merged over the defaults, with types and ranges fixed. */
    function normalize(stored, now = new Date()) {
        const s = Object.assign({}, DEFAULTS);
        Object.keys(DEFAULTS).forEach(k => {
            if (stored && stored[k] !== undefined && stored[k] !== null) s[k] = stored[k];
        });
        s.extractMode = MODES.includes(s.extractMode) ? s.extractMode : DEFAULTS.extractMode;
        s.exportFormat = FORMATS.includes(s.exportFormat) ? s.exportFormat : DEFAULTS.exportFormat;
        s.extractEngine = normalizeEngine(s.extractEngine);
        s.thumbnailResolution = RESOLUTIONS.includes(String(s.thumbnailResolution)) ? String(s.thumbnailResolution) : DEFAULTS.thumbnailResolution;
        s.messageCount = clampInt(s.messageCount, 1, 1000000, DEFAULTS.messageCount);
        s.mediaMaxAgeDays = clampInt(s.mediaMaxAgeDays, 1, MEDIA_AGE_LIMIT, DEFAULTS.mediaMaxAgeDays);
        s.maxMediaDownloads = clampInt(s.maxMediaDownloads, 1, 100, DEFAULTS.maxMediaDownloads);
        s.maxAiRequests = clampInt(s.maxAiRequests, 1, 500, DEFAULTS.maxAiRequests);
        s.geminiApiKey = String(s.geminiApiKey || '').trim();
        s.customAiPrompt = String(s.customAiPrompt || '');
        ['captureThumbnails', 'enableAiCaptions', 'syncOlderFromPhone', 'downloadMissingMedia',
            'aiDescribeImages', 'enableAiTranscription'].forEach(k => { s[k] = !!s[k]; });
        if (!s.startTime) s.startTime = formatLocalDatetime(new Date(now.getTime() - 86400000));
        if (!s.endTime) s.endTime = formatLocalDatetime(now);
        return s;
    }

    function storageArea() {
        const api = root.browser || root.chrome;
        return api && api.storage && api.storage.local;
    }

    async function load() {
        let stored = {};
        try {
            stored = await storageArea().get(Object.keys(DEFAULTS));
        } catch (e) { }
        return normalize(stored);
    }

    function save(patch) {
        try {
            return storageArea().set(patch);
        } catch (e) {
            return Promise.resolve();
        }
    }

    function hasAi(s) {
        return !!s.geminiApiKey;
    }

    /**
     * Scope fields of the request, or an error key (i18n) when the scope cannot run.
     */
    function scopeOf(s) {
        if (s.extractMode === 'date') {
            const start = new Date(s.startTime).getTime();
            const end = new Date(s.endTime).getTime();
            if (!Number.isFinite(start) || !Number.isFinite(end)) return { error: 'errDatesMissing' };
            if (start > end) return { error: 'errDatesOrder' };
            return { fields: { start, end, startTime: s.startTime, endTime: s.endTime } };
        }
        if (s.extractMode === 'count') {
            const count = parseInt(s.messageCount, 10);
            if (!count || count < 1) return { error: 'errCount' };
            return { fields: { count } };
        }
        return { fields: {} };
    }

    /** extract_chat payload (the contract with extraction/main.js). Throws { i18nKey } on invalid scope. */
    function buildRequest(s, { intent = null, format = s.exportFormat } = {}) {
        const scope = scopeOf(s);
        if (scope.error) {
            const err = new Error(scope.error);
            err.i18nKey = scope.error;
            throw err;
        }
        const ai = s.enableAiCaptions && hasAi(s);
        return Object.assign({
            action: 'extract_chat',
            mode: s.extractMode,
            intent,
            format,
            captureThumbnails: s.captureThumbnails,
            thumbnailSize: s.thumbnailResolution,
            enableAiCaptions: ai && s.aiDescribeImages,
            enableAiTranscription: ai && s.enableAiTranscription,
            geminiApiKey: ai ? s.geminiApiKey : '',
            maxAiRequests: s.maxAiRequests,
            model: s.aiModelPreference === 'auto' ? null : s.aiModelPreference,
            customPrompt: s.customAiPrompt.trim() || null,
            engine: s.extractEngine,
            downloadMissingMedia: s.extractEngine !== 'dom' && s.downloadMissingMedia,
            mediaMaxAgeDays: s.mediaMaxAgeDays,
            maxMediaDownloads: s.maxMediaDownloads,
            syncOlderFromPhone: s.extractEngine !== 'dom' && s.syncOlderFromPhone
        }, scope.fields);
    }

    /**
     * Identity of an extraction for reuse: same chat and same request, format and intent aside
     * (formatting happens in the popup). Works for a request rebuilt from the background state.
     */
    function keyOfRequest(chatTitle, req) {
        if (!req) return null;
        const rest = Object.assign({}, req);
        delete rest.action;
        delete rest.intent;
        delete rest.format;
        const ordered = {};
        Object.keys(rest).sort().forEach(k => { ordered[k] = rest[k]; });
        return JSON.stringify([chatTitle || '', ordered]);
    }

    /** keyOfRequest() for the current settings, or null when the scope is invalid. */
    function requestKey(chatTitle, s) {
        try {
            return keyOfRequest(chatTitle, buildRequest(s));
        } catch (e) {
            return null;
        }
    }

    root.WAExporter.Settings = {
        DEFAULTS,
        MEDIA_AGE_LIMIT,
        normalize,
        normalizeEngine,
        formatLocalDatetime,
        load,
        save,
        hasAi,
        scopeOf,
        buildRequest,
        keyOfRequest,
        requestKey
    };
})();
