(function () {
    'use strict';

    // Shared TXT/JSON/CSV formatters for the popup and the in-page auto actions.
    // v2 fields keep their names, order and meaning; WA-JS fields are only appended.

    const root = typeof window !== 'undefined' ? window : globalThis;
    root.WAExporter = root.WAExporter || {};

    const pad = (n) => n.toString().padStart(2, '0');

    const CSV_HEADERS = ['Timestamp', 'Date', 'Time', 'Sender', 'Type', 'Content', 'AICaption', 'AITranscript', 'Thumbnail', 'QuotedSender', 'QuotedContent', 'MediaURL'];
    const CSV_HEADERS_V3 = ['MessageId', 'SenderId', 'IsForwarded', 'IsEdited', 'Reactions', 'MediaStatus'];

    // Appended to JSON messages only for WA-JS messages, so DOM exports stay identical to v2.
    const WAJS_FIELDS = ['id', 'chatId', 'fromMe', 'senderId', 'senderLid', 'senderPhone', 'isForwarded', 'forwardingScore',
        'isEdited', 'editedAt', 'mentions', 'reactions', 'poll', 'location', 'media', 'engine'];

    function localDate(ms) {
        const d = new Date(ms);
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }

    function isWajs(m) {
        return m && m.engine === 'wajs';
    }

    function exportable(messages) {
        return (messages || []).filter(m => (m.content && m.content.trim() !== '') || m.mediaUrl);
    }

    function buildExportMetadata(messages, params = {}, chatTitle = 'WhatsApp Chat', resultMeta = {}) {
        const now = new Date();
        const exportDateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

        const mode = params.mode || 'all';
        let scopeStr = 'All Messages';
        if (mode === 'date') {
            const s = params.startTime;
            const e = params.endTime;
            const sFmt = s ? new Date(s).toLocaleString() : 'Start';
            const eFmt = e ? new Date(e).toLocaleString() : 'End';
            scopeStr = `Date Range (${sFmt} to ${eFmt})`;
        } else if (mode === 'count') {
            const count = params.count || params.messageCount || messages.length;
            scopeStr = `Last ${count} Messages`;
        } else {
            scopeStr = `All Messages (${messages.length.toLocaleString()})`;
        }

        return {
            chatName: chatTitle || 'WhatsApp Chat',
            exportDate: exportDateStr,
            exportTimestamp: now.getTime(),
            scope: mode,
            scopeLabel: scopeStr,
            totalMessages: messages.length,
            engine: resultMeta.engine || 'dom',
            isPartial: !!resultMeta.isPartial,
            fallbackReason: resultMeta.fallbackReason || null,
            waVersion: resultMeta.waVersion || null,
            wajsVersion: resultMeta.wajsVersion || null
        };
    }

    function formatAsTxt(messages, meta) {
        const valid = exportable(messages);
        const header = [
            '==================================================',
            `  WhatsApp Chat Export: ${meta.chatName}`,
            `  Exported On: ${meta.exportDate}`,
            `  Scope: ${meta.scopeLabel}`,
            `  Total Messages: ${valid.length.toLocaleString()}`,
            '==================================================',
            '',
            ''
        ].join('\n');

        const body = valid.map(m => {
            let flags = '';
            if (isWajs(m)) {
                if (m.isForwarded) flags += ' (forwarded)';
                if (m.isEdited) flags += ' (edited)';
            }
            let ai = '';
            if (m.aiCaption) ai += ` [AI: "${m.aiCaption}"]`;
            if (m.aiTranscript) ai += ` [AI Transcript: "${m.aiTranscript}"]`;

            if (m.rawFormat) {
                return m.rawFormat + flags + ai;
            }
            return `[${new Date(m.timestamp).toLocaleTimeString()}] ${m.sender}: ${m.content || ''}${flags}${ai}`;
        }).join('\n');

        return header + body;
    }

    function cleanMessageForExport(m, params = {}) {
        const includeThumbnails = params && params.captureThumbnails !== false;
        const item = {
            timestamp: m.timestamp,
            sender: m.sender,
            type: m.type,
            content: m.content
        };
        if (includeThumbnails && m.thumbnail) {
            item.thumbnail = m.thumbnail;
        }
        if (m.aiCaption) {
            item.aiCaption = m.aiCaption;
        }
        if (m.aiTranscript) {
            item.aiTranscript = m.aiTranscript;
        }
        item.quotedMessage = m.quotedMessage || null;
        item.mediaUrl = m.mediaUrl || null;
        item.rawFormat = m.rawFormat;

        if (isWajs(m)) {
            WAJS_FIELDS.forEach(f => {
                if (m[f] !== undefined) item[f] = m[f];
            });
        }
        return item;
    }

    function formatAsJson(messages, meta, params = {}) {
        const cleaned = exportable(messages).map(m => cleanMessageForExport(m, params));
        return JSON.stringify({
            metadata: {
                chatName: meta.chatName,
                exportedAt: meta.exportDate,
                exportTimestamp: meta.exportTimestamp,
                scope: meta.scope,
                scopeLabel: meta.scopeLabel,
                totalMessages: cleaned.length,
                engine: meta.engine,
                isPartial: meta.isPartial,
                fallbackReason: meta.fallbackReason,
                waVersion: meta.waVersion,
                wajsVersion: meta.wajsVersion
            },
            messages: cleaned
        }, null, 2);
    }

    function escapeCsvCell(val) {
        if (val === null || val === undefined) return '""';
        let str = String(val);
        if (/^[=+\-@]/.test(str)) {
            str = "'" + str;
        }
        str = str.replace(/"/g, '""');
        return `"${str}"`;
    }

    function formatReactions(reactions) {
        if (!Array.isArray(reactions) || !reactions.length) return '';
        return reactions.map(r => `${r.emoji}${r.count}`).join(' ');
    }

    function formatAsCsv(messages, meta, params = {}) {
        const includeThumbnails = params && params.captureThumbnails !== false;
        const valid = exportable(messages);
        const metaComments = [
            `# WhatsApp Chat Export: ${meta.chatName}`,
            `# Exported On: ${meta.exportDate}`,
            `# Scope: ${meta.scopeLabel} | Total Messages: ${valid.length}`
        ];

        const headers = CSV_HEADERS.concat(CSV_HEADERS_V3);
        const rows = valid.map(m => {
            const d = new Date(m.timestamp);
            const dateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
            const timeStr = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
            const quotedSender = m.quotedMessage?.sender || '';
            const quotedContent = m.quotedMessage?.content || '';
            const thumbnailVal = includeThumbnails ? (m.thumbnail || '') : '';
            const w = isWajs(m);

            return [
                escapeCsvCell(m.timestamp),
                escapeCsvCell(dateStr),
                escapeCsvCell(timeStr),
                escapeCsvCell(m.sender),
                escapeCsvCell(m.type),
                escapeCsvCell(m.content),
                escapeCsvCell(m.aiCaption || ''),
                escapeCsvCell(m.aiTranscript || ''),
                escapeCsvCell(thumbnailVal),
                escapeCsvCell(quotedSender),
                escapeCsvCell(quotedContent),
                escapeCsvCell(m.mediaUrl || ''),
                escapeCsvCell(w ? m.id : ''),
                escapeCsvCell(w ? m.senderId : ''),
                escapeCsvCell(w ? String(!!m.isForwarded) : ''),
                escapeCsvCell(w ? String(!!m.isEdited) : ''),
                escapeCsvCell(w ? formatReactions(m.reactions) : ''),
                escapeCsvCell(w && m.media ? m.media.status : '')
            ].join(',');
        });

        return [...metaComments, headers.join(','), ...rows].join('\r\n');
    }

    function formatMessages(messages, format, params = {}, chatTitle = 'WhatsApp Chat', resultMeta = {}) {
        const meta = buildExportMetadata(messages, params, chatTitle, resultMeta);
        switch (format) {
            case 'json':
                return { text: formatAsJson(messages, meta, params), mime: 'application/json', ext: 'json' };
            case 'csv':
                return { text: formatAsCsv(messages, meta, params), mime: 'text/csv;charset=utf-8;', ext: 'csv' };
            case 'txt':
            default:
                return { text: formatAsTxt(messages, meta), mime: 'text/plain;charset=utf-8;', ext: 'txt' };
        }
    }

    function generateFilename(chatTitle, params = {}, ext = 'txt') {
        const cleanTitle = (chatTitle || 'chat').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 25) || 'chat';
        const ts = Date.now();
        const mode = params.mode || 'all';

        if (mode === 'date') {
            const start = params.startTime ? String(params.startTime).split('T')[0] : (params.start ? localDate(params.start) : 'start');
            const end = params.endTime ? String(params.endTime).split('T')[0] : (params.end ? localDate(params.end) : 'end');
            return `WA_${cleanTitle}_${start}_to_${end}_${ts}.${ext}`;
        } else if (mode === 'count') {
            const count = params.count || params.messageCount || 'count';
            return `WA_${cleanTitle}_${count}msgs_${ts}.${ext}`;
        }
        return `WA_${cleanTitle}_all_${ts}.${ext}`;
    }

    root.WAExporter.Formatters = {
        CSV_HEADERS,
        CSV_HEADERS_V3,
        buildExportMetadata,
        cleanMessageForExport,
        formatMessages,
        generateFilename
    };
})();
