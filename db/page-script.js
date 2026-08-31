(function() {
    'use strict';

    if (window.__waPageScriptInjected) return;
    window.__waPageScriptInjected = true;

    async function getActiveChatId(db) {
        // METHOD 1: React Fiber on conversation header (Fastest & direct)
        try {
            const header = document.querySelector('header[data-testid="conversation-header"]') ||
                           document.querySelector('#main header');
            if (header) {
                const fiberKey = Object.keys(header).find(k => k.startsWith('__reactFiber$'));
                if (fiberKey) {
                    let node = header[fiberKey];
                    let depth = 0;
                    while (node && depth < 60) {
                        const props = node.pendingProps || node.memoizedProps;
                        if (props && props.chat && props.chat.id) {
                            return props.chat.id._serialized || props.chat.id;
                        }
                        if (props && props.channel && props.channel.id) {
                            return props.channel.id._serialized || props.channel.id;
                        }
                        node = node.return;
                        depth++;
                    }
                }
            }
        } catch (e) {
            console.warn('[WA-Exporter] React Fiber check failed:', e);
        }

        // METHOD 2: Title match in IndexedDB 'chat' store
        try {
            const titleNode = document.querySelector('#main header [data-testid="conversation-info-header-chat-title"]') ||
                              document.querySelector('#main header span[dir="auto"]');
            if (titleNode && db.objectStoreNames.contains('chat')) {
                const chatTitle = titleNode.textContent.trim();
                const matchedId = await new Promise((resolve) => {
                    const tx = db.transaction(['chat'], 'readonly');
                    const store = tx.objectStore('chat');
                    const req = store.getAll();
                    req.onsuccess = (e) => {
                        const chats = e.target.result || [];
                        const match = chats.find(c => c.name === chatTitle || c.formattedTitle === chatTitle);
                        resolve(match ? (match.id?._serialized || match.id) : null);
                    };
                    req.onerror = () => resolve(null);
                });
                if (matchedId) return matchedId;
            }
        } catch (e) {
            console.warn('[WA-Exporter] Chat title match failed:', e);
        }

        return null;
    }

    const typeMap = {
        chat: '',
        image: '[Image]',
        video: '[Video]',
        audio: '[Audio]',
        ptt: '[Voice Note]',
        document: '[Document]',
        sticker: '[Sticker]',
        location: '[Location]',
        vcard: '[Contact]',
        revoked: '[Deleted message]'
    };

    const pad = n => n.toString().padStart(2, '0');

    function formatMessageRecord(msg) {
        const ts = (msg.t || 0) * 1000;
        const d = new Date(ts);
        const dateStr = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
        const timeStr = `${pad(d.getHours())}:${pad(d.getMinutes())}`;

        let sender;
        if (msg.id?.fromMe) {
            sender = 'Me';
        } else {
            sender = msg.notifyName || msg.author || msg.participant || 'Contact';
            if (typeof sender === 'object' && sender._serialized) sender = sender._serialized;
            if (typeof sender === 'string' && sender.includes('@')) sender = sender.split('@')[0];
        }

        let typeKey = msg.type || 'chat';
        let typeLabel = typeMap[typeKey] || '[Media]';
        let body = msg.body || msg.caption || '';
        let content = '';

        if (typeKey === 'revoked') {
            content = '[Deleted message]';
        } else if (typeKey === 'chat') {
            content = body;
        } else if (typeKey === 'poll_creation' || typeKey === 'poll') {
            const title = msg.pollName || msg.caption || body || 'Poll';
            let opts = '';
            if (Array.isArray(msg.pollOptions)) {
                opts = ': ' + msg.pollOptions.map(o => `${o.name || o.optionName || 'Option'} (0 votes)`).join(' | ');
            }
            content = `[Poll] ${title}${opts}`;
        } else if (typeKey === 'vcard' || typeKey === 'multi_vcard') {
            const cName = msg.vcardFormattedName || body || 'Contact';
            content = `[Contact] ${cName}`;
        } else {
            if (msg.filename) {
                content = `${typeLabel} ${msg.filename}` + (body ? ` - ${body}` : '');
            } else {
                content = body ? `${typeLabel} ${body}` : typeLabel;
            }
        }

        let quotedPrefix = '';
        let quotedObj = null;
        if (msg.quotedMsg) {
            const qType = msg.quotedMsg.type || 'chat';
            const qLabel = typeMap[qType] || '[Media]';
            const qBody = msg.quotedMsg.body || msg.quotedMsg.caption || (qType !== 'chat' ? qLabel : '');
            const qSender = msg.quotedParticipant ? (msg.quotedParticipant.split ? msg.quotedParticipant.split('@')[0] : 'Contact') : 'Contact';
            quotedObj = {
                sender: qSender,
                content: qBody
            };
            const senderLabel = qSender && qSender !== 'Contact' ? `${qSender}: ` : '';
            quotedPrefix = `[Replying to ${senderLabel}"${qBody}"] `;
        }
        const rawFormat = `[${timeStr}, ${dateStr}] ${sender}: ${quotedPrefix}${content}`;

        return {
            timestamp: ts,
            sender: sender,
            type: typeKey,
            content: content,
            quotedMessage: quotedObj,
            mediaUrl: null,
            rawFormat: rawFormat
        };
    }

    window.addEventListener('message', async (event) => {
        if (!event.data || !event.data.__waExpReq) return;
        const { callbackId, action, params } = event.data;

        try {
            const request = indexedDB.open('model-storage');

            request.onerror = () => {
                window.postMessage({ __waExp: callbackId, error: 'Cannot open model-storage' }, '*');
            };

            request.onsuccess = async (ev) => {
                const db = ev.target.result;

                if (!db.objectStoreNames.contains('message')) {
                    db.close();
                    window.postMessage({ __waExp: callbackId, error: 'Message store not found in IndexedDB' }, '*');
                    return;
                }

                const chatId = await getActiveChatId(db);
                if (!chatId) {
                    db.close();
                    window.postMessage({ __waExp: callbackId, error: 'Please open a chat in WhatsApp Web first.' }, '*');
                    return;
                }

                const tx = db.transaction('message', 'readonly');
                const store = tx.objectStore('message');
                const all = await new Promise((res, rej) => {
                    const r = store.getAll();
                    r.onsuccess = () => res(r.result || []);
                    r.onerror = () => rej(new Error('Failed to read messages from IndexedDB'));
                });
                db.close();

                const chatMsgs = all.filter(m => {
                    try {
                        const remote = m.id?.remote?._serialized || m.id?.remote;
                        return remote === chatId;
                    } catch { return false; }
                });

                const validTypes = ['chat', 'image', 'video', 'audio', 'ptt', 'document',
                                    'sticker', 'location', 'vcard', 'revoked'];

                if (action === 'count') {
                    const count = chatMsgs.filter(m => validTypes.includes(m.type)).length;
                    window.postMessage({ __waExp: callbackId, result: { count, chatId } }, '*');
                    return;
                }

                if (action === 'extract') {
                    let msgs = chatMsgs.filter(m => validTypes.includes(m.type));
                    msgs.sort((a, b) => (a.t || 0) - (b.t || 0));

                    const formatted = msgs.map(formatMessageRecord);

                    // Filter based on requested mode & parameters
                    let result = formatted;
                    const mode = params?.mode || 'all';
                    if (mode === 'date') {
                        const start = params.start || 0;
                        const end = params.end || Infinity;
                        result = formatted.filter(m => m.timestamp >= start && m.timestamp <= end);
                    } else if (mode === 'count') {
                        const count = params.count || 100;
                        result = formatted.slice(-count);
                    }

                    window.postMessage({ __waExp: callbackId, result }, '*');
                    return;
                }

                window.postMessage({ __waExp: callbackId, error: `Unknown action: ${action}` }, '*');
            };
        } catch (e) {
            window.postMessage({ __waExp: callbackId, error: e.message }, '*');
        }
    });
})();
