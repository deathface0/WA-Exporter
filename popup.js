/* ── Helpers ── */

const $ = (id) => document.getElementById(id);
const pad = (n) => n.toString().padStart(2, '0');

function formatLocalDatetime(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/* ── Default Date Range (now − 24h → now) ── */

document.addEventListener('DOMContentLoaded', () => {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 86_400_000);

    $('startTime').value = formatLocalDatetime(yesterday);
    $('endTime').value   = formatLocalDatetime(now);

    const modeRadios = document.querySelectorAll('input[name="extractMode"]');
    modeRadios.forEach(r => {
        r.addEventListener('change', (e) => {
            if (e.target.value === 'date') {
                $('dateInputs').style.display = 'block';
                $('countInput').style.display = 'none';
            } else {
                $('dateInputs').style.display = 'none';
                $('countInput').style.display = 'block';
            }
        });
    });
});

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

function setStatus(msg) {
    const el = $('statusMsg');
    if (el) el.textContent = msg;
}

async function handleAction(action, btn) {
    const original = btn.textContent;
    btn.textContent = 'Extracting...';
    btn.disabled = true;
    setStatus('Fetching messages... Please wait.');

    try {
        const data = await executeExtraction();

        if (!data?.length) {
            btn.textContent = 'No data found';
            setStatus('No messages found within this range.');
            setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 3000);
            return;
        }

        const text = formatData(data);

        if (action === 'copy') {
            await copyToClipboard(text);
            btn.textContent = 'Copied to clipboard!';
        } else {
            downloadTxt(`WA_Chat_Export_${Date.now()}.txt`, text);
            btn.textContent = 'Downloaded!';
        }

        setStatus(`Successfully fetched ${data.length} message(s)!`);
    } catch (err) {
        console.error(err);
        btn.textContent = 'Error occurred';
        setStatus('An error occurred during extraction.');
    }

    setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 3000);
}

/* ── Event Bindings ── */

$('copyBtn').addEventListener('click',    (e) => handleAction('copy', e.target));
$('downloadBtn').addEventListener('click', (e) => handleAction('download', e.target));