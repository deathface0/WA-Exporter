(function () {
    'use strict';

    // Pure mapping from the host's projected WA-JS messages to the export schema.
    // Content strings mirror extraction/parsers.js so both engines read the same.

    const root = typeof window !== 'undefined' ? window : globalThis;
    root.WAExporter = root.WAExporter || {};

    const pad = n => n.toString().padStart(2, '0');

    const LABELS = {
        image: '[Image]',
        video: '[Video]',
        gif: '[GIF]',
        audio: '[Audio]',
        ptt: '[Voice Note]',
        document: '[Document]',
        sticker: '[Sticker]',
        location: '[Location]',
        vcard: '[Contact]',
        poll: '[Poll]',
        revoked: '[Deleted message]',
        view_once: '[View Once Message]'
    };

    // System and protocol entries the DOM engine never exported either.
    const EXCLUDED_TYPES = new Set([
        'pinned_message', 'e2e_notification', 'gp2', 'notification', 'notification_template',
        'protocol', 'call_log', 'ciphertext', 'reaction', 'broadcast_notification',
        // Grouped-media container; its images/videos arrive as separate messages.
        'album'
    ]);

    // A view-once message this device cannot open arrives as ciphertext; WhatsApp still shows
    // it in the chat (and the DOM engine exports it as [View Once Message]).
    const VIEW_ONCE_PLACEHOLDER = 'view_once_unavailable_fanout';

    function isExcluded(raw) {
        if (raw.type === 'ciphertext' && raw.subtype === VIEW_ONCE_PLACEHOLDER) return false;
        return EXCLUDED_TYPES.has(raw.type);
    }

    // WhatsApp groups reactions by emoji regardless of skin tone.
    const SKIN_TONES = /[\u{1F3FB}-\u{1F3FF}]/gu;

    const MEDIA_KINDS = new Set(['image', 'video', 'gif', 'audio', 'ptt', 'document', 'sticker']);
    const THUMBNAIL_KINDS = new Set(['image', 'video', 'gif']);

    function kindOf(raw) {
        if (raw.isViewOnce || (raw.type === 'ciphertext' && raw.subtype === VIEW_ONCE_PLACEHOLDER)) return 'view_once';
        if (raw.type === 'video' && raw.isGif) return 'gif';
        if (raw.type === 'poll_creation') return 'poll';
        if (raw.type === 'multi_vcard') return 'vcard';
        return raw.type || 'chat';
    }

    // Engine-independent merge key: the message part of a serialized id.
    // WA-JS/IndexedDB ids are "<fromMe>_<chat>_<msgId>[_<participant>]"; the DOM's data-id
    // is just "<msgId>" on current WhatsApp Web builds.
    function messageKey(id) {
        if (!id || typeof id !== 'string') return null;
        const m = id.match(/^(?:true|false)_[^_]+_([^_]+)/);
        return m ? m[1] : id;
    }

    function jidUser(jid) {
        return jid ? jid.split('@')[0] : null;
    }

    function jidServer(jid) {
        return jid && jid.includes('@') ? jid.split('@')[1] : null;
    }

    // ctx.people: jid -> { name, pushname, verifiedName, phone } from WhatsApp's in-memory contacts.
    function person(jid, ctx) {
        return (ctx.people && jid && ctx.people.get(jid)) || null;
    }

    // Address-book name first (as WhatsApp shows it), then the sender's own notify/push name.
    function displayName(jid, notifyName, ctx) {
        if (!jid) return notifyName || 'Contact';
        if (ctx.selfJids && ctx.selfJids.has(jid)) return 'Me';
        if (!ctx.isGroup && ctx.chatTitle) return ctx.chatTitle;
        const p = person(jid, ctx);
        if (p && p.name) return p.name;
        if (notifyName) return notifyName;
        if (p && (p.pushname || p.verifiedName)) return p.pushname || p.verifiedName;
        const server = jidServer(jid);
        if (server === 'c.us') return jidUser(jid);
        if (server === 'lid') return 'LID:' + jidUser(jid);
        return 'Contact';
    }

    // Author of a reaction or vote row: own rows have a "true_" message key.
    function actorName(jid, msgKey, ctx) {
        if (typeof msgKey === 'string' && msgKey.startsWith('true_')) return 'Me';
        return displayName(jid, null, ctx);
    }

    function buildReactions(rows, ctx) {
        const groups = new Map();
        rows.forEach(r => {
            if (!r || !r.text) return;
            const emoji = r.text.replace(SKIN_TONES, '');
            if (!groups.has(emoji)) groups.set(emoji, []);
            groups.get(emoji).push({ jid: r.sender || null, name: actorName(r.sender, r.msgKey, ctx), timestamp: r.timestamp });
        });
        return Array.from(groups, ([emoji, senders]) => ({ emoji, count: senders.length, senders }))
            .sort((a, b) => b.count - a.count);
    }

    // localId -> voters, or null when the votes were not read.
    function pollTally(raw, ctx) {
        if (!Array.isArray(raw.voteRows)) return null;
        const tally = new Map();
        raw.voteRows.forEach(v => {
            (v.selected || []).forEach(localId => {
                const key = Number(localId);
                if (!tally.has(key)) tally.set(key, []);
                tally.get(key).push({ jid: v.sender || null, name: actorName(v.sender, v.msgKey, ctx) });
            });
        });
        return tally;
    }

    function votersFor(tally, option) {
        return (tally && tally.get(Number(option.localId))) || [];
    }

    function contentFor(kind, raw, ctx) {
        const label = LABELS[kind];
        const caption = resolveMentions(raw.caption, raw.mentionedJidList, ctx);
        switch (kind) {
            case 'chat':
                return resolveMentions(raw.body, raw.mentionedJidList, ctx) || '';
            case 'image':
            case 'video':
            case 'gif':
                return caption ? `${label} ${caption}` : label;
            case 'audio':
            case 'ptt':
            case 'sticker':
            case 'revoked':
            case 'view_once':
                return label;
            case 'document': {
                const name = raw.filename || 'document';
                return raw.caption && raw.caption !== name ? `${label} ${name} - ${caption}` : `${label} ${name}`;
            }
            case 'location':
                return `${label} ${mapsUrl(raw)}`;
            case 'vcard':
                return `${label} ${raw.vcardFormattedName || 'Contact'}`;
            case 'poll': {
                // Same "(N votes)" suffix as the DOM engine when the votes are known.
                const tally = pollTally(raw, ctx);
                const names = (raw.pollOptions || []).filter(o => o.name)
                    .map(o => tally ? `${o.name} (${votersFor(tally, o).length} votes)` : o.name);
                return `${label} ${raw.pollName || 'Poll'}${names.length ? ': ' + names.join(' | ') : ''}`;
            }
            default:
                return '[Media]';
        }
    }

    function mapsUrl(raw) {
        return `https://maps.google.com/?q=${raw.lat},${raw.lng}`;
    }

    function quotedContent(q, ctx) {
        if (!q) return '[Media]';
        const kind = q.type === 'poll_creation' ? 'poll' : (q.type || 'chat');
        if (kind === 'chat') return resolveMentions(q.body, q.mentionedJidList, ctx) || '[Media]';
        const label = LABELS[kind] || '[Media]';
        const text = resolveMentions(q.caption, q.mentionedJidList, ctx) || (kind === 'document' ? q.filename : null);
        return text ? `${label} ${text}` : label;
    }

    function mentionName(jid, ctx) {
        if (!jid) return null;
        if (ctx.selfJids && ctx.selfJids.has(jid)) return 'Me';
        const p = person(jid, ctx);
        return (p && (p.name || p.pushname || p.verifiedName)) || null;
    }

    // WhatsApp stores a mention as "@<user part of the jid>" in the text and shows the name
    // on screen. Quoted messages may lack mentionedJidList, so the token is also tried as
    // @lid and @c.us. Unknown names keep the "@<user>" token.
    const MENTION_TOKEN = /(?<![\w@])@(\d+)(?!\d)/g;

    function mentionCandidates(text) {
        if (typeof text !== 'string' || !text.includes('@')) return [];
        const out = [];
        for (const m of text.matchAll(MENTION_TOKEN)) out.push(`${m[1]}@lid`, `${m[1]}@c.us`);
        return out;
    }

    function resolveMentions(text, jids, ctx) {
        if (typeof text !== 'string' || !text.includes('@')) return text;
        const byUser = new Map();
        (jids || []).forEach(jid => {
            const user = jidUser(jid);
            if (user && !byUser.has(user)) byUser.set(user, jid);
        });
        return text.replace(MENTION_TOKEN, (token, user) => {
            const name = mentionName(byUser.get(user), ctx) ||
                mentionName(`${user}@lid`, ctx) || mentionName(`${user}@c.us`, ctx);
            return name ? '@' + name : token;
        });
    }

    function toInt(value) {
        const n = parseInt(value, 10);
        return Number.isFinite(n) ? n : null;
    }

    /**
     * ctx: { chatId, chatTitle, isGroup, selfJids: Set<string>, people?: Map<jid, person> }
     * raw.reactionRows / raw.voteRows are attached by the engine when they could be read.
     * Returns null for entries that are not exported.
     */
    function mapMessage(raw, ctx) {
        if (!raw || !raw.id || typeof raw.t !== 'number') return null;
        if (isExcluded(raw)) return null;

        const kind = kindOf(raw);
        const senderId = raw.fromMe
            ? (raw.author || raw.from || null)
            : (ctx.isGroup ? raw.author : raw.from) || null;
        const sender = raw.fromMe ? 'Me' : displayName(senderId, raw.notifyName, ctx);

        const timestamp = raw.t * 1000;
        const d = new Date(timestamp);
        const dateStr = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
        const timeStr = `${pad(d.getHours())}:${pad(d.getMinutes())}`;

        const content = contentFor(kind, raw, ctx);
        const senderPerson = person(senderId, ctx);

        let quotedMessage = null;
        if (raw.quotedMsg) {
            quotedMessage = {
                sender: displayName(raw.quotedParticipant, null, ctx),
                content: quotedContent(raw.quotedMsg, ctx),
                id: raw.quotedStanzaID || null
            };
        }
        const quotedSender = quotedMessage && quotedMessage.sender !== 'Contact' ? `${quotedMessage.sender}: ` : '';
        const quotedPrefix = quotedMessage ? `[Replying to ${quotedSender}"${quotedMessage.content}"] ` : '';

        const thumbnail = THUMBNAIL_KINDS.has(kind) && typeof raw.body === 'string' && raw.body.startsWith('/9j/')
            ? 'data:image/jpeg;base64,' + raw.body
            : null;

        const msg = {
            id: raw.id,
            timestamp,
            sender,
            type: kind,
            content,
            quotedMessage,
            mediaUrl: kind === 'location' ? mapsUrl(raw) : null,
            rawFormat: `[${timeStr}, ${dateStr}] ${sender}: ${quotedPrefix}${content}`,
            thumbnail,
            blobUrl: null,
            duration: toInt(raw.duration),

            engine: 'wajs',
            chatId: ctx.chatId,
            fromMe: !!raw.fromMe,
            senderId,
            senderLid: jidServer(senderId) === 'lid' ? senderId : null,
            senderPhone: jidServer(senderId) === 'c.us' ? jidUser(senderId) : ((senderPerson && senderPerson.phone) || null),
            isForwarded: !!raw.isForwarded,
            forwardingScore: toInt(raw.forwardingScore),
            isEdited: !!raw.latestEditMsgKey,
            editedAt: typeof raw.latestEditSenderTimestampMs === 'number' ? raw.latestEditSenderTimestampMs : null,
            mentions: (raw.mentionedJidList || []).map(jid => ({ jid, name: mentionName(jid, ctx) }))
        };

        if (Array.isArray(raw.reactionRows)) {
            const reactions = buildReactions(raw.reactionRows, ctx);
            if (reactions.length) msg.reactions = reactions;
        }

        if (kind === 'location') {
            msg.location = { lat: raw.lat, lng: raw.lng, name: raw.loc || null };
        }
        if (kind === 'poll') {
            const tally = pollTally(raw, ctx);
            msg.poll = {
                question: raw.pollName || null,
                selectableCount: toInt(raw.pollSelectableOptionsCount),
                options: (raw.pollOptions || []).map(o => {
                    const option = { name: o.name || null };
                    if (tally) {
                        option.votes = votersFor(tally, o).length;
                        option.voters = votersFor(tally, o);
                    }
                    return option;
                })
            };
        }
        if (MEDIA_KINDS.has(kind)) {
            msg.media = {
                mimetype: raw.mimetype || null,
                filename: raw.filename || null,
                size: toInt(raw.size),
                duration: toInt(raw.duration),
                status: thumbnail ? 'thumbnail' : 'not_downloaded'
            };
        }
        return msg;
    }

    /**
     * Merges WA-JS/IndexedDB messages (base) with DOM-scraped ones by messageKey. DOM entries
     * replace base ones except WA-JS entries, which carry exact ids, timestamps and types.
     * Sorted by timestamp (DOM index for ties) and trimmed to the request scope.
     * opts.domOnlyBefore (ms): DOM entries not in base are kept only if older than this, i.e.
     * history beyond what WA-JS covered. Inside that range they are duplicates or system
     * entries WA-JS leaves out on purpose (the DOM engine exports pins and notices as chat).
     */
    function mergeWithDom(base, dom, request = {}, opts = {}) {
        const merged = new Map();
        let noId = 0;
        const sig = m => m.id ? messageKey(m.id) : `no_id_${noId++}_${m.timestamp}`;

        (base || []).forEach(m => merged.set(sig(m), m));
        const cutoff = typeof opts.domOnlyBefore === 'number' ? opts.domOnlyBefore : Infinity;
        (dom || []).forEach(m => {
            const key = sig(m);
            const prev = merged.get(key);
            if (prev && prev.engine === 'wajs') return;
            if (!prev && !(m.timestamp < cutoff)) return;
            merged.set(key, m);
        });

        let out = Array.from(merged.values()).sort((a, b) => {
            if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
            if (typeof a.domIndex === 'number' && typeof b.domIndex === 'number') return a.domIndex - b.domIndex;
            return 0;
        });
        if (request.mode === 'date') {
            const start = request.start || 0;
            const end = request.end || Infinity;
            out = out.filter(m => m.timestamp >= start && m.timestamp <= end);
        } else if (request.mode === 'count') {
            const count = request.count || 100;
            if (out.length > count) out = out.slice(-count);
        }
        return out;
    }

    root.WAExporter.WajsMapper = { mapMessage, messageKey, mergeWithDom, kindOf, mentionCandidates, isExcluded, EXCLUDED_TYPES };
})();
