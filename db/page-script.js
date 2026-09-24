(function () {
    'use strict';

    if (window.__waPageScriptInjected) return;
    window.__waPageScriptInjected = true;

    // 1. Setup Blob interceptor
    if (!window.__waExpOriginalClick) {
        window.__waExpOriginalClick = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function () {
            if (this.download && this.href && this.href.startsWith('blob:')) {
                console.log("[WA-Exporter Page Script] Intercepted Audio Blob URL:", this.href);
                window.__waExpLastInterceptedBlob = this.href;
                return; // Cancel the actual download
            }
            return window.__waExpOriginalClick.apply(this, arguments);
        };
        console.log("[WA-Exporter Page Script] Blob Interceptor Injected Successfully.");
    }

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
            id: msg.id ? (msg.id._serialized || msg.id) : null,
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
        if (event.source !== window || !event.data || !event.data.__waExpReq) return;
        
        const { callbackId, action, params } = event.data;
        if (typeof callbackId !== 'string' || typeof action !== 'string') return;
        
        const allowedActions = ['capture_thumbnail', 'extract_audio_blob', 'extract', 'count'];
        if (!allowedActions.includes(action)) {
            window.postMessage({ __waExp: callbackId, error: 'Invalid action' }, '*');
            return;
        }
        
        // Strict parameter validation
        if (action === 'capture_thumbnail' && typeof params?.blobUrl !== 'string') {
            return window.postMessage({ __waExp: callbackId, error: 'Invalid blobUrl' }, '*');
        }
        if (action === 'extract') {
            if (params?.mode && typeof params.mode !== 'string') return window.postMessage({ __waExp: callbackId, error: 'Invalid mode' }, '*');
            if (params?.start && typeof params.start !== 'number') return window.postMessage({ __waExp: callbackId, error: 'Invalid start' }, '*');
            if (params?.end && typeof params.end !== 'number') return window.postMessage({ __waExp: callbackId, error: 'Invalid end' }, '*');
            if (params?.count && typeof params.count !== 'number') return window.postMessage({ __waExp: callbackId, error: 'Invalid count' }, '*');
        }

        // 1. Handle Thumbnail operations directly without opening IndexedDB
        if (action === 'capture_thumbnail') {
            try {
                const blobUrl = params?.blobUrl;
                const maxSize = params?.maxSize || 160;
                const quality = params?.quality || 0.5;
                const dataUri = await captureBlobThumbnail(blobUrl, maxSize, quality);
                window.postMessage({ __waExp: callbackId, result: dataUri }, '*');
            } catch (err) {
                window.postMessage({ __waExp: callbackId, error: err.message }, '*');
            }
            return;
        }

        if (action === 'batch_thumbnails') {
            try {
                const items = params?.items || []; // Array of { key, blobUrl }
                const maxSize = params?.maxSize || 160;
                const quality = params?.quality || 0.5;
                const results = {};

                for (const item of items) {
                    if (item && item.blobUrl) {
                        const dataUri = await captureBlobThumbnail(item.blobUrl, maxSize, quality);
                        if (dataUri) results[item.key] = dataUri;
                    }
                }

                window.postMessage({ __waExp: callbackId, result: results }, '*');
            } catch (err) {
                window.postMessage({ __waExp: callbackId, error: err.message }, '*');
            }
            return;
        }

        if (action === 'extract_audio_blob') {
            console.log('[WA-Exporter Page Script] Received extract_audio_blob for messageId:', params?.messageId);
            try {
                const messageId = params?.messageId;
                let blobUrl = null;
                if (messageId) {
                    const msgEl = document.querySelector(`[data-id="${messageId}"]`);
                    console.log('[WA-Exporter Page Script] msgEl found:', !!msgEl);
                    if (msgEl) {
                        window.__waExpLastInterceptedBlob = null;

                        // Helper function to wait for an element to appear in the DOM
                        const waitForElement = async (container, selector, maxWaitMs = 1500) => {
                            const startTime = Date.now();
                            while (Date.now() - startTime < maxWaitMs) {
                                const el = container.querySelector(selector) || container.parentElement?.querySelector(selector);
                                if (el) return el;
                                await new Promise(resolve => setTimeout(resolve, 50));
                            }
                            return null;
                        };

                        // Dispatch right-click to open the context menu directly!
                        // Target the innermost message container so we don't click empty space
                        const clickTarget = msgEl.querySelector('[data-testid="msg-container"]') || msgEl.firstChild || msgEl;
                        console.log('[WA-Exporter Page Script] Dispatching contextmenu event on target:', clickTarget.tagName);

                        // Scroll into view so getBoundingClientRect() returns valid screen coordinates
                        clickTarget.scrollIntoView({ behavior: 'instant', block: 'center' });
                        await new Promise(r => setTimeout(r, 150));

                        const rect = clickTarget.getBoundingClientRect();
                        const cx = rect.x + (rect.width / 2);
                        const cy = rect.y + (rect.height / 2);
                        const eventOpts = {
                            bubbles: true, cancelable: true, view: window,
                            button: 2, buttons: 2, clientX: cx, clientY: cy
                        };

                        // Full modern web app right-click sequence
                        clickTarget.dispatchEvent(new PointerEvent('pointerdown', eventOpts));
                        clickTarget.dispatchEvent(new MouseEvent('mousedown', eventOpts));
                        clickTarget.dispatchEvent(new PointerEvent('pointerup', eventOpts));
                        clickTarget.dispatchEvent(new MouseEvent('mouseup', eventOpts));
                        clickTarget.dispatchEvent(new MouseEvent('contextmenu', eventOpts));

                        // Wait for any dropdown/menu list to render anywhere in the body
                        const dropdownSelector = 'ul, [data-testid="dropdown-list"], [role="menu"]';
                        const dropdownItemFound = await waitForElement(document.body, dropdownSelector, 1500);

                        if (!dropdownItemFound) {
                            console.log('[WA-Exporter Page Script] Dropdown menu items failed to render after contextmenu.');
                        } else {
                            // Find the "Download" button by scanning text inside all reasonable clickable elements
                            // We filter out any elements that belong to the chat message itself
                            const possibleItems = Array.from(document.querySelectorAll('div, li, span, button')).filter(el => {
                                const text = el.innerText || el.getAttribute('aria-label') || "";
                                return text.match(/Download|Descargar|Baixar/i) && !msgEl.contains(el);
                            });

                            console.log('[WA-Exporter Page Script] possible download items found:', possibleItems.length);

                            let downloadClicked = false;

                            // Iterate backwards to click the most deeply nested target (the actual button, not its wrapper container)
                            for (let i = possibleItems.length - 1; i >= 0; i--) {
                                const item = possibleItems[i];
                                // Ensure it's inside a menu to avoid clicking random UI elements
                                if (item.closest('ul') || item.closest('[role="menu"]') || item.closest('[role="application"]')) {
                                    item.click();
                                    console.log('[WA-Exporter Page Script] Download button clicked!');
                                    downloadClicked = true;
                                    break;
                                }
                            }

                            if (!downloadClicked) {
                                console.log('[WA-Exporter Page Script] Download button NOT found, closing menu.');
                                document.body.click();
                            } else {
                                await new Promise(r => setTimeout(r, 250));
                                const interceptedUrl = window.__waExpLastInterceptedBlob || null;
                                if (interceptedUrl) {
                                    try {
                                        console.log('[WA-Exporter Page Script] Fetching intercepted blob URL...');
                                        const res = await fetch(interceptedUrl);
                                        const blob = await res.blob();
                                        blobUrl = await new Promise((resolve) => {
                                            const reader = new FileReader();
                                            reader.onloadend = () => resolve(reader.result);
                                            reader.readAsDataURL(blob);
                                        });
                                        console.log('[WA-Exporter Page Script] Successfully converted intercepted blob to Base64!');
                                    } catch (e) {
                                        console.error('[WA-Exporter Page Script] Failed to fetch and convert intercepted blob:', e);
                                        blobUrl = interceptedUrl; // Fallback just in case
                                    }
                                }
                            }
                        }

                        // Remove focus/hover from the message to clean up the UI
                        msgEl.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true, cancelable: true }));
                        const msgContainer = msgEl.querySelector('[data-testid="msg-container"]');
                        if (msgContainer) msgContainer.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true, cancelable: true }));
                    }
                }

                // Truncate for logging so we don't spam the console with Base64 strings
                const logUrl = blobUrl?.length > 100 ? blobUrl.substring(0, 50) + '... (Base64)' : blobUrl;
                console.log('[WA-Exporter Page Script] Sending back result:', logUrl);

                window.postMessage({ __waExp: callbackId, result: blobUrl }, '*');
            } catch (err) {
                console.error('[WA-Exporter Page Script] Error in extract_audio_blob:', err);
                window.postMessage({ __waExp: callbackId, error: err.message }, '*');
            }
            return;
        }

        // 2. Handle Database queries (count / extract)
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

                    window.postMessage({ 
                        __waExp: callbackId, 
                        result: {
                            data: result,
                            earliestAvailable: formatted.length > 0 ? formatted[0].timestamp : null
                        } 
                    }, '*');
                    return;
                }

                window.postMessage({ __waExp: callbackId, error: `Unknown action: ${action}` }, '*');
            };
        } catch (e) {
            window.postMessage({ __waExp: callbackId, error: e.message }, '*');
        }
    });

    async function captureBlobThumbnail(url, maxSize = 160, quality = 0.5) {
        if (!url || typeof url !== 'string') return null;
        try {
            const img = await new Promise((resolve, reject) => {
                const i = new Image();
                i.crossOrigin = 'anonymous';
                i.onload = () => resolve(i);
                i.onerror = () => reject(new Error('Image failed to load'));
                i.src = url;
            });

            let width = img.naturalWidth || img.width;
            let height = img.naturalHeight || img.height;
            if (!width || !height) return null;

            if (width > height) {
                if (width > maxSize) {
                    height = Math.round((height * maxSize) / width);
                    width = maxSize;
                }
            } else {
                if (height > maxSize) {
                    width = Math.round((width * maxSize) / height);
                    height = maxSize;
                }
            }

            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, width);
            canvas.height = Math.max(1, height);
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, width, height);

            let dataUrl = canvas.toDataURL('image/webp', quality);
            if (!dataUrl || !dataUrl.startsWith('data:image/webp')) {
                dataUrl = canvas.toDataURL('image/jpeg', quality);
            }
            return dataUrl;
        } catch (e) {
            console.warn('[WA-Exporter PageScript] captureBlobThumbnail error:', e);
            return null;
        }
    }
})();
