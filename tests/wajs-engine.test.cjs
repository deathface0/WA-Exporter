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
    const calls = [];
    W.Wajs = {
        ensureInjected: async () => ({ ok: true }),
        call: async (action, params) => {
            calls.push({ action, params });
            if (action === 'wajs_health') {
                return health || { ok: true, chat: { id: GROUP, title: 'G' }, waVersion: 'wa', wajsVersion: '4.6.1' };
            }
            if (action === 'wajs_release') return { released: true };
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
