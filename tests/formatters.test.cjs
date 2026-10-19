// Schema compatibility: DOM-engine exports must match v2 exactly; WA-JS fields are additive.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScripts } = require('./helpers.cjs');
const v2 = require('./fixtures/v2-formatters.cjs');

const { Formatters } = loadScripts('export/formatters.js');

const TITLE = 'Test Chat';
v2.setChatTitle(TITLE);

// DOM-engine style messages (synthetic).
const DOM_MESSAGES = [
    { id: 'false_x@c.us_1', timestamp: 1760000000000, sender: 'Ana', type: 'chat', content: 'hello, "quoted" text', quotedMessage: null, mediaUrl: null, rawFormat: '[10:00, 09/10/2025] Ana: hello' },
    { id: 'true_x@c.us_2', timestamp: 1760000060000, sender: 'Me', type: 'image', content: '[Image] cap', thumbnail: 'data:image/jpeg;base64,AAA', aiCaption: 'a cat', quotedMessage: { sender: 'Ana', content: 'hello' }, mediaUrl: null, rawFormat: '[10:01, 09/10/2025] Me: [Replying to Ana: "hello"] [Image] cap' },
    { id: 'false_x@c.us_3', timestamp: 1760000120000, sender: 'Ana', type: 'ptt', content: '[Voice Note]', aiTranscript: 'hi there', duration: 8, quotedMessage: null, mediaUrl: null, rawFormat: '[10:02, 09/10/2025] Ana: [Voice Note]' },
    { id: null, timestamp: 1760000180000, sender: 'Ana', type: 'location', content: '[Location] https://maps.google.com/?q=1,2', quotedMessage: null, mediaUrl: 'https://maps.google.com/?q=1,2', rawFormat: '[10:03, 09/10/2025] Ana: [Location] https://maps.google.com/?q=1,2' },
    { id: null, timestamp: 1760000240000, sender: 'Ana', type: 'chat', content: '=SUM(A1)', quotedMessage: null, mediaUrl: null },
    { id: null, timestamp: 1760000300000, sender: 'Ana', type: 'chat', content: '   ', quotedMessage: null, mediaUrl: null }
];

const PARAMS = [
    { mode: 'all', captureThumbnails: true },
    { mode: 'count', messageCount: '50', count: 50, captureThumbnails: false },
    { mode: 'date', startTime: '2025-10-01T00:00', endTime: '2025-10-10T00:00', captureThumbnails: true }
];

const csvRows = text => text.split('\r\n').filter(l => !l.startsWith('#'));
// Splits a CSV row whose cells are all quoted.
const csvCells = row => row.slice(1, -1).split('","');
const txtBody = text => text.split('\n').slice(6).join('\n');

for (const params of PARAMS) {
    test(`DOM JSON messages identical to v2 (${params.mode})`, () => {
        const now = JSON.parse(Formatters.formatMessages(DOM_MESSAGES, 'json', params, TITLE).text);
        const old = JSON.parse(v2.formatMessages(DOM_MESSAGES, 'json', params).text);
        assert.deepEqual(now.messages, old.messages);
        for (const key of Object.keys(old.metadata)) {
            if (key === 'exportedAt' || key === 'exportTimestamp') continue;
            assert.deepEqual(now.metadata[key], old.metadata[key], key);
        }
        assert.equal(now.metadata.engine, 'dom');
    });

    test(`DOM CSV keeps the 12 v2 columns first (${params.mode})`, () => {
        const now = csvRows(Formatters.formatMessages(DOM_MESSAGES, 'csv', params, TITLE).text);
        const old = csvRows(v2.formatMessages(DOM_MESSAGES, 'csv', params).text);
        assert.equal(now.length, old.length);
        assert.equal(now[0], old[0] + ',MessageId,SenderId,IsForwarded,IsEdited,Reactions,MediaStatus');
        for (let i = 1; i < now.length; i++) {
            assert.equal(now[i], old[i] + ',"","","","","",""');
        }
    });

    test(`DOM TXT body identical to v2 (${params.mode})`, () => {
        const now = Formatters.formatMessages(DOM_MESSAGES, 'txt', params, TITLE).text;
        const old = v2.formatMessages(DOM_MESSAGES, 'txt', params).text;
        assert.equal(txtBody(now), txtBody(old));
        assert.equal(now.split('\n')[1], old.split('\n')[1]);
    });
}

test('WA-JS messages append new fields after the v2 ones', () => {
    const wajs = {
        id: 'false_g@g.us_9_p@lid', timestamp: 1760000000000, sender: 'LID:22', type: 'audio', content: '[Audio]',
        quotedMessage: null, mediaUrl: null, rawFormat: '[10:00, 09/10/2025] LID:22: [Audio]',
        engine: 'wajs', chatId: 'g@g.us', fromMe: false, senderId: '22@lid', senderLid: '22@lid', senderPhone: null,
        isForwarded: true, forwardingScore: 1, isEdited: false, editedAt: null, mentions: [],
        media: { mimetype: 'audio/ogg', filename: null, size: 10, duration: 19, status: 'not_downloaded' }
    };
    const json = JSON.parse(Formatters.formatMessages([wajs], 'json', { mode: 'all' }, TITLE, { engine: 'wajs', wajsVersion: '4.6.1' }).text);
    const keys = Object.keys(json.messages[0]);
    assert.deepEqual(keys.slice(0, 7), ['timestamp', 'sender', 'type', 'content', 'quotedMessage', 'mediaUrl', 'rawFormat']);
    assert.equal(json.messages[0].senderPhone, null);
    assert.equal(json.messages[0].media.status, 'not_downloaded');
    assert.equal(json.metadata.engine, 'wajs');
    assert.equal(json.metadata.wajsVersion, '4.6.1');

    const row = csvCells(csvRows(Formatters.formatMessages([wajs], 'csv', { mode: 'all' }, TITLE).text)[1]);
    assert.deepEqual(row.slice(12), ['false_g@g.us_9_p@lid', '22@lid', 'true', 'false', '', 'not_downloaded']);

    const txt = Formatters.formatMessages([wajs], 'txt', { mode: 'all' }, TITLE).text;
    assert.match(txt, /LID:22: \[Audio\] \(forwarded\)$/);
});

test('WA-JS reactions go to the CSV Reactions column and a TXT suffix', () => {
    const wajs = {
        id: 'false_g@g.us_8_p@lid', timestamp: 1760000000000, sender: 'Ana', type: 'chat', content: 'hi',
        quotedMessage: null, mediaUrl: null, rawFormat: '[10:00, 09/10/2025] Ana: hi',
        engine: 'wajs', chatId: 'g@g.us', fromMe: false, senderId: '22@lid', senderLid: '22@lid', senderPhone: null,
        isForwarded: false, forwardingScore: null, isEdited: true, editedAt: 1, mentions: [],
        reactions: [{ emoji: 'A', count: 2, senders: [] }, { emoji: 'B', count: 1, senders: [] }]
    };
    const txt = Formatters.formatMessages([wajs], 'txt', { mode: 'all' }, TITLE).text;
    assert.match(txt, /Ana: hi \(edited\) \[Reactions: A2 B1\]$/);
    const row = csvCells(csvRows(Formatters.formatMessages([wajs], 'csv', { mode: 'all' }, TITLE).text)[1]);
    assert.equal(row[16], 'A2 B1');
    const json = JSON.parse(Formatters.formatMessages([wajs], 'json', { mode: 'all' }, TITLE).text);
    assert.equal(json.messages[0].reactions.length, 2);
});

test('filenames use local dates from either the popup or the request params', () => {
    assert.match(Formatters.generateFilename('My Chat!', { mode: 'date', startTime: '2025-10-01T00:00', endTime: '2025-10-10T00:00' }, 'json'), /^WA_My_Chat__2025-10-01_to_2025-10-10_\d+\.json$/);
    assert.match(Formatters.generateFilename('c', { mode: 'count', count: 50 }, 'csv'), /^WA_c_50msgs_\d+\.csv$/);
    assert.match(Formatters.generateFilename('c', { mode: 'all' }, 'txt'), /^WA_c_all_\d+\.txt$/);
});
