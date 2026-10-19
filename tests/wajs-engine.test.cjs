// Engine pagination against a fake host (synthetic data, no pauses).
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScripts } = require('./helpers.cjs');

const GROUP = '100000000000-1600000000@g.us';
const SELF = '111@lid';

// 100 messages, one per minute, oldest first; a few excluded system entries.
function makeHistory(n = 100) {
    const base = 1760000000;
    return Array.from({ length: n }, (_, i) => ({
        id: `true_${GROUP}_M${String(i).padStart(4, '0')}_${SELF}`,
        t: base + i * 60,
        type: i % 25 === 0 ? 'pinned_message' : 'chat',
        fromMe: true, author: SELF, from: GROUP, body: `m${i}`, mentionedJidList: [], pollOptions: []
    }));
}

function setup({ history = makeHistory(), health = null, failFrom = Infinity } = {}) {
    const W = loadScripts('extraction/wajs-mapper.js', 'extraction/wajs-engine.js');
    Object.assign(W.WajsEngine.PACING, { pauseMinMs: 0, pauseMaxMs: 0, longPauseMinMs: 0, longPauseMaxMs: 0 });
    Object.assign(W.WajsEngine.MEDIA_PACING, { minMs: 0, maxMs: 0 });
    Object.assign(W.WajsEngine.NETWORK_PACING, { minMs: 0, maxMs: 0 });
    const calls = [];
    W.Wajs = {
        ensureInjected: async () => ({ ok: true }),
        call: async (action, params) => {
            calls.push({ action, params });
            if (action === 'wajs_health') {
                return health || { ok: true, chat: { id: GROUP, title: 'G' }, waVersion: 'wa', wajsVersion: '4.6.1' };
            }
            if (action === 'wajs_release') return { released: true };
            if (action === 'wajs_media_thumbnail') {
                if (params.id === 'boom') throw new Error('read_failed');
                return params.id.startsWith('cached') ? { dataUri: 'data:image/webp;base64,AA', source: 'cache:lru' } : { dataUri: null, source: null };
            }
            if (action === 'wajs_media_download') {
                if (params.allowNetwork !== true) throw new Error('Network download not allowed');
                if (params.id.startsWith('expired')) return { status: 'expired', reason: 'REUPLOADING' };
                return params.want === 'audio'
                    ? { status: 'cached', dataUri: 'data:audio/ogg;base64,NET', source: 'network' }
                    : { status: 'thumbnail', dataUri: 'data:image/webp;base64,NET', source: 'network' };
            }
            if (action === 'wajs_media_audio') {
                return params.id.startsWith('cached') ? { dataUri: 'data:audio/ogg;base64,AA', source: 'cache:lru' } : { dataUri: null, reason: 'not_cached' };
            }
            if (action === 'wajs_get_messages') {
                if (calls.filter(c => c.action === 'wajs_get_messages').length > failFrom) throw new Error('boom');
                const end = params.id ? history.findIndex(m => m.id === params.id) : history.length;
                return history.slice(Math.max(0, end - params.count), end);
            }
            throw new Error('unexpected ' + action);
        }
    };
    return { W, calls };
}

const plain = v => JSON.parse(JSON.stringify(v));

test('all: pages until the local cache boundary, excludes system entries, keeps order', async () => {
    const { W, calls } = setup();
    const res = plain(await W.WajsEngine.run({ mode: 'all' }, null));
    assert.equal(res.stopReason, 'local_cache_boundary');
    assert.equal(res.isPartial, false);
    assert.equal(res.messages.length, 96);
    const ts = res.messages.map(m => m.timestamp);
    assert.deepEqual(ts, [...ts].sort((a, b) => a - b));
    const pages = calls.filter(c => c.action === 'wajs_get_messages');
    assert.ok(pages.every(c => c.params.count === 40), 'page size 40, never -1');
    assert.equal(pages[0].params.id, undefined);
    assert.equal(pages[1].params.id, `true_${GROUP}_M0060_${SELF}`);
    assert.ok(!calls.some(c => c.action === 'wajs_release'), 'run() keeps the host open for enrichMedia');
    await W.WajsEngine.release();
    assert.ok(calls.some(c => c.action === 'wajs_release'));
});

test('count: stops as soon as N exportable messages are collected', async () => {
    const { W, calls } = setup();
    const res = plain(await W.WajsEngine.run({ mode: 'count', count: 30 }, null));
    assert.equal(res.stopReason, 'target_count');
    assert.equal(res.messages.length, 30);
    assert.equal(res.messages[29].content, 'm99');
    assert.equal(calls.filter(c => c.action === 'wajs_get_messages').length, 1);
});

test('count larger than history is partial', async () => {
    const { W } = setup();
    const res = await W.WajsEngine.run({ mode: 'count', count: 500 }, null);
    assert.equal(res.isPartial, true);
});

test('date: filters the range and stops once past the start', async () => {
    const { W } = setup();
    const base = 1760000000 * 1000;
    const res = plain(await W.WajsEngine.run({ mode: 'date', start: base + 70 * 60000, end: base + 80 * 60000 }, null));
    assert.equal(res.stopReason, 'reached_start_date');
    assert.equal(res.isPartial, false);
    assert.equal(res.messages.length, 10); // 70..80 minus pinned at 75
    assert.ok(res.messages.every(m => m.timestamp >= base + 70 * 60000 && m.timestamp <= base + 80 * 60000));
});

test('abort returns collected messages as partial', async () => {
    const { W } = setup();
    const controller = new AbortController();
    controller.abort();
    const res = await W.WajsEngine.run({ mode: 'all' }, controller.signal);
    assert.equal(res.stopReason, 'aborted');
    assert.equal(res.isPartial, true);
});

test('unhealthy WA-JS throws WajsUnavailable with the reason', async () => {
    const { W } = setup({ health: { ok: false, reason: 'not_ready' } });
    await assert.rejects(W.WajsEngine.run({ mode: 'all' }, null), err => err.name === 'WajsUnavailable' && err.reason === 'not_ready');
    const forced = setup();
    await assert.rejects(forced.W.WajsEngine.run({ mode: 'all', debugForceWajsFailure: 'unavailable' }, null), err => err.reason === 'debug_forced');
});

test('two consecutive page failures throw WajsMidRunError with partial data', async () => {
    const { W } = setup({ failFrom: 1 });
    await assert.rejects(W.WajsEngine.run({ mode: 'all' }, null), err => err.name === 'WajsMidRunError' && err.partial.length === 39);
});

test('anchors on the first entry of each page, not on the smallest timestamp', async () => {
    const history = makeHistory();
    history[50] = Object.assign({}, history[50], { t: null }); // broken timestamp mid-history
    history[45] = Object.assign({}, history[45], { t: 5 });    // implausible 1970 timestamp
    const { W, calls } = setup({ history });
    const res = await W.WajsEngine.run({ mode: 'all' }, null);
    assert.equal(res.stopReason, 'local_cache_boundary');
    const pages = calls.filter(c => c.action === 'wajs_get_messages');
    assert.equal(pages[1].params.id, history[60].id);
    assert.equal(pages[2].params.id, history[20].id);
    const dateRes = await setup({ history }).W.WajsEngine.run({ mode: 'date', start: (1760000000 + 30 * 60) * 1000, end: Infinity }, null);
    assert.equal(dateRes.stopReason, 'reached_start_date');
    assert.equal(dateRes.isPartial, false);
});

function mediaMsg(id, type, extra = {}) {
    return Object.assign({ id, type, engine: 'wajs', thumbnail: null, duration: null,
        media: { mimetype: null, filename: null, size: null, duration: null, status: 'not_downloaded' } }, extra);
}

test('enrichMedia fills thumbnails and audio from local caches and sets statuses', async () => {
    const { W, calls } = setup();
    const msgs = [
        mediaMsg('cached-sticker', 'sticker'),
        mediaMsg('miss-image', 'image'),
        mediaMsg('has-thumb', 'image', { thumbnail: 'data:image/jpeg;base64,X' }),
        mediaMsg('cached-ptt', 'ptt', { duration: 8 }),
        mediaMsg('cached-long', 'audio', { duration: 301 }),
        mediaMsg('boom', 'sticker'),
        { id: 'dom-1', type: 'ptt', engine: 'dom' }
    ];
    const stats = plain(await W.WajsEngine.enrichMedia(msgs, { thumbnails: true, audio: true, maxSize: 120 }, null));
    assert.deepEqual(stats, { thumbnails: 1, audio: 1, notCached: 1, errors: 1, sources: { 'cache:lru': 2 } });
    assert.equal(msgs[0].media.status, 'thumbnail');
    assert.equal(msgs[0].thumbnail, 'data:image/webp;base64,AA');
    assert.equal(msgs[1].media.status, 'not_downloaded');
    assert.equal(msgs[3].media.status, 'cached');
    assert.equal(msgs[3].audioData, 'data:audio/ogg;base64,AA');
    assert.equal(msgs[4].audioData, undefined, 'over 5 minutes is skipped');
    assert.equal(msgs[5].media.status, 'error');
    const mediaCalls = calls.filter(c => c.action.startsWith('wajs_media'));
    assert.equal(mediaCalls.length, 4, 'skips existing thumbnails, long audio and DOM messages');
    assert.ok(mediaCalls.filter(c => c.action === 'wajs_media_thumbnail').every(c => c.params.maxSize === 120));
});

test('enrichMedia skips audio when transcription is off and honours abort', async () => {
    const { W, calls } = setup();
    await W.WajsEngine.enrichMedia([mediaMsg('cached-ptt', 'ptt')], { thumbnails: true, audio: false }, null);
    assert.equal(calls.filter(c => c.action === 'wajs_media_audio').length, 0);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(W.WajsEngine.enrichMedia([mediaMsg('cached-sticker', 'sticker')], { thumbnails: true }, controller.signal), /Aborted/);
});

const DAY = 86400000;
const netOpts = (extra = {}) => ({ thumbnails: true, audio: true, maxSize: 160, network: Object.assign({ enabled: true, maxAgeDays: 14, maxDownloads: 30 }, extra) });

test('network tier is off unless explicitly enabled', async () => {
    const { W, calls } = setup();
    await W.WajsEngine.enrichMedia([mediaMsg('miss-a', 'image', { timestamp: Date.now() - DAY })], { thumbnails: true, audio: true }, null);
    assert.equal(calls.filter(c => c.action === 'wajs_media_download').length, 0);
});

test('network tier downloads recent missing media, newest first, within the cap', async () => {
    const { W, calls } = setup();
    const now = Date.now();
    const msgs = [
        mediaMsg('miss-old', 'image', { timestamp: now - 40 * DAY }),
        mediaMsg('miss-1', 'image', { timestamp: now - 3 * DAY }),
        mediaMsg('miss-2', 'sticker', { timestamp: now - 2 * DAY }),
        mediaMsg('miss-3', 'ptt', { timestamp: now - 1 * DAY, duration: 5 }),
        mediaMsg('miss-video', 'video', { timestamp: now - 1 * DAY })
    ];
    const stats = plain(await W.WajsEngine.enrichMedia(msgs, netOpts({ maxDownloads: 2 }), null));
    const dl = calls.filter(c => c.action === 'wajs_media_download');
    assert.deepEqual(dl.map(c => c.params.id), ['miss-3', 'miss-2'], 'newest first, capped at 2, videos excluded');
    assert.ok(dl.every(c => c.params.allowNetwork === true && c.params.maxAgeDays === 14));
    assert.equal(msgs[3].media.status, 'cached');
    assert.equal(msgs[3].audioData, 'data:audio/ogg;base64,NET');
    assert.equal(msgs[2].media.status, 'thumbnail');
    assert.equal(msgs[1].media.status, 'not_downloaded', 'over the cap');
    assert.equal(msgs[0].media.status, 'not_downloaded', 'too old, never requested');
    assert.equal(stats.network.tooOld, 1);
    assert.equal(stats.network.overLimit, 1);
    assert.equal(stats.network.downloaded, 2);
});

test('network tier stops at the first expired item and clamps max age to 30 days', async () => {
    const { W, calls } = setup();
    const now = Date.now();
    const msgs = [
        mediaMsg('miss-a', 'image', { timestamp: now - 3 * DAY }),
        mediaMsg('expired-b', 'image', { timestamp: now - 2 * DAY }),
        mediaMsg('miss-c', 'image', { timestamp: now - 1 * DAY })
    ];
    const stats = plain(await W.WajsEngine.enrichMedia(msgs, netOpts({ maxAgeDays: 90 }), null));
    const dl = calls.filter(c => c.action === 'wajs_media_download');
    assert.deepEqual(dl.map(c => c.params.id), ['miss-c', 'expired-b']);
    assert.equal(dl[0].params.maxAgeDays, 30);
    assert.equal(msgs[1].media.status, 'expired');
    assert.equal(msgs[0].media.status, 'not_downloaded', 'not attempted after the stop');
    assert.equal(stats.network.stoppedBy, 'expired');
});
