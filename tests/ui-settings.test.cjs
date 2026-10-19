// Popup/options settings and locale files (synthetic data only).
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { loadScripts } = require('./helpers.cjs');

const ROOT = join(__dirname, '..');
const { Settings } = loadScripts('popup/settings.js');
const plain = v => JSON.parse(JSON.stringify(v));

const locales = {
    en: JSON.parse(readFileSync(join(ROOT, '_locales/en/messages.json'), 'utf8')),
    es: JSON.parse(readFileSync(join(ROOT, '_locales/es/messages.json'), 'utf8'))
};
const placeholders = msg => (msg.match(/\$\d/g) || []).sort().join(',');

test('en and es have the same keys and the same $n placeholders', () => {
    assert.deepEqual(Object.keys(locales.es).sort(), Object.keys(locales.en).sort());
    for (const key of Object.keys(locales.en)) {
        assert.equal(placeholders(locales.es[key].message), placeholders(locales.en[key].message), key);
        assert.ok(locales.es[key].message.trim(), `empty es message: ${key}`);
        assert.ok(!/\.\.\./.test(locales.en[key].message + locales.es[key].message), `"..." instead of "…": ${key}`);
    }
});

test('every key used by the popup, options page and manifest exists', () => {
    const used = new Set();
    for (const f of ['popup/popup.html', 'options/options.html']) {
        const html = readFileSync(join(ROOT, f), 'utf8');
        for (const m of html.matchAll(/data-i18n(?:-aria-label|-title|-placeholder)?="([^"]+)"/g)) used.add(m[1]);
    }
    for (const f of ['popup/popup.js', 'options/options.js']) {
        const js = readFileSync(join(ROOT, f), 'utf8');
        for (const m of js.matchAll(/\bt\('([A-Za-z0-9_]+)'/g)) used.add(m[1]);
        for (const m of js.matchAll(/\bplural\('([A-Za-z0-9_]+)'/g)) { used.add(m[1] + '_one'); used.add(m[1] + '_other'); }
        for (const m of js.matchAll(/return t\('([A-Za-z0-9_]+)'/g)) used.add(m[1]);
    }
    const manifest = readFileSync(join(ROOT, 'manifest.json'), 'utf8');
    for (const m of manifest.matchAll(/__MSG_([A-Za-z0-9_]+)__/g)) used.add(m[1]);
    const missing = [...used].filter(k => !(k in locales.en));
    assert.deepEqual(missing, []);
});

test('normalize: defaults, legacy engine value, clamped numbers and default dates', () => {
    const now = new Date(2026, 9, 19, 12, 30);
    const s = Settings.normalize({ extractEngine: 'wajs', mediaMaxAgeDays: '90', maxAiRequests: 0, extractMode: 'bogus', thumbnailResolution: 160 }, now);
    assert.equal(s.extractEngine, 'auto');
    assert.equal(s.mediaMaxAgeDays, 30, 'media age never above 30 days');
    assert.equal(s.maxAiRequests, 1);
    assert.equal(s.extractMode, 'count');
    assert.equal(s.thumbnailResolution, '160');
    assert.equal(s.endTime, '2026-10-19T12:30');
    assert.equal(s.startTime, '2026-10-18T12:30');
    assert.equal(s.enableAiTranscription, true);
});

test('buildRequest keeps the extract_chat contract and gates network options', () => {
    const base = Settings.normalize({ extractMode: 'count', messageCount: 50, downloadMissingMedia: true, syncOlderFromPhone: true });
    const req = plain(Settings.buildRequest(base, { intent: 'download' }));
    assert.equal(req.action, 'extract_chat');
    assert.equal(req.count, 50);
    assert.equal(req.engine, 'auto');
    assert.equal(req.downloadMissingMedia, true);
    assert.equal(req.syncOlderFromPhone, true);
    assert.equal(req.enableAiCaptions, false);
    assert.equal(req.geminiApiKey, '', 'no key sent unless AI is on');
    for (const k of ['captureThumbnails', 'thumbnailSize', 'enableAiTranscription', 'maxAiRequests', 'model', 'customPrompt', 'mediaMaxAgeDays', 'maxMediaDownloads', 'format', 'intent']) {
        assert.ok(k in req, k);
    }

    const dom = plain(Settings.buildRequest(Object.assign({}, base, { extractEngine: 'dom' })));
    assert.equal(dom.downloadMissingMedia, false, 'WA-JS-only options are off with the classic reader');
    assert.equal(dom.syncOlderFromPhone, false);

    const ai = plain(Settings.buildRequest(Settings.normalize({ enableAiCaptions: true, geminiApiKey: ' k ', enableAiTranscription: false })));
    assert.equal(ai.enableAiCaptions, true);
    assert.equal(ai.enableAiTranscription, false);
    assert.equal(ai.geminiApiKey, 'k');

    const noKey = plain(Settings.buildRequest(Settings.normalize({ enableAiCaptions: true })));
    assert.equal(noKey.enableAiCaptions, false, 'the AI switch does nothing without a key');
});

test('buildRequest rejects invalid scopes with an i18n key', () => {
    assert.throws(() => Settings.buildRequest(Settings.normalize({ extractMode: 'date', startTime: '2026-10-19T10:00', endTime: '2026-10-18T10:00' })),
        e => e.i18nKey === 'errDatesOrder');
    const range = plain(Settings.buildRequest(Settings.normalize({ extractMode: 'date', startTime: '2026-10-18T10:00', endTime: '2026-10-19T10:00' })));
    assert.ok(range.start < range.end);
    assert.equal(range.startTime, '2026-10-18T10:00');
    const all = plain(Settings.buildRequest(Settings.normalize({ extractMode: 'all' })));
    assert.equal(all.count, undefined);
});

test('keyOfRequest ignores format and intent, and matches a request read back from the tab', () => {
    const s = Settings.normalize({ extractMode: 'count', messageCount: 20 });
    const a = Settings.buildRequest(s, { intent: 'copy', format: 'txt' });
    const b = Settings.buildRequest(Object.assign({}, s, { exportFormat: 'csv' }), { intent: 'download' });
    assert.equal(Settings.keyOfRequest('Chat', a), Settings.keyOfRequest('Chat', b));
    const roundTrip = JSON.parse(JSON.stringify(a));
    assert.equal(Settings.keyOfRequest('Chat', roundTrip), Settings.requestKey('Chat', s));
    assert.notEqual(Settings.keyOfRequest('Other chat', a), Settings.keyOfRequest('Chat', a));
    assert.notEqual(Settings.requestKey('Chat', Object.assign({}, s, { messageCount: 21 })), Settings.requestKey('Chat', s));
});
