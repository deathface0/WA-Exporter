// DOM-engine pure helpers with synthetic data and a minimal fake DOM (no browser needed).
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScripts } = require('./helpers.cjs');

const W = loadScripts('extraction/selectors.js', 'extraction/parsers.js', 'extraction/scroller.js');
const { Parsers, Scroller } = W;

// Minimal stand-ins for the DOM nodes collectText() walks.
function el(tag, attrs, ...kids) {
    const node = {
        nodeType: 1, tagName: tag.toUpperCase(), attrs: attrs || {}, childNodes: [], parentNode: null,
        hasAttribute(n) { return n in this.attrs; },
        get alt() { return this.attrs.alt || ''; },
        get children() { return this.childNodes.filter(c => c.nodeType === 1); }
    };
    kids.forEach(k => { const c = typeof k === 'string' ? { nodeType: 3, textContent: k } : k; c.parentNode = node; node.childNodes.push(c); });
    return node;
}

test('text keeps line breaks between spans and only trims the ends', () => {
    const msg = el('span', {}, el('span', {}, 'Line one', '\n'), el('span', {}, 'Line two', '\n'), el('span', {}, 'Three '));
    assert.equal(Parsers.extractTextWithEmojis(msg), 'Line one\nLine two\nThree');
    assert.equal(Parsers.extractTextWithEmojis(el('span', {}, 'a', el('br'), 'b')), 'a\nb');
});

test('formatting tags become WhatsApp markers, lists get "- " and emojis their alt', () => {
    const msg = el('span', {},
        el('strong', {}, 'Title'), '\n',
        el('em', {}, 'it'), ' ', el('del', {}, 'gone'), ' ', el('code', {}, 'x=1'), ' ',
        el('img', { alt: '😀' }), el('span', { 'data-icon': 'tail' }, 'ic-hidden'));
    assert.equal(Parsers.extractTextWithEmojis(msg), '*Title*\n_it_ ~gone~ `x=1` 😀');
    const list = el('span', {}, 'Intro', el('ul', {}, el('li', {}, 'one'), el('li', {}, 'two')), 'after');
    assert.equal(Parsers.extractTextWithEmojis(list), 'Intro\n- one\n- two\nafter');
    // WhatsApp puts "\n" text nodes between <li>s: no double breaks.
    const waList = el('span', {}, el('span', {}, 'Intro:', '\n'), el('span', {}, el('ul', {}, el('li', {}, el('span', {}, 'one')), '\n', el('li', {}, el('span', {}, 'two')))));
    assert.equal(Parsers.extractTextWithEmojis(waList), 'Intro:\n- one\n- two');
    const ordered = el('span', {}, el('ol', {}, el('li', {}, 'a'), el('li', {}, 'b')));
    assert.equal(Parsers.extractTextWithEmojis(ordered), '1. a\n2. b');
});

test('location links use the WA-JS URL shape when coordinates are present', () => {
    assert.equal(Parsers.locationUrl('https://maps.google.com/maps?q=37.5%2C-4.25&z=17'), 'https://maps.google.com/?q=37.5,-4.25');
    assert.equal(Parsers.locationUrl('https://maps.google.com/maps?q=37.5,-4.25&z=17'), 'https://maps.google.com/?q=37.5,-4.25');
    assert.equal(Parsers.locationUrl('https://waze.com/ul?x=1'), 'https://waze.com/ul?x=1');
});

test('restampDay moves the day, keeps the time and rewrites the rawFormat prefix', () => {
    const msg = { timestamp: new Date(2026, 3, 20, 9, 5).getTime(), rawFormat: '[09:05, 20/04/2026] Me: [Image]', dateSource: 'guess' };
    Parsers.restampDay(msg, new Date(2026, 3, 16, 23, 59), 'context');
    assert.equal(msg.timestamp, new Date(2026, 3, 16, 9, 5).getTime());
    assert.equal(msg.rawFormat, '[09:05, 16/04/2026] Me: [Image]');
    assert.equal(msg.dateSource, 'context');
});

function m(day, h, min, dateSource, domIndex) {
    const ts = new Date(2026, 3, day, h, min).getTime();
    return { timestamp: ts, dateSource, domIndex, rawFormat: `[x] Me: ${day}` };
}

test('resolveGuessedDates takes the day of dated neighbours in visual order', () => {
    const today = 30;
    const msgs = [
        m(10, 8, 0, 'exact', 0),
        m(today, 9, 0, 'guess', 1),   // between two messages of the 10th -> 10th
        m(10, 10, 0, 'exact', 2),
        m(today, 23, 30, 'guess', 3), // after 22:00 on the 10th, before 07:00 on the 12th -> 10th
        m(10, 22, 0, 'exact', 4),
        m(today, 6, 0, 'guess', 5),   // earlier than the previous time of day -> next day (12th)
        m(12, 7, 0, 'exact', 6)
    ];
    msgs[3].timestamp = new Date(2026, 3, today, 23, 30).getTime();
    Scroller.resolveGuessedDates(msgs);
    const days = msgs.map(x => new Date(x.timestamp).getDate());
    assert.deepEqual(days, [10, 10, 10, 10, 10, 12, 12]);
    assert.ok(msgs.every(x => x.dateSource !== 'guess'));
    assert.equal(new Date(msgs[5].timestamp).getHours(), 6, 'time of day is kept');
});

test('resolveGuessedDates leaves messages alone when nothing is dated', () => {
    const msgs = [m(30, 9, 0, 'guess', 0), m(30, 10, 0, 'guess', 1)];
    const before = msgs.map(x => x.timestamp);
    Scroller.resolveGuessedDates(msgs);
    assert.deepEqual(msgs.map(x => x.timestamp), before);
});

test('grouped sticker bubbles become one message per id', () => {
    const rows = [
        { key: 'A1', parsedMsg: { id: 'A1', type: 'chat' } },
        { key: 'g', parsedMsg: { id: 'grouped-sticker--3EB0AA-3EB0BB', type: 'sticker', timestamp: 5 } }
    ];
    const out = Scroller.expandGroupedRows(rows);
    assert.deepEqual(JSON.parse(JSON.stringify(out.map(r => r.parsedMsg.id))), ['A1', '3EB0AA', '3EB0BB']);
    assert.deepEqual(JSON.parse(JSON.stringify(out.map(r => r.key))), ['A1', '3EB0AA', '3EB0BB']);
    assert.notEqual(out[1].parsedMsg, out[2].parsedMsg);
    assert.equal(out[2].parsedMsg.timestamp, 5);
});

test('assignDomIndices keeps visual order for rows that appear late between known ones', () => {
    const plainArr = a => JSON.parse(JSON.stringify(a));
    // first viewport: nothing known, placed below lowestIndex (0)
    assert.deepEqual(plainArr(Scroller.assignDomIndices([null, null, null], 0)), [-3, -2, -1]);
    // a sticker rendered late between two known rows gets an index between them
    const mid = Scroller.assignDomIndices([-3, null, -2], -3);
    assert.ok(mid[1] > -3 && mid[1] < -2);
    // older rows above the first known one go below it; trailing new rows above the next
    const edge = plainArr(Scroller.assignDomIndices([null, null, -5, -4, null], -5));
    assert.deepEqual(edge.slice(0, 4), [-7, -6, -5, -4]);
    assert.ok(edge[4] > -4 && edge[4] < -3.9, 'stays below a known row just outside the viewport');
    const many = Scroller.assignDomIndices([1, null, null, null, 2], 0);
    assert.ok(many[1] < many[2] && many[2] < many[3] && many[3] < 2);
});
