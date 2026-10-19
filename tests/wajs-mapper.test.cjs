// Synthetic fixtures only: never put real chat content in this repo.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScripts } = require('./helpers.cjs');

const { WajsMapper } = loadScripts('extraction/wajs-mapper.js');
const plain = v => JSON.parse(JSON.stringify(v));

const GROUP = '100000000000-1600000000@g.us';
const SELF = '111111111111111@lid';
const OTHER = '222222222222222@lid';
const T = 1760000000; // seconds

function ctxGroup() {
    return { chatId: GROUP, chatTitle: 'Test Group', isGroup: true, selfJids: new Set([SELF]) };
}

function raw(fields) {
    return Object.assign({
        id: `false_${GROUP}_ABCDEF_${OTHER}`, t: T, type: 'chat', fromMe: false,
        from: GROUP, author: OTHER, body: null, caption: null, mentionedJidList: [], pollOptions: []
    }, fields);
}

test('text message keeps v2 fields and adds WA-JS fields', () => {
    const m = plain(WajsMapper.mapMessage(raw({ body: 'hello' }), ctxGroup()));
    assert.equal(m.timestamp, T * 1000);
    assert.equal(m.type, 'chat');
    assert.equal(m.content, 'hello');
    assert.equal(m.sender, 'LID:222222222222222');
    assert.equal(m.senderLid, OTHER);
    assert.equal(m.senderPhone, null);
    assert.equal(m.engine, 'wajs');
    assert.match(m.rawFormat, /^\[\d{2}:\d{2}, \d{2}\/\d{2}\/\d{4}\] LID:222222222222222: hello$/);
});

test('own messages are "Me" and notifyName wins over LID label', () => {
    const own = WajsMapper.mapMessage(raw({ fromMe: true, author: SELF, body: 'x' }), ctxGroup());
    assert.equal(own.sender, 'Me');
    assert.equal(own.senderId, SELF);
    const named = WajsMapper.mapMessage(raw({ body: 'x', notifyName: 'Ana' }), ctxGroup());
    assert.equal(named.sender, 'Ana');
});

test('1:1 incoming messages use the chat title, @c.us gives senderPhone', () => {
    const ctx = { chatId: '34600000000@c.us', chatTitle: 'Bob', isGroup: false, selfJids: new Set() };
    const m = WajsMapper.mapMessage(raw({ from: '34600000000@c.us', author: null, body: 'hi' }), ctx);
    assert.equal(m.sender, 'Bob');
    assert.equal(m.senderPhone, '34600000000');
});

test('media types map to v2 labels, thumbnail from JPEG body, duration as number', () => {
    const img = WajsMapper.mapMessage(raw({ type: 'image', body: '/9j/AAAA', caption: 'cap', mimetype: 'image/jpeg', size: 10 }), ctxGroup());
    assert.equal(img.content, '[Image] cap');
    assert.equal(img.thumbnail, 'data:image/jpeg;base64,/9j/AAAA');
    assert.equal(img.media.status, 'thumbnail');

    const gif = WajsMapper.mapMessage(raw({ type: 'video', isGif: true, duration: '1' }), ctxGroup());
    assert.equal(gif.type, 'gif');
    assert.equal(gif.content, '[GIF]');
    assert.equal(gif.duration, 1);

    const ptt = WajsMapper.mapMessage(raw({ type: 'ptt', duration: '8', mimetype: 'audio/ogg; codecs=opus' }), ctxGroup());
    assert.equal(ptt.content, '[Voice Note]');
    assert.equal(ptt.duration, 8);
    assert.equal(ptt.media.status, 'not_downloaded');

    const audio = WajsMapper.mapMessage(raw({ type: 'audio', duration: '19', isForwarded: true, forwardingScore: 1 }), ctxGroup());
    assert.equal(audio.content, '[Audio]');
    assert.equal(audio.isForwarded, true);

    const sticker = WajsMapper.mapMessage(raw({ type: 'sticker' }), ctxGroup());
    assert.equal(sticker.content, '[Sticker]');
    assert.equal(sticker.thumbnail, null);

    const doc = WajsMapper.mapMessage(raw({ type: 'document', filename: 'a.pdf', caption: 'note' }), ctxGroup());
    assert.equal(doc.content, '[Document] a.pdf - note');
});

test('media body that is not a JPEG is never used as text or thumbnail', () => {
    const img = WajsMapper.mapMessage(raw({ type: 'image', body: 'not-a-thumbnail' }), ctxGroup());
    assert.equal(img.content, '[Image]');
    assert.equal(img.thumbnail, null);
});

test('location, contact, poll, revoked and view once', () => {
    const loc = WajsMapper.mapMessage(raw({ type: 'location', lat: 1.5, lng: -2.5 }), ctxGroup());
    assert.equal(loc.content, '[Location] https://maps.google.com/?q=1.5,-2.5');
    assert.equal(loc.mediaUrl, 'https://maps.google.com/?q=1.5,-2.5');
    assert.deepEqual(plain(loc.location), { lat: 1.5, lng: -2.5, name: null });

    const vcard = WajsMapper.mapMessage(raw({ type: 'vcard', vcardFormattedName: 'Carl' }), ctxGroup());
    assert.equal(vcard.content, '[Contact] Carl');

    const poll = WajsMapper.mapMessage(raw({
        type: 'poll_creation', pollName: 'Q?', pollSelectableOptionsCount: 1,
        pollOptions: [{ name: 'A', localId: 0 }, { name: 'B', localId: 1 }]
    }), ctxGroup());
    assert.equal(poll.type, 'poll');
    assert.equal(poll.content, '[Poll] Q?: A | B');
    assert.deepEqual(plain(poll.poll), { question: 'Q?', selectableCount: 1, options: [{ name: 'A' }, { name: 'B' }] });

    assert.equal(WajsMapper.mapMessage(raw({ type: 'revoked' }), ctxGroup()).content, '[Deleted message]');
    assert.equal(WajsMapper.mapMessage(raw({ type: 'image', isViewOnce: true }), ctxGroup()).type, 'view_once');
});

test('system entries are excluded', () => {
    for (const type of ['pinned_message', 'e2e_notification', 'gp2', 'call_log', 'protocol', 'notification_template', 'album']) {
        assert.equal(WajsMapper.mapMessage(raw({ type }), ctxGroup()), null, type);
    }
});

test('quoted replies, edits, mentions and null isForwarded', () => {
    const m = plain(WajsMapper.mapMessage(raw({
        body: 'reply',
        quotedMsg: { type: 'image', caption: 'pic' }, quotedParticipant: SELF, quotedStanzaID: 'QID',
        latestEditMsgKey: 'EDITKEY', latestEditSenderTimestampMs: 1760000001000,
        mentionedJidList: [OTHER], isForwarded: null
    }), ctxGroup()));
    assert.deepEqual(m.quotedMessage, { sender: 'Me', content: '[Image] pic', id: 'QID' });
    assert.match(m.rawFormat, /: \[Replying to Me: "\[Image\] pic"\] reply$/);
    assert.equal(m.isEdited, true);
    assert.equal(m.editedAt, 1760000001000);
    assert.deepEqual(m.mentions, [{ jid: OTHER, name: null }]);
    assert.equal(m.isForwarded, false);
});

const THIRD = '333333333333333@lid';

function ctxWithPeople() {
    return Object.assign(ctxGroup(), {
        people: new Map([
            [OTHER, { name: 'Ana Contact', pushname: 'ana', verifiedName: null, phone: '34600000001' }],
            [THIRD, { name: null, pushname: 'Third', verifiedName: null, phone: null }]
        ])
    });
}

test('people: address-book name beats notifyName, pushname is a fallback, phone only when known', () => {
    const ctx = ctxWithPeople();
    const named = WajsMapper.mapMessage(raw({ body: 'x', notifyName: 'ana' }), ctx);
    assert.equal(named.sender, 'Ana Contact');
    assert.equal(named.senderPhone, '34600000001');

    const third = WajsMapper.mapMessage(raw({ body: 'x', author: THIRD, id: `false_${GROUP}_B_${THIRD}` }), ctx);
    assert.equal(third.sender, 'Third');
    assert.equal(third.senderPhone, null);
    const notified = WajsMapper.mapMessage(raw({ body: 'x', author: THIRD, notifyName: 'Notify' }), ctx);
    assert.equal(notified.sender, 'Notify', 'notifyName wins over pushname from memory');

    const m = plain(WajsMapper.mapMessage(raw({ body: 'hi', mentionedJidList: [OTHER, THIRD, SELF, '444@lid'] }), ctx));
    assert.deepEqual(m.mentions.map(x => x.name), ['Ana Contact', 'Third', 'Me', null]);
});

test('reactions are grouped by emoji ignoring skin tone, own rows are "Me"', () => {
    const m = plain(WajsMapper.mapMessage(raw({
        body: 'x',
        reactionRows: [
            { msgKey: `false_${GROUP}_R1_${OTHER}`, sender: OTHER, text: '\u{1F44D}', timestamp: 1 },
            { msgKey: `true_${GROUP}_R2_${SELF}`, sender: SELF, text: '\u{1F44D}\u{1F3FD}', timestamp: 2 },
            { msgKey: `false_${GROUP}_R3_${THIRD}`, sender: THIRD, text: '\u2764\uFE0F', timestamp: 3 },
            { msgKey: 'x', sender: THIRD, text: '', timestamp: 4 }
        ]
    }), ctxWithPeople()));
    assert.deepEqual(m.reactions.map(r => [r.emoji, r.count]), [['\u{1F44D}', 2], ['\u2764\uFE0F', 1]]);
    assert.deepEqual(m.reactions[0].senders.map(s => s.name), ['Ana Contact', 'Me']);

    assert.equal(WajsMapper.mapMessage(raw({ body: 'x', reactionRows: [] }), ctxGroup()).reactions, undefined);
    assert.equal(WajsMapper.mapMessage(raw({ body: 'x' }), ctxGroup()).reactions, undefined);
});

test('poll votes fill options and the "(N votes)" content like the DOM engine', () => {
    const m = plain(WajsMapper.mapMessage(raw({
        type: 'poll_creation', pollName: 'Q?', pollSelectableOptionsCount: 2,
        pollOptions: [{ name: 'A', localId: 0 }, { name: 'B', localId: 1 }, { name: 'C', localId: 2 }],
        voteRows: [
            { msgKey: `false_${GROUP}_V1_${OTHER}`, sender: OTHER, selected: [0, 1], timestamp: 1 },
            { msgKey: `true_${GROUP}_V2_${SELF}`, sender: SELF, selected: [1], timestamp: 2 },
            { msgKey: `false_${GROUP}_V3_${THIRD}`, sender: THIRD, selected: [], timestamp: 3 }
        ]
    }), ctxWithPeople()));
    assert.equal(m.content, '[Poll] Q?: A (1 votes) | B (2 votes) | C (0 votes)');
    assert.deepEqual(m.poll.options.map(o => [o.name, o.votes]), [['A', 1], ['B', 2], ['C', 0]]);
    assert.deepEqual(m.poll.options[1].voters.map(v => v.name), ['Ana Contact', 'Me']);
});

test('mergeWithDom: WA-JS wins on the same key, DOM fills gaps, sorted and trimmed to scope', () => {
    const wajs = [
        { id: `true_${GROUP}_K2_${SELF}`, timestamp: 2000, engine: 'wajs', content: 'exact' },
        { id: `true_${GROUP}_K3_${SELF}`, timestamp: 3000, engine: 'wajs', content: 'c' }
    ];
    const dom = [
        { id: 'K2', timestamp: 2500, content: 'dom parse' },
        { id: 'K1', timestamp: 1000, content: 'older from phone', domIndex: 0 },
        { timestamp: 500, content: 'no id' }
    ];
    const all = WajsMapper.mergeWithDom(wajs, dom, { mode: 'all' });
    assert.deepEqual(plain(all.map(m => m.content)), ['no id', 'older from phone', 'exact', 'c']);
    const last2 = WajsMapper.mergeWithDom(wajs, dom, { mode: 'count', count: 2 });
    assert.deepEqual(plain(last2.map(m => m.content)), ['exact', 'c']);
    const range = WajsMapper.mergeWithDom(wajs, dom, { mode: 'date', start: 900, end: 2100 });
    assert.deepEqual(plain(range.map(m => m.content)), ['older from phone', 'exact']);
    const idb = [{ id: 'false_x@c.us_K9', timestamp: 9, content: 'idb' }];
    assert.equal(WajsMapper.mergeWithDom(idb, [{ id: 'K9', timestamp: 9, content: 'dom' }], {})[0].content, 'dom',
        'non-WA-JS base entries are still replaced by the DOM, as before');

    const pin = { id: 'PIN1', timestamp: 2600, type: 'chat', content: 'You pinned a message' };
    const synced = WajsMapper.mergeWithDom(wajs, dom.concat([pin]), { mode: 'all' }, { domOnlyBefore: 2000 });
    assert.deepEqual(plain(synced.map(m => m.content)), ['no id', 'older from phone', 'exact', 'c'],
        'DOM-only entries inside the WA-JS range are dropped, older ones kept');
});

test('messageKey matches WA-JS/IndexedDB ids with bare DOM data-ids', () => {
    assert.equal(WajsMapper.messageKey(`true_${GROUP}_3EB0ABCDEF_${SELF}`), '3EB0ABCDEF');
    assert.equal(WajsMapper.messageKey('false_34600000000@c.us_3EB0ABCDEF'), '3EB0ABCDEF');
    assert.equal(WajsMapper.messageKey('3EB0ABCDEF'), '3EB0ABCDEF');
    assert.equal(WajsMapper.messageKey(null), null);
});
