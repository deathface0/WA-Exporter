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

    const MEDIA_KINDS = new Set(['image', 'video', 'gif', 'audio', 'ptt', 'document', 'sticker']);
    const THUMBNAIL_KINDS = new Set(['image', 'video', 'gif']);

    function kindOf(raw) {
        if (raw.isViewOnce) return 'view_once';
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

    function displayName(jid, notifyName, ctx) {
        if (!jid) return notifyName || 'Contact';
        if (ctx.selfJids && ctx.selfJids.has(jid)) return 'Me';
        if (!ctx.isGroup && ctx.chatTitle) return ctx.chatTitle;
        if (notifyName) return notifyName;
        const server = jidServer(jid);
        if (server === 'c.us') return jidUser(jid);
        if (server === 'lid') return 'LID:' + jidUser(jid);
        return 'Contact';
    }

    function contentFor(kind, raw) {
        const label = LABELS[kind];
        switch (kind) {
            case 'chat':
                return raw.body || '';
            case 'image':
            case 'video':
            case 'gif':
                return raw.caption ? `${label} ${raw.caption}` : label;
            case 'audio':
            case 'ptt':
            case 'sticker':
            case 'revoked':
            case 'view_once':
                return label;
            case 'document': {
                const name = raw.filename || 'document';
                return raw.caption && raw.caption !== name ? `${label} ${name} - ${raw.caption}` : `${label} ${name}`;
            }
            case 'location':
                return `${label} ${mapsUrl(raw)}`;
            case 'vcard':
                return `${label} ${raw.vcardFormattedName || 'Contact'}`;
            case 'poll': {
                const names = (raw.pollOptions || []).map(o => o.name).filter(Boolean);
                return `${label} ${raw.pollName || 'Poll'}${names.length ? ': ' + names.join(' | ') : ''}`;
            }
            default:
                return '[Media]';
        }
    }

    function mapsUrl(raw) {
        return `https://maps.google.com/?q=${raw.lat},${raw.lng}`;
    }

    function quotedContent(q) {
        if (!q) return '[Media]';
        const kind = q.type === 'poll_creation' ? 'poll' : (q.type || 'chat');
        if (kind === 'chat') return q.body || '[Media]';
        const label = LABELS[kind] || '[Media]';
        const text = q.caption || (kind === 'document' ? q.filename : null);
        return text ? `${label} ${text}` : label;
    }

    function toInt(value) {
        const n = parseInt(value, 10);
        return Number.isFinite(n) ? n : null;
    }

    /**
     * ctx: { chatId, chatTitle, isGroup, selfJids: Set<string> }
     * Returns null for entries that are not exported.
     */
    function mapMessage(raw, ctx) {
        if (!raw || !raw.id || typeof raw.t !== 'number') return null;
        if (EXCLUDED_TYPES.has(raw.type)) return null;

        const kind = kindOf(raw);
        const senderId = raw.fromMe
            ? (raw.author || raw.from || null)
            : (ctx.isGroup ? raw.author : raw.from) || null;
        const sender = raw.fromMe ? 'Me' : displayName(senderId, raw.notifyName, ctx);

        const timestamp = raw.t * 1000;
        const d = new Date(timestamp);
        const dateStr = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
        const timeStr = `${pad(d.getHours())}:${pad(d.getMinutes())}`;

        const content = contentFor(kind, raw);

        let quotedMessage = null;
        if (raw.quotedMsg) {
            quotedMessage = {
                sender: displayName(raw.quotedParticipant, null, ctx),
                content: quotedContent(raw.quotedMsg),
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
            senderPhone: jidServer(senderId) === 'c.us' ? jidUser(senderId) : null,
            isForwarded: !!raw.isForwarded,
            forwardingScore: toInt(raw.forwardingScore),
            isEdited: !!raw.latestEditMsgKey,
            editedAt: typeof raw.latestEditSenderTimestampMs === 'number' ? raw.latestEditSenderTimestampMs : null,
            mentions: (raw.mentionedJidList || []).map(jid => ({ jid }))
        };

        if (kind === 'location') {
            msg.location = { lat: raw.lat, lng: raw.lng, name: raw.loc || null };
        }
        if (kind === 'poll') {
            msg.poll = {
                question: raw.pollName || null,
                selectableCount: toInt(raw.pollSelectableOptionsCount),
                options: (raw.pollOptions || []).map(o => ({ name: o.name || null }))
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

    root.WAExporter.WajsMapper = { mapMessage, messageKey, kindOf, EXCLUDED_TYPES };
})();
