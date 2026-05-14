/* ── Helpers ── */

const $ = (id) => document.getElementById(id);
const pad = (n) => n.toString().padStart(2, '0');

function formatLocalDatetime(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/* ── State & Storage ── */

let pollInterval = null;
let cachedResult = null;

document.addEventListener('DOMContentLoaded', async () => {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 86_400_000);

    let storage = {};
    try {
        storage = await browser.storage.local.get(['startTime', 'endTime', 'extractMode', 'messageCount']);
    } catch(e) {}

    $('startTime').value = storage.startTime || formatLocalDatetime(yesterday);
    $('endTime').value   = storage.endTime || formatLocalDatetime(now);
    if (storage.messageCount) $('messageCount').value = storage.messageCount;

    if (storage.extractMode) {
        const checkedRadio = document.querySelector(`input[name="extractMode"][value="${storage.extractMode}"]`);
        if (checkedRadio) checkedRadio.checked = true;
    }

    const toggleInputs = () => {
        const mode = document.querySelector('input[name="extractMode"]:checked').value;
        if (mode === 'date') {
            $('dateInputs').style.display = 'block';
            $('countInput').style.display = 'none';
        } else {
            $('dateInputs').style.display = 'none';
            $('countInput').style.display = 'block';
        }
    };
    toggleInputs();

    const modeRadios = document.querySelectorAll('input[name="extractMode"]');
    modeRadios.forEach(r => {
        r.addEventListener('change', (e) => {
            toggleInputs();
            browser.storage.local.set({ extractMode: e.target.value });
            clearCache();
        });
    });

    $('startTime').addEventListener('change', (e) => { browser.storage.local.set({ startTime: e.target.value }); clearCache(); });
    $('endTime').addEventListener('change', (e) => { browser.storage.local.set({ endTime: e.target.value }); clearCache(); });
    $('messageCount').addEventListener('change', (e) => { browser.storage.local.set({ messageCount: e.target.value }); clearCache(); });

    checkStatus();
});

function clearCache() {
    cachedResult = null;
    setStatus('', false);
    resetButtons();
    getActiveTab().then(tab => {
        if (tab?.url?.includes('web.whatsapp.com')) {
            browser.tabs.sendMessage(tab.id, { action: 'clear_result' }).catch(()=>{});
        }
    });
}

async function checkStatus() {
    try {
        const tab = await getActiveTab();
        if (!tab?.url?.includes('web.whatsapp.com')) return;
        
        const status = await browser.tabs.sendMessage(tab.id, { action: 'get_status' }).catch(() => null);
        if (status) {
            updateUIFromStatus(status);
            if (status.isRunning) {
                if (!pollInterval) pollInterval = setInterval(checkStatus, 1000);
            } else {
                if (pollInterval) {
                    clearInterval(pollInterval);
                    pollInterval = null;
                }
            }
        }
    } catch(e) {}
}

function updateUIFromStatus(status) {
    if (status.isRunning) {
        $('copyBtn').disabled = true;
        $('downloadBtn').disabled = true;
        $('copyBtn').textContent = 'Extracting...';
        
        let msg = 'Fetcheando mensajes...';
        if (status.mode === 'count') {
            let remaining = Math.max(0, status.targetCount - status.fetchedCount);
            msg = `Fetcheando: faltan ${remaining} mensajes...`;
        } else if (status.mode === 'date') {
            if (status.oldestTime) {
                let d = new Date(status.oldestTime);
                msg = `Fetcheando por fecha: vamos por ${pad(d.getDate())}/${pad(d.getMonth()+1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
            }
        }
        setStatus(msg, true);
    } else if (status.result) {
        cachedResult = status.result;
        resetButtons();
        setStatus(`¡Extracción completada! ${status.result.length} mensajes.`, false);
    } else {
        resetButtons();
    }
}

function resetButtons() {
    $('copyBtn').textContent = 'Copy Text';
    $('downloadBtn').textContent = 'Download TXT';
    $('copyBtn').disabled = false;
    $('downloadBtn').disabled = false;
}

/* ── Tab & Extraction ── */

async function getActiveTab() {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    return tab;
}

async function executeExtraction() {
    const mode = document.querySelector('input[name="extractMode"]:checked').value;
    let messagePayload = { action: 'extract_chat', mode: mode };

    if (mode === 'date') {
        const startVal = $('startTime').value;
        const endVal   = $('endTime').value;

        if (!startVal || !endVal) { alert('Missing timestamps.'); return null; }

        const startTime = new Date(startVal).getTime();
        const endTime   = new Date(endVal).getTime();

        if (startTime > endTime) { alert('Start must be before end.'); return null; }
        
        messagePayload.start = startTime;
        messagePayload.end = endTime;
    } else {
        const count = parseInt($('messageCount').value, 10);
        if (!count || count <= 0) { alert('Invalid message count.'); return null; }
        messagePayload.count = count;
    }

    const tab = await getActiveTab();
    if (!tab?.url?.includes('web.whatsapp.com')) { alert('Navigate to WhatsApp Web.'); return null; }

    await browser.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });

    const response = await browser.tabs.sendMessage(tab.id, messagePayload);

    if (response?.error) {
        console.warn(response.error);
        return null;
    }

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
    const a = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

/* ── Action Handler ── */

function setStatus(msg, showSpinner = false) {
    const container = $('statusContainer');
    const msgEl = $('statusMsg');
    const spinner = $('spinner');

    if (!container) return;

    if (msg) {
        msgEl.textContent = msg;
        container.classList.add('visible');
    } else {
        container.classList.remove('visible');
    }

    if (showSpinner) {
        spinner.classList.add('active');
    } else {
        spinner.classList.remove('active');
    }
}

function getFilename() {
    const mode = document.querySelector('input[name="extractMode"]:checked').value;
    const ts = Date.now();
    if (mode === 'date') {
        const start = $('startTime').value.split('T')[0];
        const end = $('endTime').value.split('T')[0];
        return `WA_Chat_${start}_to_${end}_${ts}.txt`;
    } else {
        const count = $('messageCount').value;
        return `WA_Chat_${count}_msgs_${ts}.txt`;
    }
}

async function handleAction(action, btn) {
    if (cachedResult) {
        const text = formatData(cachedResult);
        if (action === 'copy') {
            await copyToClipboard(text);
            btn.textContent = 'Copied!';
        } else {
            downloadTxt(getFilename(), text);
            btn.textContent = 'Downloaded!';
        }
        setTimeout(() => resetButtons(), 3000);
        return;
    }

    btn.textContent = 'Extracting...';
    $('copyBtn').disabled = true;
    $('downloadBtn').disabled = true;
    setStatus('Fetching messages...', true);

    if (!pollInterval) pollInterval = setInterval(checkStatus, 1000);

    try {
        const data = await executeExtraction();

        if (pollInterval) {
            clearInterval(pollInterval);
            pollInterval = null;
        }

        if (data === null) {
            resetButtons();
            return; // Error handled by executeExtraction
        }

        if (!data?.length) {
            btn.textContent = 'No data';
            setStatus('No messages found within this range.', false);
            setTimeout(() => resetButtons(), 3000);
            return;
        }

        cachedResult = data;
        const text = formatData(data);

        if (action === 'copy') {
            await copyToClipboard(text);
            btn.textContent = 'Copied!';
        } else {
            downloadTxt(getFilename(), text);
            btn.textContent = 'Downloaded!';
        }

        setStatus(`Successfully fetched ${data.length} message(s)!`, false);
    } catch (err) {
        console.error(err);
        btn.textContent = 'Error';
        setStatus('An error occurred during extraction.', false);
    }

    setTimeout(() => resetButtons(), 3000);
}

/* ── Event Bindings ── */

$('copyBtn').addEventListener('click',    (e) => handleAction('copy', e.target));
$('downloadBtn').addEventListener('click', (e) => handleAction('download', e.target));