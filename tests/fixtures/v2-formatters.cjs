// Verbatim copy of the v2 popup formatters (popup/popup.js @ 19861b8), kept as the
// reference for schema-compatibility tests. Do not edit.
const pad = (n) => n.toString().padStart(2, '0');
let activeChatTitle = 'Chat';

    function buildExportMetadata(messages, params = {}) {
        const chat = activeChatTitle || 'WhatsApp Chat';
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
            const count = params.messageCount || params.count || messages.length;
            scopeStr = `Last ${count} Messages`;
        } else {
            scopeStr = `All Messages (${messages.length.toLocaleString()})`;
        }

        return {
            chatName: chat,
            exportDate: exportDateStr,
            exportTimestamp: now.getTime(),
            scope: mode,
            scopeLabel: scopeStr,
            totalMessages: messages.length
        };
    }

    function formatAsTxt(messages, meta) {
        const valid = (messages || []).filter(m => (m.content && m.content.trim() !== '') || m.mediaUrl);
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
            let content = m.content || '';
            if (m.aiCaption) {
                content += ` [AI: "${m.aiCaption}"]`;
            }
            if (m.aiTranscript) {
                content += ` [AI Transcript: "${m.aiTranscript}"]`;
            }
            if (m.rawFormat) {
                let text = m.rawFormat;
                if (m.aiCaption) text += ` [AI: "${m.aiCaption}"]`;
                if (m.aiTranscript) text += ` [AI Transcript: "${m.aiTranscript}"]`;
                return text;
            }
            return `[${new Date(m.timestamp).toLocaleTimeString()}] ${m.sender}: ${content}`;
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
        // Always delete thumbnail after processed by AI, or if thumbnails disabled
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
        return item;
    }

    function formatAsJson(messages, meta, params = {}) {
        const valid = (messages || []).filter(m => (m.content && m.content.trim() !== '') || m.mediaUrl);
        const cleaned = valid.map(m => cleanMessageForExport(m, params));
        return JSON.stringify({
            metadata: {
                chatName: meta.chatName,
                exportedAt: meta.exportDate,
                exportTimestamp: meta.exportTimestamp,
                scope: meta.scope,
                scopeLabel: meta.scopeLabel,
                totalMessages: cleaned.length
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

    function formatAsCsv(messages, meta, params = {}) {
        const includeThumbnails = params && params.captureThumbnails !== false;
        const valid = (messages || []).filter(m => (m.content && m.content.trim() !== '') || m.mediaUrl);
        const metaComments = [
            `# WhatsApp Chat Export: ${meta.chatName}`,
            `# Exported On: ${meta.exportDate}`,
            `# Scope: ${meta.scopeLabel} | Total Messages: ${valid.length}`
        ];

        const headers = ['Timestamp', 'Date', 'Time', 'Sender', 'Type', 'Content', 'AICaption', 'AITranscript', 'Thumbnail', 'QuotedSender', 'QuotedContent', 'MediaURL'];
        const rows = valid.map(m => {
            const d = new Date(m.timestamp);
            const dateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
            const timeStr = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
            const quotedSender = m.quotedMessage?.sender || '';
            const quotedContent = m.quotedMessage?.content || '';
            const thumbnailVal = includeThumbnails ? (m.thumbnail || '') : '';

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
                escapeCsvCell(m.mediaUrl || '')
            ].join(',');
        });

        return [...metaComments, headers.join(','), ...rows].join('\r\n');
    }

    function formatMessages(messages, format, params) {
        const meta = buildExportMetadata(messages, params);
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

module.exports = {
    formatMessages,
    setChatTitle(t) { activeChatTitle = t; }
};
