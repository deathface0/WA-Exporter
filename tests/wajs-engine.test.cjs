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

// local.from: index of the oldest message in WhatsApp's local cache (older ones are "on the phone").
function setup({ history = makeHistory(), health = null, failFrom = Infinity, addons = null, people = null,
    historyType = 1, local = { from: 0 }, activeChat = null } = {}) {
    const W = loadScripts('extraction/wajs-mapper.js', 'extraction/wajs-engine.js');
    Object.assign(W.WajsEngine.PACING, { pauseMinMs: 0, pauseMaxMs: 0, longPauseMinMs: 0, longPauseMaxMs: 0 });
    Object.assign(W.WajsEngine.MEDIA_PACING, { minMs: 0, maxMs: 0 });
    Object.assign(W.WajsEngine.NETWORK_PACING, { minMs: 0, maxMs: 0 });
    const calls = [];
    Object.assign(W.WajsEngine.ADDON_PACING, { minMs: 0, maxMs: 0 });
    W.Wajs = {
        ensureInjected: async () => ({ ok: true }),
        markIncompatible: async (waVersion, reason) => { calls.push({ action: 'mark_incompatible', params: { waVersion, reason } }); },
        call: async (action, params) => {
            calls.push({ action, params });
            if (action === 'wajs_health') {
                return health || { ok: true, chat: { id: GROUP, title: 'G', endOfHistoryTransferType: historyType }, waVersion: 'wa', wajsVersion: '4.6.1' };
            }
            if (action === 'wajs_active_chat') {
                return activeChat || { id: GROUP, title: 'G', endOfHistoryTransferType: historyType };
            }
            if (action === 'wajs_release') return { released: true };
            if (action === 'wajs_addons') {
                if (addons) return addons(params);
                return { reactions: {}, votes: {}, unavailable: [] };
            }
            if (action === 'wajs_people') {
                if (people) return people(params);
                return { unavailable: false, people: {} };
            }
            if (action === 'wajs_media_thumbnail') {
                if (params.id === 'boom') throw new Error('read_failed');
                return params.id.startsWith('cached') ? { dataUri: 'data:image/webp;base64,AA', source: 'cache:lru' } : { dataUri: null, source: null };
            }
            if (action === 'wajs_media_download') {
                if (params.allowNetwork !== true) throw new Error('Network download not allowed');
                if (params.id.startsWith('expired')) return { status: 'expired', reason: 'REUPLOADING' };
                if (params.id.startsWith('stale')) return { status: 'expired', reason: 'url_expired', skipped: true };
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
                return history.slice(Math.max(local.from, end - params.count), Math.max(local.from, end));
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

test('network tier: items skipped before requesting (expired CDN URL) neither stop nor count as errors', async () => {
    const { W, calls } = setup();
    const now = Date.now();
    const msgs = [
        mediaMsg('miss-a', 'image', { timestamp: now - 3 * DAY }),
        mediaMsg('stale-sticker', 'sticker', { timestamp: now - 2 * DAY }),
        mediaMsg('miss-c', 'image', { timestamp: now - 1 * DAY })
    ];
    const stats = plain(await W.WajsEngine.enrichMedia(msgs, netOpts(), null));
    assert.deepEqual(calls.filter(c => c.action === 'wajs_media_download').map(c => c.params.id), ['miss-c', 'stale-sticker', 'miss-a']);
    assert.equal(msgs[1].media.status, 'expired');
    assert.equal(msgs[1].media.error, 'url_expired');
    assert.equal(msgs[0].media.status, 'thumbnail', 'downloads continue after a skipped item');
    assert.equal(stats.network.skipped, 1);
    assert.equal(stats.network.downloaded, 2);
    assert.equal(stats.network.stoppedBy, null);
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

test('addons: one batched lookup per page, polls only for poll_creation, definite false skipped', async () => {
    const history = makeHistory(50).map((m, i) => Object.assign(m, {
        fromMe: i % 2 === 0, author: i % 2 === 0 ? SELF : '222@lid',
        hasReaction: i === 10 ? false : (i === 11 ? true : null),
        type: i === 49 ? 'poll_creation' : m.type,
        pollOptions: i === 49 ? [{ name: 'A', localId: 0 }, { name: 'B', localId: 1 }] : []
    }));
    const r11 = history[11].id;
    const p49 = history[49].id;
    const { W, calls } = setup({
        history,
        addons: (params) => ({
            reactions: { [r11]: [{ msgKey: `false_${GROUP}_X_222@lid`, sender: '222@lid', text: 'R', timestamp: 1 }] },
            votes: { [p49]: [{ msgKey: `false_${GROUP}_V_333@lid`, sender: '333@lid', selected: [1], timestamp: 2 }] },
            unavailable: []
        }),
        people: (params) => ({ unavailable: false, people: { '222@lid': { name: 'Bea', pushname: null, verifiedName: null, phone: null } } })
    });
    const res = plain(await W.WajsEngine.run({ mode: 'all' }, null));
    const addonCalls = calls.filter(c => c.action === 'wajs_addons');
    assert.equal(addonCalls.length, calls.filter(c => c.action === 'wajs_get_messages').length - 1, 'one per non-empty page');
    const allReactionIds = addonCalls.flatMap(c => c.params.reactionIds);
    assert.ok(!allReactionIds.includes(history[10].id), 'hasReaction false is skipped');
    assert.ok(allReactionIds.includes(r11));
    assert.ok(!allReactionIds.includes(history[0].id), 'excluded system entries are skipped');
    assert.deepEqual(addonCalls.flatMap(c => c.params.pollIds), [p49]);
    assert.ok(addonCalls.every(c => c.params.reactionIds.length <= 50));

    const peopleCalls = calls.filter(c => c.action === 'wajs_people');
    assert.equal(peopleCalls.length, 1);
    assert.deepEqual([...peopleCalls[0].params.jids].sort(), ['111@lid', '222@lid', '333@lid']);

    const reacted = res.messages.find(m => m.id === r11);
    assert.deepEqual(reacted.reactions, [{ emoji: 'R', count: 1, senders: [{ jid: '222@lid', name: 'Bea', timestamp: 1 }] }]);
    assert.equal(reacted.sender, 'Bea');
    const poll = res.messages.find(m => m.id === p49);
    assert.equal(poll.content, '[Poll] Poll: A (0 votes) | B (1 votes)');
    assert.deepEqual(poll.poll.options[1].voters, [{ jid: '333@lid', name: 'LID:333' }]);
});

test('addons and people failures only drop the extras', async () => {
    const { W } = setup({
        history: makeHistory(30),
        addons: () => { throw new Error('reactions_unavailable'); },
        people: () => { throw new Error('boom'); }
    });
    const res = plain(await W.WajsEngine.run({ mode: 'all' }, null));
    assert.equal(res.stopReason, 'local_cache_boundary');
    assert.equal(res.messages.length, 28);
    assert.ok(res.messages.every(m => m.reactions === undefined));
});

const OTHER = '222@lid';
const othersHistory = () => makeHistory().map(m => Object.assign({}, m, {
    id: m.id.replace('true_', 'false_').replace(SELF, OTHER), fromMe: false, author: OTHER
}));
const namePeople = () => ({ unavailable: false, people: { [OTHER]: { name: 'Bea', pushname: null, verifiedName: null, phone: null } } });

test('abort still looks up contact names for the partial result', async () => {
    const controller = new AbortController();
    const { W, calls } = setup({
        history: othersHistory(),
        addons: () => { controller.abort(); return { reactions: {}, votes: {}, unavailable: [] }; },
        people: namePeople
    });
    const res = plain(await W.WajsEngine.run({ mode: 'all' }, controller.signal));
    assert.equal(res.stopReason, 'aborted');
    assert.equal(res.isPartial, true);
    assert.equal(calls.filter(c => c.action === 'wajs_people').length, 1);
    assert.ok(res.messages.length > 0 && res.messages.every(m => m.sender === 'Bea'));
});

test('mid-run failure partial carries contact names', async () => {
    const { W } = setup({ history: othersHistory(), failFrom: 1, people: namePeople });
    await assert.rejects(W.WajsEngine.run({ mode: 'all' }, null),
        err => err.name === 'WajsMidRunError' && err.partial.length === 39 && err.partial.every(m => m.sender === 'Bea'));
});

test('date: old-dated call logs grouped mid-history do not stop the range early', async () => {
    const history = makeHistory();
    // WhatsApp lists call logs together, with their own much older timestamps.
    for (let i = 90; i < 95; i++) history[i] = Object.assign({}, history[i], { type: 'call_log', t: 1700000000 + i });
    const { W } = setup({ history });
    const base = 1760000000 * 1000;
    const res = plain(await W.WajsEngine.run({ mode: 'date', start: base + 20 * 60000, end: Infinity }, null));
    assert.equal(res.stopReason, 'reached_start_date');
    assert.equal(res.messages[0].timestamp, base + 20 * 60000);
    assert.equal(res.messages.length, 80 - 3 - 5, '20..99 minus pinned at 25/50/75 and the call logs');
});

test('older history: needsOlder only when the cache ends before the scope and the phone has more', async () => {
    const local = { from: 60 };
    let { W } = setup({ historyType: 0, local });
    let res = await W.WajsEngine.run({ mode: 'count', count: 60 }, null);
    assert.equal(res.stopReason, 'local_cache_boundary');
    assert.equal(res.history, 'on_phone');
    assert.equal(res.needsOlder, true);
    assert.equal(res.isPartial, true);
    assert.equal(JSON.parse(JSON.stringify(res)).resume, undefined, 'resume state is never serialized');

    ({ W } = setup({ historyType: 1, local: { from: 60 } }));
    res = await W.WajsEngine.run({ mode: 'all' }, null);
    assert.equal(res.history, 'complete');
    assert.equal(res.needsOlder, false);
    assert.equal(res.isPartial, false, 'all + complete history is not partial');

    ({ W } = setup({ historyType: 5, local: { from: 60 } }));
    res = await W.WajsEngine.run({ mode: 'all' }, null);
    assert.equal(res.needsOlder, false, 'no access: nothing to sync');
    assert.equal(res.isPartial, true);

    ({ W } = setup({ historyType: 0 }));
    res = await W.WajsEngine.run({ mode: 'count', count: 30 }, null);
    assert.equal(res.needsOlder, false, 'scope met from the local cache');
    res = await W.WajsEngine.run({ mode: 'count', count: 30, debugForceOlder: true }, null);
    assert.equal(res.needsOlder, true);
});

test('older history: a resumed run continues from the last anchor and reads the synced messages', async () => {
    const local = { from: 60 };
    const { W, calls } = setup({ historyType: 0, local });
    const first = await W.WajsEngine.run({ mode: 'all' }, null);
    assert.equal(first.messages.length, 39);
    assert.equal(first.needsOlder, true);

    local.from = 0; // the DOM engine synced the rest from the phone
    const before = calls.filter(c => c.action === 'wajs_get_messages').length;
    const second = await W.WajsEngine.run({ mode: 'all' }, null, () => { }, first.resume);
    const resumedPages = calls.filter(c => c.action === 'wajs_get_messages').slice(before);
    assert.equal(resumedPages[0].params.id, `true_${GROUP}_M0060_${SELF}`, 'resumes before the oldest anchor');
    assert.ok(!calls.slice(before).some(c => c.action === 'wajs_health'), 'no second injection or health check');
    assert.equal(second.messages.length, 96);
    assert.equal(second.needsOlder, false, 'one sync round only');
    const ids = second.messages.map(m => m.id);
    assert.equal(new Set(ids).size, ids.length);
    const ts = plain(second.messages.map(m => m.timestamp));
    assert.deepEqual(ts, [...ts].sort((a, b) => a - b));
});

test('older history: a resumed run on another chat returns the first result untouched', async () => {
    const { W } = setup({ historyType: 0, local: { from: 60 }, activeChat: { id: 'other@g.us', title: 'X' } });
    const first = await W.WajsEngine.run({ mode: 'all' }, null);
    const second = await W.WajsEngine.run({ mode: 'all' }, null, () => { }, first.resume);
    assert.equal(second.olderPass, 'chat_changed');
    assert.equal(second.messages.length, first.messages.length);
});

test('version failures are remembered, transient ones are not', async () => {
    for (const [reason, remembered] of [['wa_modules_missing:chats', true], ['api_missing:chat.getMessages', true],
        ['shape_mismatch', true], ['chat_mismatch', false], ['not_ready', false], ['no_active_chat', false]]) {
        const { W, calls } = setup({ health: { ok: false, reason, waVersion: '2.3000.1' } });
        await assert.rejects(W.WajsEngine.run({ mode: 'all' }, null), { name: 'WajsUnavailable', reason });
        const marks = calls.filter(c => c.action === 'mark_incompatible');
        assert.equal(marks.length, remembered ? 1 : 0, reason);
        if (remembered) assert.deepEqual(marks[0].params, { waVersion: '2.3000.1', reason });
    }
});
