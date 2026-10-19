(function () {
    'use strict';

    window.WAExporter = window.WAExporter || {};

    // Paced, read-only pagination over the active chat through the WA-JS host.
    // Rate must stay at or below the DOM auto-scroll (~15-20 msgs/s).
    const PACING = {
        pageSize: 40,
        pauseMinMs: 1500,
        pauseMaxMs: 2500,
        longPauseEvery: 25,
        longPauseMinMs: 5000,
        longPauseMaxMs: 8000,
        maxConsecutiveErrors: 2
    };

    // Media comes from local caches only (no network), but reads are still spaced out.
    const MEDIA_PACING = { minMs: 200, maxMs: 400 };
    const THUMBNAIL_TYPES = ['image', 'video', 'gif', 'sticker'];
    const AUDIO_TYPES = ['ptt', 'audio'];
    const MAX_AUDIO_SECONDS = 300;

    // Network tier (opt-in): same call as WhatsApp's "Download" button. Media older than
    // maxAgeDays is never requested; expired media makes WhatsApp ask the sender to re-upload.
    const NETWORK_PACING = { minMs: 2000, maxMs: 4000 };
    const NETWORK_TYPES = ['image', 'sticker', 'ptt', 'audio'];
    const NETWORK_DEFAULTS = { maxAgeDays: 14, maxDownloads: 30 };
    const NETWORK_MAX_AGE_LIMIT = 30;

    // WhatsApp launched in 2009; anything older is a broken timestamp and must not
    // drive the date-range stop.
    const MIN_PLAUSIBLE_T = 1230768000;

    class WajsUnavailable extends Error {
        constructor(reason) {
            super('WA-JS unavailable: ' + reason);
            this.name = 'WajsUnavailable';
            this.reason = reason;
        }
    }

    class WajsMidRunError extends Error {
        constructor(message, partial) {
            super(message);
            this.name = 'WajsMidRunError';
            this.partial = partial;
        }
    }

    function randomBetween(min, max) {
        return min + Math.floor(Math.random() * (max - min + 1));
    }

    function abortableSleep(ms, signal) {
        return new Promise((resolve, reject) => {
            if (signal && signal.aborted) return reject(new Error('Aborted'));
            const timer = setTimeout(() => {
                if (signal) signal.removeEventListener('abort', onAbort);
                resolve();
            }, ms);
            const onAbort = () => {
                clearTimeout(timer);
                reject(new Error('Aborted'));
            };
            if (signal) signal.addEventListener('abort', onAbort, { once: true });
        });
    }

    function pauseFor(pageNumber) {
        if (pageNumber % PACING.longPauseEvery === 0) {
            return randomBetween(PACING.longPauseMinMs, PACING.longPauseMaxMs);
        }
        return randomBetween(PACING.pauseMinMs, PACING.pauseMaxMs);
    }

    /**
     * Runs a WA-JS extraction for the active chat.
     * Resolves to { messages, isPartial, stopReason, engine, pages, waVersion, wajsVersion }.
     * Throws WajsUnavailable when WA-JS cannot be used (caller falls back to DOM),
     * or WajsMidRunError with the messages collected so far.
     * The host stays open for enrichMedia(); callers must call release() afterwards.
     */
    async function run(request, signal, onProgress = () => { }) {
        const Wajs = window.WAExporter.Wajs;
        const Mapper = window.WAExporter.WajsMapper;
        if (!Wajs || !Mapper) throw new WajsUnavailable('client_not_loaded');
        if (request.debugForceWajsFailure === 'unavailable') throw new WajsUnavailable('debug_forced');

        onProgress(0, 'wajs_loading');
        try {
            await Wajs.ensureInjected();
        } catch (e) {
            throw new WajsUnavailable('inject_failed: ' + e.message);
        }

        let health;
        try {
            health = await Wajs.call('wajs_health', { expectedChatTitle: request.expectedChatTitle || null });
        } catch (e) {
            throw new WajsUnavailable('health_error: ' + e.message);
        }
        if (!health || !health.ok) throw new WajsUnavailable((health && health.reason) || 'unknown');

        const mode = request.mode || 'all';
        const targetCount = request.count || 100;
        const startDate = request.start || 0;
        const endDate = request.end || Infinity;

        const chatId = health.chat.id;
        const ctx = {
            chatId,
            chatTitle: health.chat.title,
            isGroup: chatId.endsWith('@g.us'),
            selfJids: new Set()
        };

        const raws = new Map();
        let seq = 0;
        let anchor = null;
        let pages = 0;
        let errors = 0;
        let stopReason = null;
        let oldestT = Infinity;

        function collect() {
            const ordered = Array.from(raws.values()).sort((a, b) => (a.raw.t - b.raw.t) || (a.seq - b.seq));
            let messages = ordered.map(e => Mapper.mapMessage(e.raw, ctx)).filter(Boolean);
            if (mode === 'date') {
                messages = messages.filter(m => m.timestamp >= startDate && m.timestamp <= endDate);
            } else if (mode === 'count' && messages.length > targetCount) {
                messages = messages.slice(messages.length - targetCount);
            }
            return messages;
        }

        function exportableCount() {
            let n = 0;
            raws.forEach(e => {
                if (Mapper.EXCLUDED_TYPES.has(e.raw.type)) return;
                if (mode === 'date' && (e.raw.t * 1000 < startDate || e.raw.t * 1000 > endDate)) return;
                n++;
            });
            return n;
        }

        try {
            while (true) {
                if (signal && signal.aborted) {
                    stopReason = 'aborted';
                    break;
                }
                if (pages > 0 || errors > 0) await abortableSleep(pauseFor(Math.max(pages, 1)), signal);

                let page;
                try {
                    if (request.debugForceWajsFailure === 'midrun' && pages >= 1) throw new Error('debug_forced_midrun');
                    const params = { chatId, count: PACING.pageSize };
                    if (anchor) params.id = anchor;
                    page = await Wajs.call('wajs_get_messages', params);
                    errors = 0;
                } catch (e) {
                    if (signal && signal.aborted) {
                        stopReason = 'aborted';
                        break;
                    }
                    errors++;
                    console.warn(`[WA-Exporter WA-JS] Page request failed (${errors}/${PACING.maxConsecutiveErrors}):`, e.message);
                    if (errors >= PACING.maxConsecutiveErrors) throw new WajsMidRunError(e.message, collect());
                    continue;
                }
                pages++;

                if (!Array.isArray(page) || page.length === 0) {
                    stopReason = 'local_cache_boundary';
                    break;
                }

                // Pages come oldest-first in WhatsApp's own order, so the next anchor is the
                // first entry (not the smallest t: timestamps can be missing or out of order).
                // Later pages are older, so seq decreases per page.
                const base = -pages * (PACING.pageSize + 1);
                let fresh = 0;
                page.forEach((raw, i) => {
                    if (!raw || !raw.id || raws.has(raw.id)) return;
                    raws.set(raw.id, { raw, seq: base + i });
                    if (raw.fromMe && raw.author) ctx.selfJids.add(raw.author);
                    if (typeof raw.t === 'number' && raw.t >= MIN_PLAUSIBLE_T && raw.t < oldestT) oldestT = raw.t;
                    fresh++;
                });
                const first = page.find(raw => raw && raw.id);
                if (first) anchor = first.id;
                if (!fresh) {
                    stopReason = 'no_new_messages';
                    break;
                }

                const count = exportableCount();
                onProgress(count, 'wajs_paging');

                if (mode === 'count' && count >= targetCount) {
                    stopReason = 'target_count';
                    break;
                }
                if (mode === 'date' && oldestT * 1000 < startDate) {
                    stopReason = 'reached_start_date';
                    break;
                }
            }
        } catch (e) {
            if (e.message === 'Aborted') {
                stopReason = 'aborted';
            } else {
                throw e;
            }
        }

        const messages = collect();
        let isPartial = stopReason === 'aborted';
        if (mode === 'count' && messages.length < targetCount) isPartial = true;
        if (mode === 'date' && !(oldestT * 1000 < startDate)) isPartial = true;

        console.log(`[WA-Exporter WA-JS] ${messages.length} messages in ${pages} pages (stop: ${stopReason}${isPartial ? ', partial' : ''}).`);

        return {
            messages,
            isPartial,
            stopReason,
            engine: 'wajs',
            pages,
            waVersion: health.waVersion,
            wajsVersion: health.wajsVersion
        };
    }

    /**
     * Fills thumbnails and voice-note audio for WA-JS messages from local sources only
     * (thumbnail fields and WhatsApp's media caches). Updates m.media.status:
     * 'thumbnail' | 'cached' | 'not_downloaded' | 'error'.
     * With opts.network.enabled, media still missing afterwards is downloaded (recent only,
     * capped, paced, stopping at the first expired/failed item): adds 'downloaded' | 'expired'.
     * opts: { thumbnails, audio, maxSize, network: { enabled, maxAgeDays, maxDownloads } }
     */
    async function enrichMedia(messages, opts, signal, onProgress = () => { }) {
        const Wajs = window.WAExporter.Wajs;
        const stats = { thumbnails: 0, audio: 0, notCached: 0, errors: 0, sources: {} };
        const work = (messages || []).filter(m => m && m.engine === 'wajs' && m.media && (
            (opts.thumbnails && THUMBNAIL_TYPES.includes(m.type) && !m.thumbnail) ||
            (opts.audio && AUDIO_TYPES.includes(m.type) && !m.audioData && !(m.duration > MAX_AUDIO_SECONDS))
        ));

        for (let i = 0; i < work.length; i++) {
            if (signal && signal.aborted) throw new Error('Aborted');
            if (i > 0) await abortableSleep(randomBetween(MEDIA_PACING.minMs, MEDIA_PACING.maxMs), signal);
            const m = work[i];
            onProgress(i + 1, 'wajs_media', work.length);
            try {
                const isAudio = AUDIO_TYPES.includes(m.type);
                const res = isAudio
                    ? await Wajs.call('wajs_media_audio', { id: m.id })
                    : await Wajs.call('wajs_media_thumbnail', { id: m.id, maxSize: opts.maxSize || 160 });
                if (res && res.dataUri) {
                    if (isAudio) {
                        m.audioData = res.dataUri;
                        m.media.status = 'cached';
                        stats.audio++;
                    } else {
                        m.thumbnail = res.dataUri;
                        m.media.status = 'thumbnail';
                        stats.thumbnails++;
                    }
                    stats.sources[res.source] = (stats.sources[res.source] || 0) + 1;
                } else {
                    stats.notCached++;
                }
            } catch (e) {
                if (signal && signal.aborted) throw new Error('Aborted');
                m.media.status = 'error';
                m.media.error = e.message;
                stats.errors++;
            }
        }
        console.log(`[WA-Exporter WA-JS] Media from local caches: ${stats.thumbnails} thumbnails, ${stats.audio} audio, ${stats.notCached} not cached, ${stats.errors} errors.`);

        if (opts.network && opts.network.enabled) {
            stats.network = await downloadMissing(work, opts, signal, onProgress);
        }
        return stats;
    }

    async function downloadMissing(work, opts, signal, onProgress) {
        const Wajs = window.WAExporter.Wajs;
        const maxAgeDays = Math.min(Math.max(1, parseInt(opts.network.maxAgeDays, 10) || NETWORK_DEFAULTS.maxAgeDays), NETWORK_MAX_AGE_LIMIT);
        const maxDownloads = Math.max(0, parseInt(opts.network.maxDownloads, 10) || NETWORK_DEFAULTS.maxDownloads);
        const minTimestamp = Date.now() - maxAgeDays * 86400000;
        const net = { attempted: 0, downloaded: 0, expired: 0, errors: 0, tooOld: 0, overLimit: 0, stoppedBy: null };

        const missing = work.filter(m => m.media.status === 'not_downloaded' && NETWORK_TYPES.includes(m.type) &&
            (AUDIO_TYPES.includes(m.type) ? opts.audio : opts.thumbnails));
        const recent = missing.filter(m => typeof m.timestamp === 'number' && m.timestamp >= minTimestamp);
        net.tooOld = missing.length - recent.length;
        const queue = recent.slice(-maxDownloads); // newest first within the cap
        net.overLimit = recent.length - queue.length;

        for (let i = queue.length - 1; i >= 0; i--) {
            if (signal && signal.aborted) throw new Error('Aborted');
            if (net.attempted > 0) await abortableSleep(randomBetween(NETWORK_PACING.minMs, NETWORK_PACING.maxMs), signal);
            const m = queue[i];
            const isAudio = AUDIO_TYPES.includes(m.type);
            net.attempted++;
            onProgress(net.attempted, 'wajs_media_download', queue.length);
            let res;
            try {
                res = await Wajs.call('wajs_media_download', {
                    id: m.id, allowNetwork: true, want: isAudio ? 'audio' : 'thumbnail',
                    maxAgeDays, maxSize: opts.maxSize || 160
                });
            } catch (e) {
                if (signal && signal.aborted) throw new Error('Aborted');
                res = { status: 'error', reason: e.message };
            }
            if (res.dataUri) {
                if (isAudio) m.audioData = res.dataUri;
                else m.thumbnail = res.dataUri;
            }
            m.media.status = res.status;
            if (res.reason && (res.status === 'expired' || res.status === 'error')) m.media.error = res.reason;
            if (res.status === 'expired') net.expired++;
            else if (res.status === 'error') net.errors++;
            else if (res.status !== 'not_downloaded') net.downloaded++;
            // Stop at the first expired or failed item: older ones are likely expired too.
            if (res.status === 'expired' || res.status === 'error') {
                net.stoppedBy = res.status;
                break;
            }
        }
        console.log(`[WA-Exporter WA-JS] Network media: ${net.downloaded} downloaded, ${net.expired} expired, ${net.errors} errors, ${net.tooOld} too old, ${net.overLimit} over limit${net.stoppedBy ? ', stopped by ' + net.stoppedBy : ''}.`);
        return net;
    }

    function release() {
        const Wajs = window.WAExporter.Wajs;
        if (!Wajs) return Promise.resolve();
        return Wajs.call('wajs_release').catch(() => { });
    }

    window.WAExporter.WajsEngine = { run, enrichMedia, release, PACING, MEDIA_PACING, NETWORK_PACING, WajsUnavailable, WajsMidRunError };
})();
