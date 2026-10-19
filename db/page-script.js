(function () {
    'use strict';

    if (window.__waPageScriptInjected) return;
    window.__waPageScriptInjected = true;

    // 1. Blob interceptor, only while extract_audio_blob runs: it swallows blob downloads
    // (WhatsApp's own "Download" included), so it must not stay installed. Restored a few
    // seconds after the last use in case WhatsApp clicks the anchor late.
    const INTERCEPTOR_GRACE_MS = 5000;
    let interceptorUsers = 0;
    let restoreTimer = null;

    function installInterceptor() {
        interceptorUsers++;
        clearTimeout(restoreTimer);
        if (window.__waExpOriginalClick) return;
        window.__waExpOriginalClick = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function () {
            if (this.download && this.href && this.href.startsWith('blob:')) {
                console.log("[WA-Exporter Page Script] Intercepted Audio Blob URL:", this.href);
                window.__waExpLastInterceptedBlob = this.href;
                return; // Cancel the actual download
            }
            return window.__waExpOriginalClick.apply(this, arguments);
        };
    }

    function releaseInterceptor() {
        interceptorUsers = Math.max(0, interceptorUsers - 1);
        if (interceptorUsers > 0) return;
        clearTimeout(restoreTimer);
        restoreTimer = setTimeout(() => {
            if (interceptorUsers > 0 || !window.__waExpOriginalClick) return;
            HTMLAnchorElement.prototype.click = window.__waExpOriginalClick;
            window.__waExpOriginalClick = null;
        }, INTERCEPTOR_GRACE_MS);
    }

    window.addEventListener('message', async (event) => {
        if (event.source !== window || !event.data || !event.data.__waExpReq) return;
        
        const { callbackId, action, params } = event.data;
        if (typeof callbackId !== 'string' || typeof action !== 'string') return;
        
        // DOM-engine helpers only. The direct IndexedDB read ('extract'/'count') was retired in v3.0.
        const allowedActions = ['capture_thumbnail', 'extract_audio_blob'];
        if (!allowedActions.includes(action)) {
            window.postMessage({ __waExp: callbackId, error: 'Invalid action' }, '*');
            return;
        }
        
        // Strict parameter validation
        if (action === 'capture_thumbnail' && typeof params?.blobUrl !== 'string') {
            return window.postMessage({ __waExp: callbackId, error: 'Invalid blobUrl' }, '*');
        }
        // 1. Thumbnail operations
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
            installInterceptor();
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
            } finally {
                releaseInterceptor();
            }
            return;
        }

        window.postMessage({ __waExp: callbackId, error: `Unknown action: ${action}` }, '*');
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
