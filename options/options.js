(function () {
    'use strict';

    // Options page: settings that are set once. Every change is saved right away.

    if (typeof browser === 'undefined') {
        window.browser = chrome;
    }

    const { Settings, I18n } = window.WAExporter;
    const { t } = I18n;
    const $ = (id) => document.getElementById(id);

    let settings = null;
    let savedTimer = null;

    function showSaved() {
        $('savedNote').textContent = t('optSaved');
        clearTimeout(savedTimer);
        savedTimer = setTimeout(() => { $('savedNote').textContent = ''; }, 1800);
    }

    function save(patch) {
        Object.assign(settings, patch);
        Settings.save(patch).then(showSaved);
        renderBudget();
    }

    function renderBudget() {
        $('budgetHint').textContent = t('optBudgetHint', I18n.num(settings.maxAiRequests * 4));
    }

    function render() {
        document.querySelectorAll('input[name="extractEngine"]').forEach(r => { r.checked = r.value === settings.extractEngine; });
        $('thumbnailResolution').value = settings.thumbnailResolution;
        $('mediaMaxAgeDays').value = settings.mediaMaxAgeDays;
        $('maxMediaDownloads').value = settings.maxMediaDownloads;
        $('geminiApiKey').value = settings.geminiApiKey;
        $('aiModelPreference').value = settings.aiModelPreference;
        $('maxAiRequests').value = settings.maxAiRequests;
        $('aiDescribeImages').checked = settings.aiDescribeImages;
        $('enableAiTranscription').checked = settings.enableAiTranscription;
        $('customAiPrompt').value = settings.customAiPrompt;
        renderBudget();
    }

    // Numbers are clamped to their allowed range before saving.
    function bindNumber(id, key) {
        $(id).addEventListener('change', (e) => {
            const value = Settings.normalize(Object.assign({}, settings, { [key]: e.target.value }))[key];
            e.target.value = value;
            save({ [key]: value });
        });
    }

    async function checkKey() {
        const key = $('geminiApiKey').value.trim();
        const status = $('keyStatus');
        status.className = 'key-status';
        if (!key) {
            status.classList.add('error');
            status.textContent = t('optKeyEmpty');
            return;
        }
        status.textContent = t('optKeyChecking');
        try {
            const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`);
            if (res.status === 200) {
                const data = await res.json();
                status.classList.add('ok');
                status.textContent = t('optKeyOk', I18n.num((data && data.models) ? data.models.length : 0));
            } else {
                status.classList.add('error');
                status.textContent = t('optKeyBad', String(res.status));
            }
        } catch (err) {
            status.classList.add('error');
            status.textContent = t('optKeyError', err.message);
        }
    }

    function bind() {
        document.querySelectorAll('input[name="extractEngine"]').forEach(r => r.addEventListener('change', () => save({ extractEngine: r.value })));
        $('thumbnailResolution').addEventListener('change', (e) => save({ thumbnailResolution: e.target.value }));
        bindNumber('mediaMaxAgeDays', 'mediaMaxAgeDays');
        bindNumber('maxMediaDownloads', 'maxMediaDownloads');
        bindNumber('maxAiRequests', 'maxAiRequests');
        $('maxAiRequests').addEventListener('input', (e) => {
            const preview = parseInt(e.target.value, 10);
            if (preview > 0) $('budgetHint').textContent = t('optBudgetHint', I18n.num(preview * 4));
        });
        $('geminiApiKey').addEventListener('change', (e) => {
            $('keyStatus').textContent = '';
            save({ geminiApiKey: e.target.value.trim() });
        });
        $('checkKey').addEventListener('click', checkKey);
        $('aiModelPreference').addEventListener('change', (e) => save({ aiModelPreference: e.target.value }));
        $('aiDescribeImages').addEventListener('change', (e) => save({ aiDescribeImages: e.target.checked }));
        $('enableAiTranscription').addEventListener('change', (e) => save({ enableAiTranscription: e.target.checked }));
        $('customAiPrompt').addEventListener('change', (e) => save({ customAiPrompt: e.target.value }));
        $('resetPrompt').addEventListener('click', () => {
            $('customAiPrompt').value = '';
            save({ customAiPrompt: '' });
        });
    }

    document.addEventListener('DOMContentLoaded', async () => {
        I18n.apply();
        document.title = `${t('optTitle')} – ${t('extName')}`;
        $('version').textContent = t('optVersion', browser.runtime.getManifest().version);
        settings = await Settings.load();
        render();
        bind();
    });
})();
