document.addEventListener('DOMContentLoaded', () => {
    const startInput = document.getElementById('startTime');
    const endInput = document.getElementById('endTime');
    
    if (startInput && endInput) {
        const now = new Date();
        const yesterday = new Date(now.getTime() - (24 * 60 * 60 * 1000));
        
        const formatLocal = (date) => {
            const pad = (n) => n.toString().padStart(2, '0');
            return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
        };

        startInput.value = formatLocal(yesterday);
        endInput.value = formatLocal(now);
    }
});

async function getActiveTab() {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    return tabs[0];
}

async function executeExtraction() {
    const startInput = document.getElementById('startTime').value;
    const endInput = document.getElementById('endTime').value;

    if (!startInput || !endInput) {
        alert("Missing timestamps.");
        return null;
    }

    const startTime = new Date(startInput).getTime();
    const endTime = new Date(endInput).getTime();

    if (startTime > endTime) {
        alert("Start timestamp must be before end timestamp.");
        return null;
    }

    const activeTab = await getActiveTab();

    if (!activeTab || !activeTab.url.includes("web.whatsapp.com")) {
        alert("Navigate to WhatsApp Web.");
        return null;
    }

    await browser.scripting.executeScript({
        target: { tabId: activeTab.id },
        files: ['content.js']
    });

    const response = await browser.tabs.sendMessage(activeTab.id, {
        action: "extract_chat",
        start: startTime,
        end: endTime
    });

    return response ? response.data : null;
}

function formatData(data) {
    return data.map(d => d.rawFormat).join('\n');
}

async function copyToClipboard(text) {
    try {
        await navigator.clipboard.writeText(text);
    } catch (err) {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
    }
}

document.getElementById('copyBtn').addEventListener('click', async (e) => {
    const btn = e.target;
    const originalText = btn.innerText;
    
    btn.innerText = "Extracting...";
    btn.disabled = true;

    try {
        const data = await executeExtraction();
        if (!data || data.length === 0) {
            btn.innerText = "No data found";
            setTimeout(() => {
                btn.innerText = originalText;
                btn.disabled = false;
            }, 3000);
            return;
        }

        const text = formatData(data);
        await copyToClipboard(text);
        
        btn.innerText = "Copied to clipboard!";
    } catch (err) {
        console.error(err);
        btn.innerText = "Error occurred";
    }

    setTimeout(() => {
        btn.innerText = originalText;
        btn.disabled = false;
    }, 3000);
});