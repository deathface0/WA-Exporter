(function () {
    'use strict';

    window.WAExporter = window.WAExporter || {};

    const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
    let discoveredModel = null;
    let availableModelsList = [];

    let minRequestIntervalMs = 4100;
    let lastRequestTime = 0;

    const MODEL_CANDIDATES = [
        'gemini-3.5-flash-lite',
        'gemini-3.1-flash-lite',
        'gemini-3.7-flash',
        'gemini-3.6-flash',
        'gemini-3.5-flash',
        'gemini-2.5-flash-lite',
        'gemini-2.5-flash',
        'gemini-3-flash-preview'
    ];

    function getRateLimitForModel(modelName) {
        const name = (modelName || '').replace(/^models\//, '');
        if (name.includes('3.5-flash-lite') || name.includes('3.1-flash-lite')) {
            return 4100;
        }
        if (name.includes('2.5-flash-lite')) {
            return 6100;
        }
        return 12500;
    }

    /**
     * Finds next fallback model on 429 or 404.
     */
    function getNextModel(current) {
        const cleanCurr = (current || '').replace(/^models\//, '');
        const currentIdx = MODEL_CANDIDATES.indexOf(cleanCurr);

        for (let i = currentIdx + 1; i < MODEL_CANDIDATES.length; i++) {
            const next = MODEL_CANDIDATES[i];
            if (availableModelsList.length === 0 || availableModelsList.includes(next)) {
                return next;
            }
        }

        const other = availableModelsList.find(m =>
            m !== cleanCurr &&
            !m.includes('2.0-flash') &&
            !m.includes('tts') &&
            !m.includes('image') &&
            !m.includes('pro') &&
            !m.includes('embedding') &&
            !m.includes('gemma')
        );
        return other || null;
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Gets a localized prompt for image captioning based on browser locale.
     */
    function getLocalizedPrompt() {
        const lang = (navigator.language || 'en').toLowerCase();
        if (lang.startsWith('es')) {
            return 'Describe esta imagen de chat de WhatsApp en una sola frase breve y concisa (máximo 15 palabras). Enfócate en personas, acciones, texto o documentos visibles.';
        } else if (lang.startsWith('fr')) {
            return 'Décrivez cette image de chat WhatsApp en une seule phrase concise (max 15 mots). Concentrez-vous sur les personnes, les actions, le texte ou les documents visibles.';
        } else if (lang.startsWith('de')) {
            return 'Beschreiben Sie dieses WhatsApp-Chatbild in einem kurzen, prägnanten Satz (max. 15 Wörter). Konzentrieren Sie sich auf Personen, Aktionen, Text oder Dokumente.';
        } else if (lang.startsWith('pt')) {
            return 'Descreva esta imagem do WhatsApp em uma única frase concisa (máximo 20 palavras). Foque em pessoas, ações, texto ou documentos visíveis.';
        } else if (lang.startsWith('it')) {
            return 'Descrivi questa immagine della chat in una sola frase concisa (massimo 20 parole). Concentrati su persone, azioni, testo o documentos visibili.';
        }
        return 'Describe this WhatsApp chat image in one concise sentence (max 20 words). Focus on key people, actions, text, or visible context.';
    }

    /**
     * Enforces rate limiting interval before executing request.
     */
    async function enforceRateLimit() {
        const now = Date.now();
        const elapsed = now - lastRequestTime;
        if (elapsed < minRequestIntervalMs) {
            const waitTime = minRequestIntervalMs - elapsed;
            await sleep(waitTime);
        }
        lastRequestTime = Date.now();
    }

    /**
     * Executes fetch requests through the background script to bypass page CSP restrictions.
     */
    async function safeGeminiFetch(endpoint, method = 'GET', body = null) {
        try {
            if (typeof browser !== 'undefined' && browser.runtime && browser.runtime.sendMessage) {
                const response = await browser.runtime.sendMessage({
                    type: 'gemini_api_call',
                    endpoint: endpoint,
                    method: method,
                    body: body
                });
                if (response) {
                    return response;
                }
            }
        } catch (e) {
            console.warn('[WA-Exporter Gemini] Background proxy error, trying direct fetch:', e.message);
        }

        // Direct fetch fallback
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 14000);

            const res = await fetch(endpoint, {
                method: method,
                headers: { 'Content-Type': 'application/json' },
                body: body ? JSON.stringify(body) : undefined,
                signal: controller.signal
            });
            clearTimeout(timeoutId);

            const text = await res.text();
            let data = null;
            try {
                data = JSON.parse(text);
            } catch {
                data = text;
            }
            return { status: res.status, ok: res.ok, data: data };
        } catch (err) {
            return { status: 0, ok: false, error: err.message };
        }
    }

    /**
     * Discovers the best active Flash model from Google AI Studio.
     */
    async function getOrDiscoverModel(apiKey) {
        if (discoveredModel) {
            return discoveredModel;
        }

        try {
            const endpoint = `${GEMINI_API_BASE}/models?key=${encodeURIComponent(apiKey.trim())}`;
            const res = await safeGeminiFetch(endpoint, 'GET');
            if (res.status === 200 && res.data && res.data.models) {
                availableModelsList = res.data.models
                    .filter(m => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
                    .map(m => m.name.replace(/^models\//, ''));

                console.log('[WA-Exporter Gemini] 📋 Available models for key:', availableModelsList);

                for (const cand of MODEL_CANDIDATES) {
                    if (availableModelsList.includes(cand)) {
                        discoveredModel = cand;
                        return discoveredModel;
                    }
                }

                const anyFlash = availableModelsList.find(n => n.includes('flash') && !n.includes('2.0-flash'));
                if (anyFlash) {
                    discoveredModel = anyFlash;
                    return discoveredModel;
                }

                if (availableModelsList.length > 0) {
                    discoveredModel = availableModelsList[0];
                    return discoveredModel;
                }
            }
        } catch (e) {
            console.warn('[WA-Exporter Gemini] Error discovering models:', e);
        }

        discoveredModel = 'gemini-3.5-flash-lite';
        return discoveredModel;
    }

    /**
     * Validates API Key and checks available models & quotas.
     */
    async function validateApiKey(apiKey) {
        if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length < 15) {
            return { valid: false, message: 'API Key is too short or empty.' };
        }

        discoveredModel = null;
        const cleanKey = apiKey.trim();
        const endpoint = `${GEMINI_API_BASE}/models?key=${encodeURIComponent(cleanKey)}`;

        try {
            const res = await safeGeminiFetch(endpoint, 'GET');

            if (res.status === 200 && res.data) {
                const data = res.data;
                const models = (data && data.models) ? data.models.map(m => m.name.replace('models/', '')) : [];
                const bestModel = await getOrDiscoverModel(cleanKey);
                return {
                    valid: true,
                    modelsCount: models.length,
                    preferredModel: bestModel,
                    message: `Valid! Connected using model: ${bestModel}`
                };
            } else if (res.status === 400 || res.status === 403 || res.status === 401) {
                return { valid: false, status: res.status, message: 'Invalid API Key or unauthorized access.' };
            } else if (res.status === 429) {
                return { valid: false, status: 429, message: 'API Key valid, but current rate limit exceeded. Try again shortly.' };
            } else {
                return { valid: false, status: res.status, message: res.error || `Google API returned status ${res.status}.` };
            }
        } catch (e) {
            return { valid: false, message: `Network error: ${e.message}` };
        }
    }

    const BATCH_SIZE = 4;

    /**
     * Gets an improved, localized prompt for batch image captioning based on browser locale.
     */
    function getLocalizedBatchPrompt(count = 1) {
        const lang = (navigator.language || 'en').toLowerCase();
        if (lang.startsWith('es')) {
            if (count === 1) {
                return 'Eres un asistente experto para exportación de chats de WhatsApp. Describe la siguiente imagen en una sola frase concisa, natural e informativa (máximo 20 palabras). Enfócate en personas, acciones, texto/documentos legibles, lugar o contexto clave. Responde únicamente con la frase descriptiva sin introducciones ni comillas.';
            }
            return `Eres un asistente experto para exportación de chats de WhatsApp. Analiza las ${count} imágenes adjuntas. Para cada una, escribe una sola frase concisa, natural e informativa (máximo 20 palabras) destacando personas, acciones, texto/documentos legibles, lugar o contexto clave.\n\nResponde ESTRICTAMENTE con este formato numerado (una línea por imagen, sin texto extra):\n1: [descripción imagen 1]\n2: [descripción imagen 2]`;
        } else if (lang.startsWith('fr')) {
            if (count === 1) {
                return 'Vous êtes un assistant pour l\'exportation de discussions WhatsApp. Décrivez l\'image suivante en une seule phrase concise et informative (max 20 mots). Concentrez-vous sur les personnes, les actions, le texte ou les documents visibles. Répondez uniquement avec la description.';
            }
            return `Vous êtes un assistant pour l'exportation de discussions WhatsApp. Analysez les ${count} images jointes. Pour chacune, écrivez une seule phrase concise (max 20 mots) soulignant les personnes, les actions, le texte ou le contexte.\n\nRépondez STRICTEMENT dans ce format numéroté :\n1: [description image 1]\n2: [description image 2]`;
        } else if (lang.startsWith('de')) {
            if (count === 1) {
                return 'Sie sind ein Assistent für den WhatsApp-Chat-Export. Beschreiben Sie das folgende Bild in einem prägnanten, informativen Satz (max. 20 Wörter). Konzentrieren Sie sich auf Personen, Handlungen, Text oder Dokumente. Antworten Sie nur mit der Beschreibung.';
            }
            return `Sie sind ein Assistent für den WhatsApp-Chat-Export. Analysieren Sie die ${count} beigefügten Bilder. Verfassen Sie für jedes Bild einen prägnanten Satz (max. 20 Wörter).\n\nAntworten Sie STRIKT im folgenden nummerierten Format:\n1: [Beschreibung Bild 1]\n2: [Beschreibung Bild 2]`;
        } else if (lang.startsWith('pt')) {
            if (count === 1) {
                return 'Você é um assistente para exportação de conversas do WhatsApp. Descreva a imagem a seguir em uma única frase concisa e informativa (máximo 20 palavras). Foque em pessoas, ações, texto/documentos visíveis ou contexto. Responda apenas com a descrição.';
            }
            return `Você é um assistente para exportação de conversas do WhatsApp. Analise as ${count} imagens anexadas. Para cada uma, escreva uma única frase concisa (máximo 20 palavras).\n\nResponda ESTRITAMENTE neste formato numerado:\n1: [descrição imagem 1]\n2: [descrição imagem 2]`;
        } else if (lang.startsWith('it')) {
            if (count === 1) {
                return 'Sei un assistente per l\'esportazione delle chat di WhatsApp. Descrivi la seguente immagine in una sola frase concisa e informativa (massimo 20 parole). Concentrati su persone, azioni, testo visibile o contesto.';
            }
            return `Sei un assistente per l'esportazione delle chat di WhatsApp. Analizza le ${count} immagini allegate. Per ciascuna, scrivi una sola frase concisa (massimo 20 parole).\n\nRispondi STRETTAMENTE in questo formato numerato:\n1: [descrizione immagine 1]\n2: [descrizione immagine 2]`;
        }

        if (count === 1) {
            return 'You are an assistant for a WhatsApp chat export. Describe the following image in one concise, natural, and informative sentence (max 20 words). Focus on visible people, key actions, legible text/documents, setting, or important context. Respond only with the description.';
        }
        return `You are an assistant for a WhatsApp chat export. Analyze the ${count} attached images below. For each image, write one concise, natural, and informative sentence (max 20 words) capturing key people, actions, legible text/documents, setting, or important context.\n\nRespond STRICTLY in the following numbered format (one line per image, no preamble):\n1: [description for image 1]\n2: [description for image 2]`;
    }

    /**
     * Backward-compatible helper for single image prompts.
     */
    function getLocalizedPrompt() {
        return getLocalizedBatchPrompt(1);
    }

    /**
     * Generates captions for a batch of images (up to 4) in a single API call.
     * Returns an object mapping 1-based batch index -> caption string.
     */
    async function generateBatchCaptions(apiKey, batchItems, promptText = null, modelName = null, retries = 3) {
        if (!apiKey || !Array.isArray(batchItems) || batchItems.length === 0) return {};

        const count = batchItems.length;
        const prompt = promptText || getLocalizedBatchPrompt(count);
        let activeModel = modelName || await getOrDiscoverModel(apiKey) || 'gemini-3.5-flash-lite';

        const parts = [{ text: prompt }];

        batchItems.forEach((item, idx) => {
            const match = item.thumbnail.match(/^data:([^;]+);base64,(.+)$/);
            if (match) {
                if (count > 1) {
                    parts.push({ text: `Image ${idx + 1}:` });
                }
                parts.push({
                    inlineData: {
                        mimeType: match[1],
                        data: match[2]
                    }
                });
            }
        });

        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                minRequestIntervalMs = getRateLimitForModel(activeModel);
                await enforceRateLimit();

                const generationConfig = {
                    maxOutputTokens: Math.max(300, count * 120),
                    temperature: 0.2
                };

                // Only add thinkingConfig to models that support reasoning budgets (e.g. Gemini 3.7)
                if (activeModel && (activeModel.includes('3.7') || activeModel.includes('thinking'))) {
                    generationConfig.thinkingConfig = {
                        thinkingBudget: 0
                    };
                }

                const payload = {
                    contents: [{ parts: parts }],
                    generationConfig: generationConfig
                };

                const cleanModel = activeModel.startsWith('models/') ? activeModel : `models/${activeModel}`;
                const endpoint = `${GEMINI_API_BASE}/${cleanModel}:generateContent?key=${encodeURIComponent(apiKey.trim())}`;
                const res = await safeGeminiFetch(endpoint, 'POST', payload);

                if (res.status === 200 && res.data) {
                    const candidate = res.data?.candidates?.[0];
                    const rawParts = candidate?.content?.parts || [];
                    const visibleText = rawParts.filter(p => !p.thought && p.text).map(p => p.text).join('\n');
                    const rawText = (visibleText || rawParts.map(p => p.text).filter(Boolean).join('\n') || candidate?.text || '').trim();

                    if (!rawText) {
                        console.warn('[WA-Exporter Gemini] 200 OK but candidate has no text:', candidate);
                        return {};
                    }

                    const results = {};
                    if (count === 1) {
                        const singleText = rawText
                            .replace(/^(?:Image\s*1\s*[:.\-]|1\s*[:.\-])\s*/i, '')
                            .trim()
                            .replace(/^["'«“]|["'»”]$/g, '')
                            .replace(/\n+/g, ' ');
                        if (singleText) results[1] = singleText;
                    } else {
                        const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean);
                        lines.forEach(line => {
                            const m = line.match(/^(?:(?:Image|Imagen|Bild|Imagem)?\s*(\d+)[\s.:\-\)]+)\s*(.+)$/i);
                            if (m) {
                                const num = parseInt(m[1], 10);
                                const desc = m[2].trim().replace(/^["'«“]|["'»”]$/g, '').replace(/\n+/g, ' ');
                                if (desc) results[num] = desc;
                            }
                        });

                        // Fallback: if numbered parsing didn't match all lines, match sequentially
                        if (Object.keys(results).length < count && lines.length === count) {
                            lines.forEach((l, idx) => {
                                const cleanedLine = l.replace(/^(?:(?:Image|Imagen|Bild|Imagem)?\s*\d+[\s.:\-\)]+)/i, '');
                                results[idx + 1] = cleanedLine.replace(/^["'«“]|["'»”]$/g, '').replace(/\n+/g, ' ').trim();
                            });
                        }
                    }

                    return results;
                }

                if (res.status === 404) {
                    console.warn(`[WA-Exporter Gemini] Model '${activeModel}' not found (404).`);
                    const nextModel = getNextModel(activeModel);
                    if (nextModel) {
                        console.log(`[WA-Exporter Gemini] 🔄 Trying next model: '${nextModel}'`);
                        activeModel = nextModel;
                        discoveredModel = nextModel;
                        minRequestIntervalMs = getRateLimitForModel(nextModel);
                        continue;
                    }
                }

                if (res.status === 429) {
                    const nextModel = getNextModel(activeModel);
                    if (nextModel) {
                        console.warn(`[WA-Exporter Gemini] ⚠️ 429 Rate/Quota limit hit for '${activeModel}'. Switching to next model: '${nextModel}'...`);
                        activeModel = nextModel;
                        discoveredModel = nextModel;
                        minRequestIntervalMs = getRateLimitForModel(nextModel);
                        await sleep(1000);
                        continue;
                    } else {
                        console.warn(`[WA-Exporter Gemini] 429 Rate limited and no fallback model available. Waiting 15s (attempt ${attempt + 1}/${retries + 1})...`);
                        await sleep(15000);
                        continue;
                    }
                }

                if (res.status >= 500) {
                    console.warn(`[WA-Exporter Gemini] Server error ${res.status}. Retrying in 4s (attempt ${attempt + 1}/${retries + 1})...`);
                    await sleep(4000);
                    continue;
                }

                console.warn(`[WA-Exporter Gemini] Request failed with status ${res.status}:`, res.error || res.data);
                return {};
            } catch (e) {
                if (attempt === retries) {
                    console.warn('[WA-Exporter Gemini] Error generating batch captions:', e.message);
                    return {};
                }
                await sleep(2000);
            }
        }

        return {};
    }

    /**
     * Generates a caption for a single image (wrapper around generateBatchCaptions).
     */
    async function generateImageCaption(apiKey, base64DataUri, promptText = null, modelName = null) {
        if (!apiKey || !base64DataUri) return null;
        const res = await generateBatchCaptions(apiKey, [{ thumbnail: base64DataUri }], promptText, modelName);
        return res[1] || null;
    }

    /**
     * Batch processes messages to generate AI captions for media thumbnails using multi-image batches.
     * Respects user max quota limit and handles progress.
     */
    async function processMessageCaptions(messages, config = {}, onProgress = null) {
        const apiKey = config.apiKey;
        if (!apiKey) return messages;

        const maxRequests = parseInt(config.maxRequests, 10) || 50;
        const customPrompt = config.customPrompt || null;
        let model = config.model || await getOrDiscoverModel(apiKey);

        const eligible = (messages || []).filter(m =>
            m && m.thumbnail &&
            ['image', 'video', 'gif', 'sticker'].includes(m.type) &&
            !m.aiCaption
        );

        if (eligible.length === 0) return messages;

        const toProcess = eligible.slice(0, maxRequests);
        const total = toProcess.length;

        console.log(`[WA-Exporter Gemini] 🚀 Starting batched AI captioning for ${total} items (${BATCH_SIZE} imgs/call) using '${model}'...`);

        let processedTotal = 0;

        for (let i = 0; i < total; i += BATCH_SIZE) {
            const chunkMessages = toProcess.slice(i, i + BATCH_SIZE);
            const batchItems = chunkMessages.map((m, idx) => ({
                idx: idx + 1,
                thumbnail: m.thumbnail,
                message: m
            }));

            if (onProgress) {
                const currentBatchProgress = Math.min(i + batchItems.length, total);
                onProgress(currentBatchProgress, total, `AI Captioning (${currentBatchProgress}/${total})`, discoveredModel || model);
            }

            const captionsMap = await generateBatchCaptions(apiKey, batchItems, customPrompt, model);
            
            if (discoveredModel && discoveredModel !== model) {
                model = discoveredModel;
            }

            for (let b = 0; b < batchItems.length; b++) {
                const item = batchItems[b];
                let caption = captionsMap[item.idx];

                if (!caption) {
                    console.log(`[WA-Exporter Gemini] 🔄 Fallback single caption for item ${i + b + 1}...`);
                    caption = await generateImageCaption(apiKey, item.thumbnail, customPrompt, model);
                }

                if (caption) {
                    item.message.aiCaption = caption;
                    processedTotal++;
                    console.log(`[WA-Exporter Gemini] 📸 [${processedTotal}/${total}] ${item.message.type.toUpperCase()}: "${caption}"`);
                }
            }
        }

        console.log(`[WA-Exporter Gemini] ✅ Finished AI captioning (${processedTotal}/${total} processed).`);
        return messages;
    }

    window.WAExporter.Gemini = {
        validateApiKey,
        generateImageCaption,
        generateBatchCaptions,
        processMessageCaptions,
        getLocalizedPrompt,
        getLocalizedBatchPrompt,
        getOrDiscoverModel
    };
})();
