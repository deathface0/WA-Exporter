if (!window.waExporterInjected) {
    window.waExporterInjected = true;

    /* ── Page-Context IndexedDB Bridge ── */
    // Content scripts live in an isolated world and cannot access the page's
    // IndexedDB directly.  We inject a <script> that runs in the MAIN world,
    // queries the DB, and posts the result back via window.postMessage.

    const PAGE_SCRIPT = `
    async function getActiveChatId(db) {
        // METHOD 1: React Fiber (Instant & Accurate)
        try {
            const header = document.querySelector('header[data-testid="conversation-header"]');
            if (header) {
                const fiberKey = Object.keys(header).find(k => k.startsWith('__reactFiber$'));
                if (fiberKey) {
                    let node = header[fiberKey];
                    let depth = 0;
                    while (node && depth < 50) {
                        const props = node.pendingProps || node.memoizedProps;
                        if (props && props.chat && props.chat.id) {
                            return props.chat.id._serialized || props.chat.id;
                        }
                        node = node.return;
                        depth++;
                    }
                }
            }
        } catch (e) {
            console.warn("[WA-Exporter] React Fiber check failed:", e);
        }

        // METHOD 2: IndexedDB Title Match (Fast Fallback)
        const titleNode = document.querySelector('#main header [data-testid="conversation-info-header-chat-title"]');
        if (!titleNode) return null;
        
        const chatTitle = titleNode.textContent;

        return new Promise((resolve) => {
            const tx = db.transaction(["chat"], "readonly");
            const store = tx.objectStore("chat");
            
            store.getAll().onsuccess = (e) => {
                const chats = e.target.result;
                const matches = chats.filter(c => c.name === chatTitle || c.formattedTitle === chatTitle);
                resolve(matches.length > 0 ? matches[0].id : null);
            };
            tx.onerror = () => resolve(null);
        });
    }

    function __waExporterQuery(callbackId, action, params) {
        try {
            const request = indexedDB.open('model-storage');
            
            request.onerror = () => {
                window.postMessage({ __waExp: callbackId, error: 'Cannot open model-storage' }, '*');
            };
            
            request.onsuccess = async (event) => {
                const db = event.target.result;

                if (!db.objectStoreNames.contains('message')) {
                    db.close();
                    window.postMessage({ __waExp: callbackId, error: 'message store not found' }, '*');
                    return;
                }

                const chatId = await getActiveChatId(db);
                if (!chatId) {
                    db.close();
                    window.postMessage({ __waExp: callbackId, error: 'Por favor, abre un chat primero.' }, '*');
                    return;
                }

                const tx    = db.transaction('message', 'readonly');
                const store = tx.objectStore('message');
                const all   = await new Promise((res, rej) => {
                    const r = store.getAll();
                    r.onsuccess = () => res(r.result);
                    r.onerror   = () => rej(new Error('Failed to read messages'));
                });
                db.close();

                const chatMsgs = all.filter(m => {
                    try {
                        const remote = m.id?.remote?._serialized || m.id?.remote;
                        return remote === chatId;
                    } catch { return false; }
                });

                if (action === 'count') {
                    const validTypes = ['chat','image','video','audio','ptt','document',
                                        'sticker','location','vcard','revoked'];
                    const count = chatMsgs.filter(m => validTypes.includes(m.type)).length;
                    window.postMessage({ __waExp: callbackId, result: { count, chatId } }, '*');
                    return;
                }

                if (action === 'extract') {
                    const validTypes = ['chat','image','video','audio','ptt','document',
                                        'sticker','location','vcard','revoked'];
                    let msgs = chatMsgs.filter(m => validTypes.includes(m.type));
                    msgs.sort((a, b) => (a.t || 0) - (b.t || 0));

                    const typeMap = {
                        image: '[Imagen]', video: '[Video]', audio: '[Audio]',
                        ptt: '[Audio]', document: '[Archivo]', sticker: '[Sticker]',
                        location: '[Ubicación]', vcard: '[Contacto]', revoked: '[Mensaje eliminado]'
                    };
                    const pad = n => n.toString().padStart(2, '0');

                    const formatted = msgs.map(msg => {
                        const ts = (msg.t || 0) * 1000;
                        const d  = new Date(ts);
                        const dateStr = pad(d.getDate()) + '/' + pad(d.getMonth()+1) + '/' + d.getFullYear();
                        const timeStr = pad(d.getHours()) + ':' + pad(d.getMinutes());

                        let sender;
                        if (msg.id?.fromMe) {
                            sender = 'Yo';
                        } else {
                            sender = msg.notifyName || msg.author || msg.participant || 'Contacto';
                            if (typeof sender === 'object' && sender._serialized) sender = sender._serialized;
                            if (typeof sender === 'string' && sender.includes('@')) sender = sender.split('@')[0];
                        }

                        let content;
                        if (msg.type === 'revoked') {
                            content = '[Mensaje eliminado]';
                        } else {
                            const media = typeMap[msg.type] || '';
                            const body  = msg.body || msg.caption || '';
                            content = media ? (body ? media + ' ' + body : media)
                                            : (body || '[Contenido Multimedia]');
                        }

                        let quoted = '';
                        if (msg.quotedMsg) {
                            const qText = msg.quotedMsg.body || msg.quotedMsg.caption
                                          || typeMap[msg.quotedMsg.type] || '[Media]';
                            quoted = '[Respondiendo a: "' + qText + '"] ';
                        }

                        return {
                            timestamp: ts,
                            rawFormat: '[' + timeStr + ', ' + dateStr + '] ' + sender + ': ' + quoted + content
                        };
                    });

                    window.postMessage({ __waExp: callbackId, result: formatted }, '*');
                    return;
                }

                window.postMessage({ __waExp: callbackId, error: 'Unknown action' }, '*');
            };
        } catch (e) {
            window.postMessage({ __waExp: callbackId, error: e.message }, '*');
        }
    }
    `;

    // Inject the helper function once into the page
    const initScript = document.createElement('script');
    initScript.textContent = PAGE_SCRIPT;
    document.documentElement.appendChild(initScript);
    initScript.remove();

    function queryDB(action, params = {}) {
        return new Promise((resolve, reject) => {
            const cbId = 'cb_' + Math.random().toString(36).slice(2, 10);

            const handler = (event) => {
                if (event.data?.__waExp !== cbId) return;
                window.removeEventListener('message', handler);
                if (event.data.error) reject(new Error(event.data.error));
                else resolve(event.data.result);
            };
            window.addEventListener('message', handler);

            // Safety timeout
            setTimeout(() => {
                window.removeEventListener('message', handler);
                reject(new Error('IndexedDB query timed out'));
            }, 60000);

            const callScript = document.createElement('script');
            callScript.textContent = `__waExporterQuery(${JSON.stringify(cbId)}, ${JSON.stringify(action)}, ${JSON.stringify(params)});`;
            document.documentElement.appendChild(callScript);
            callScript.remove();
        });
    }

    /* ── Extraction Logic ── */

    async function runExtraction(options) {
        let messages = await queryDB('extract');

        const mode = options.mode || 'all';

        if (mode === 'date') {
            const start = options.start;
            const end = options.end;
            messages = messages.filter(m => m.timestamp >= start && m.timestamp <= end);
        } else if (mode === 'count') {
            messages = messages.slice(-options.count);
        }
        // mode === 'all' → return everything

        return messages;
    }

    /* ── Message Listener ── */

    browser.runtime.onMessage.addListener((request, _sender, sendResponse) => {
        if (request.action === 'get_chat_info') {
            queryDB('count')
                .then(res => sendResponse({ chatId: res.chatId, totalMessages: res.count }))
                .catch(err => sendResponse({ chatId: null, totalMessages: 0, error: err.message }));
            return true;
        }

        if (request.action === 'extract_chat') {
            runExtraction(request)
                .then(data => sendResponse({ data }))
                .catch(err => sendResponse({ data: null, error: err.message }));
            return true;
        }
    });
}