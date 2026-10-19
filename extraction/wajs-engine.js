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

                // Pages come oldest-first; later pages are older, so seq decreases per page.
                const base = -pages * (PACING.pageSize + 1);
                let fresh = 0;
                page.forEach((raw, i) => {
                    if (!raw || !raw.id || raws.has(raw.id)) return;
                    raws.set(raw.id, { raw, seq: base + i });
                    if (raw.fromMe && raw.author) ctx.selfJids.add(raw.author);
                    if (raw.t < oldestT) {
                        oldestT = raw.t;
                        anchor = raw.id;
                    }
                    fresh++;
                });
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
        } finally {
            Wajs.call('wajs_release').catch(() => { });
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

    window.WAExporter.WajsEngine = { run, PACING, WajsUnavailable, WajsMidRunError };
})();
