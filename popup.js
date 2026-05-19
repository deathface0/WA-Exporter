/* ── Helpers ── */

const $ = (id) => document.getElementById(id);
const pad = (n) => n.toString().padStart(2, '0');

function formatLocalDatetime(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/* ── Init ── */

document.addEventListener('DOMContentLoaded', async () => {
    const now       = new Date();
    const yesterday = new Date(now.getTime() - 86_400_000);

    // Restore persisted inputs
    let storage = {};
    try { storage = await browser.storage.local.get(['startTime', 'endTime', 'extractMode', 'messageCount']); } catch {}

    $('startTime').value    = storage.startTime || formatLocalDatetime(yesterday);
    $('endTime').value      = storage.endTime   || formatLocalDatetime(now);
    if (storage.messageCount) $('messageCount').value = storage.messageCount;

    if (storage.extractMode) {
        const r = document.querySelector(`input[name="extractMode"][value="${storage.extractMode}"]`);
        if (r) r.checked = true;
    }

    toggleInputs();

    // Persist on change
    document.querySelectorAll('input[name="extractMode"]').forEach(r => {
        r.addEventListener('change', (e) => {
            browser.storage.local.set({ extractMode: e.target.value });
            toggleInputs();
        });
    });
    $('startTime').addEventListener('change',    (e) => browser.storage.local.set({ startTime: e.target.value }));
    $('endTime').addEventListener('change',      (e) => browser.storage.local.set({ endTime: e.target.value }));
    $('messageCount').addEventListener('change', (e) => browser.storage.local.set({ messageCount: e.target.value }));

    // Probe the active chat
    await probeChatInfo();
});

function toggleInputs() {
    const mode = document.querySelector('input[name="extractMode"]:checked').value;
    $('dateInputs').style.display = mode === 'date'  ? 'block' : 'none';
    $('countInput').style.display = mode === 'count' ? 'block' : 'none';
}

/* ── Chat Insight ── */

async function probeChatInfo() {
    const insight     = $('chatInsight');
    const insightText = $('insightText');

    insight.className = 'loading';
    insightText.textContent = 'Detecting chat…';
    insight.querySelector('.insight-icon').textContent = '⏳';

    try {
        const tab = await getActiveTab();
        if (!tab?.url?.includes('web.whatsapp.com')) {
            showInsight('warning', '⚠️', 'Navigate to WhatsApp Web first.');
            return;
        }

        await browser.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
        const info = await browser.tabs.sendMessage(tab.id, { action: 'get_chat_info' });

        if (!info?.chatId) {
            showInsight('warning', '💬', 'Open a chat in WhatsApp Web.');
            return;
        }

        showInsight('ready', '✅', `Ready — ${info.totalMessages.toLocaleString()} messages cached`);
        $('copyBtn').disabled     = false;
        $('downloadBtn').disabled = false;
    } catch (err) {
        console.error(err);
        showInsight('warning', '❌', 'Could not connect to WhatsApp Web.');
    }
}

function showInsight(cls, icon, text) {
    const el = $('chatInsight');
    el.className = cls;
    el.querySelector('.insight-icon').textContent = icon;
    $('insightText').textContent = text;
}

/* ── Tab ── */

async function getActiveTab() {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    return tab;
}

/* ── Extraction ── */

async function executeExtraction() {
    const mode = document.querySelector('input[name="extractMode"]:checked').value;
    const payload = { action: 'extract_chat', mode };

    if (mode === 'date') {
        const startVal = $('startTime').value;
        const endVal   = $('endTime').value;
        if (!startVal || !endVal)                     { alert('Missing timestamps.');        return null; }
        const startTime = new Date(startVal).getTime();
        const endTime   = new Date(endVal).getTime();
        if (startTime > endTime)                      { alert('Start must be before end.');  return null; }
        payload.start = startTime;
        payload.end   = endTime;
    } else if (mode === 'count') {
        const count = parseInt($('messageCount').value, 10);
        if (!count || count <= 0)                     { alert('Invalid message count.');     return null; }
        payload.count = count;
    }

    const tab = await getActiveTab();
    if (!tab?.url?.includes('web.whatsapp.com'))      { alert('Navigate to WhatsApp Web.'); return null; }

    await browser.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    const response = await browser.tabs.sendMessage(tab.id, payload);

    if (response?.error) { console.warn(response.error); alert(response.error); return null; }
    return response?.data ?? null;
}

/* ── Output Helpers ── */

function formatData(data) {
    return data.map(d => d.rawFormat).join('\n');
}

async function copyToClipboard(text) {
    try {
        await navigator.clipboard.writeText(text);
    } catch {
        const ta = Object.assign(document.createElement('textarea'), { value: text });
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
    }
}

function downloadTxt(filename, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a   = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

function getFilename() {
    const mode = document.querySelector('input[name="extractMode"]:checked').value;
    const ts   = Date.now();
    if (mode === 'date') {
        const start = $('startTime').value.split('T')[0];
        const end   = $('endTime').value.split('T')[0];
        return `WA_Chat_${start}_to_${end}_${ts}.txt`;
    } else if (mode === 'count') {
        return `WA_Chat_${$('messageCount').value}_msgs_${ts}.txt`;
    }
    return `WA_Chat_all_${ts}.txt`;
}

/* ── Status ── */

function setStatus(msg, showSpinner = false) {
    const container = $('statusContainer');
    if (!container) return;

    if (msg) {
        $('statusMsg').textContent = msg;
        container.classList.add('visible');
    } else {
        container.classList.remove('visible');
    }

    $('spinner').classList.toggle('active', showSpinner);
}

/* ── Action Handler ── */

async function handleAction(action, btn) {
    const original = btn.textContent;
    btn.textContent       = 'Extracting…';
    $('copyBtn').disabled     = true;
    $('downloadBtn').disabled = true;
    setStatus('Querying local database…', true);

    try {
        const data = await executeExtraction();

        if (data === null) {
            btn.textContent = original;
            $('copyBtn').disabled     = false;
            $('downloadBtn').disabled = false;
            setStatus('');
            return;
        }

        if (!data.length) {
            btn.textContent = 'No data';
            setStatus('No messages found for the selected filter.', false);
            setTimeout(() => { btn.textContent = original; $('copyBtn').disabled = false; $('downloadBtn').disabled = false; }, 3000);
            return;
        }

        const text = formatData(data);

        if (action === 'copy') {
            await copyToClipboard(text);
            btn.textContent = 'Copied!';
        } else {
            downloadTxt(getFilename(), text);
            btn.textContent = 'Downloaded!';
        }

        setStatus(`Done — ${data.length.toLocaleString()} message(s) exported.`, false);
    } catch (err) {
        console.error(err);
        btn.textContent = 'Error';
        setStatus('An error occurred during extraction.', false);
    }

    setTimeout(() => {
        btn.textContent = original;
        $('copyBtn').disabled     = false;
        $('downloadBtn').disabled = false;
    }, 3000);
}

/* ── Event Bindings ── */

$('copyBtn').addEventListener('click',     (e) => handleAction('copy', e.target));
$('downloadBtn').addEventListener('click', (e) => handleAction('download', e.target));