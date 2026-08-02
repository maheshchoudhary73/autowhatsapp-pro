/**
 * AutoWhatsApp Pro - Official Mobile & Web Frontend Logic
 * Pure Instant QR Code Engine Version
 */

const RENDER_CLOUD_URL = 'http://16.16.160.123:3000';

let socketHost = RENDER_CLOUD_URL;
if (typeof window !== 'undefined' && window.location && window.location.hostname && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1' && !window.location.protocol.startsWith('file')) {
    socketHost = window.location.origin;
}

const socket = io(socketHost, {
    transports: ['websocket', 'polling']
});

// UI State
let accountsState = [];
let parsedContacts = [];
let campaignQueue = [];
let isCampaignRunning = false;
let currentMediaObj = null;

// DOM Elements
const totalContactsCount = document.getElementById('total-contacts-count');
const sentCountEl = document.getElementById('sent-count');
const pendingCountEl = document.getElementById('pending-count');
const failedCountEl = document.getElementById('failed-count');
const speedLockBadge = document.getElementById('speed-lock-badge');
const statSpeedCap = document.getElementById('stat-speed-cap');
const accountsGrid = document.getElementById('accounts-grid');
const btnAddAccount = document.getElementById('btn-add-account');
const btnLogoutAll = document.getElementById('btn-logout-all');

const excelFileInput = document.getElementById('excel-file-input');
const excelDropzone = document.getElementById('excel-dropzone');
const excelFileStatus = document.getElementById('excel-file-status');

const campaignMsgText = document.getElementById('campaign-msg-text');
const btnPickMedia = document.getElementById('btn-pick-media');
const mediaFileInput = document.getElementById('media-file-input');
const mediaNameTag = document.getElementById('media-name-tag');
const btnClearMedia = document.getElementById('btn-clear-media');

const selectRoutingMode = document.getElementById('select-routing-mode');
const specificAccContainer = document.getElementById('specific-acc-container');
const selectSpecificAcc = document.getElementById('select-specific-acc');
const customRatioContainer = document.getElementById('custom-ratio-container');
const ratioInputsGrid = document.getElementById('ratio-inputs-grid');

const btnStartCampaign = document.getElementById('btn-start-campaign');
const btnExportReport = document.getElementById('btn-export-report');
const terminalLogs = document.getElementById('terminal-logs');
const btnClearTerminal = document.getElementById('btn-clear-terminal');

const SPEED_CAPS = {
    1: 30,
    2: 60,
    3: 100,
    4: 150,
    5: 250,
    6: 350,
    7: 400,
    8: 450,
    9: 500,
    10: 600
};

// Masking Helper
function maskPhoneNumber(phone) {
    if (!phone) return 'Disconnected';
    const clean = String(phone).replace(/\D/g, '');
    if (clean.length < 10) return clean;
    const prefix = clean.slice(0, 4);
    const suffix = clean.slice(-2);
    return `${prefix}XXXX${suffix}`;
}

// Socket Listeners
socket.on('connect', () => {
    console.log('Connected to AutoWhatsApp Pure QR Cloud Engine:', socket.id);
    appendTerminalLog({
        type: 'success',
        timestamp: new Date().toLocaleTimeString(),
        text: '⚡ Connected to 24/7 AutoWhatsApp Pure QR Cloud Backend!'
    });
});

socket.on('accounts_update', (accounts) => {
    accountsState = accounts;
    renderAccounts(accounts);
});

socket.on('campaign_progress', (data) => {
    const { sent, pending, failed } = data;
    sentCountEl.textContent = sent;
    pendingCountEl.textContent = pending;
    failedCountEl.textContent = failed;
});

socket.on('campaign_log', (log) => {
    appendTerminalLog(log);
});

socket.on('auto_reply_log', (data) => {
    appendTerminalLog({
        type: 'info',
        timestamp: new Date().toLocaleTimeString(),
        text: `🤖 Auto-Reply sent from (${data.accId}) to +${maskPhoneNumber(data.from)} [Keyword: "${data.keyword}"]`
    });
});

// Render Accounts Multi-Slot Grid (Pure QR)
function renderAccounts(accounts) {
    if (!accountsGrid) return;
    let html = '';
    let connectedCount = 0;

    let specificOptionsHtml = '';
    let ratioInputsHtml = '';

    accounts.forEach((acc, index) => {
        const isConnected = acc.status === 'CONNECTED';
        const isQrReady = acc.status === 'QR_READY' && acc.qrCode;

        const slotTitle = `WhatsApp Account Slot ${index + 1}`;
        const rawWid = isConnected && acc.userInfo && acc.userInfo.wid ? acc.userInfo.wid : '';
        const phoneMasked = rawWid ? `+${maskPhoneNumber(rawWid)}` : 'Disconnected';
        const namePush = isConnected && acc.userInfo ? acc.userInfo.pushname : slotTitle;

        if (isConnected) {
            connectedCount++;
            specificOptionsHtml += `<option value="${acc.id}">📲 ${phoneMasked} (${namePush})</option>`;
            ratioInputsHtml += `
                <div class="form-group">
                    <label class="form-label">${phoneMasked} (${namePush})</label>
                    <input type="number" id="quota-${acc.id}" class="form-input custom-quota-input" data-accid="${acc.id}" placeholder="Max msgs e.g. 50" value="100">
                </div>
            `;
        }

        html += `
            <div class="account-card ${isConnected ? 'connected' : (isQrReady ? 'qr-ready' : '')}" id="acc-card-${acc.id}">
                <div class="acc-row-top">
                    <div class="acc-info-left">
                        <div class="acc-avatar"><i class="fa-brands fa-whatsapp"></i></div>
                        <div class="acc-details">
                            <div class="acc-name">${namePush}</div>
                            <div class="acc-phone">${phoneMasked}</div>
                            <div class="acc-status-tag ${acc.status.toLowerCase()}">
                                <i class="fa-solid fa-circle"></i> ${acc.status}
                            </div>
                        </div>
                    </div>

                    ${isConnected ? `
                        <button class="btn btn-danger-soft btn-sm" onclick="logoutAccount('${acc.id}')" title="Logout account">
                            <i class="fa-solid fa-trash-can"></i>
                        </button>
                    ` : ''}
                </div>

                ${!isConnected ? `
                    <!-- PURE INSTANT QR DISPLAY CONTAINER -->
                    <div class="qr-container-box" id="qr-container-${acc.id}" style="margin-top:10px;">
                        ${isQrReady ? `
                            <div class="qr-box-center">
                                <img src="${acc.qrCode}" alt="Scan QR Code">
                                <div class="qr-instruction">
                                    <i class="fa-solid fa-qrcode"></i> Open WhatsApp ➔ Linked Devices ➔ Scan this QR Code
                                </div>
                            </div>
                        ` : `
                            <div class="acc-loading-box" style="padding: 14px;">
                                <i class="fa-solid fa-spinner fa-spin"></i> Generating Official WhatsApp QR Code... Please wait 2 seconds.
                            </div>
                        `}
                    </div>
                ` : ''}
            </div>
        `;
    });

    accountsGrid.innerHTML = html;
    selectSpecificAcc.innerHTML = specificOptionsHtml || '<option value="">No Accounts Connected</option>';
    ratioInputsGrid.innerHTML = ratioInputsHtml || '<p style="font-size:11px; color:var(--text-muted);">Connect WhatsApp accounts to set custom quotas.</p>';

    const cap = SPEED_CAPS[connectedCount] || (connectedCount > 10 ? 600 : 30);
    speedLockBadge.textContent = `${connectedCount} Acc = ${cap} msgs/min`;
    statSpeedCap.textContent = `${cap} Msgs / Min`;

    document.querySelectorAll('.matrix-item').forEach(item => {
        const count = parseInt(item.getAttribute('data-acc'));
        if (count === connectedCount) item.classList.add('active');
        else item.classList.remove('active');
    });
}

window.logoutAccount = function(accId) {
    if (confirm(`Logout WhatsApp account slot (${accId})?`)) {
        socket.emit('logout_account', { accId });
    }
};

if (btnAddAccount) {
    btnAddAccount.addEventListener('click', () => {
        const hasUnconnected = accountsState.some(a => a.status !== 'CONNECTED');
        if (hasUnconnected) {
            alert('Please scan the current WhatsApp QR code before adding a new account!');
            return;
        }
        socket.emit('add_account');
    });
}

if (btnLogoutAll) {
    btnLogoutAll.addEventListener('click', () => {
        if (confirm('Are you sure you want to LOGOUT ALL connected WhatsApp accounts?')) {
            socket.emit('logout_all_accounts');
        }
    });
}

selectRoutingMode.addEventListener('change', (e) => {
    const mode = e.target.value;
    specificAccContainer.classList.add('hidden');
    customRatioContainer.classList.add('hidden');

    if (mode === 'SPECIFIC_ACCOUNT') specificAccContainer.classList.remove('hidden');
    else if (mode === 'CUSTOM_RATIO') customRatioContainer.classList.remove('hidden');
});

// MEDIA HANDLERS
btnPickMedia.addEventListener('click', () => mediaFileInput.click());

mediaFileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
        const file = e.target.files[0];
        const reader = new FileReader();
        reader.onload = function(evt) {
            currentMediaObj = {
                data: evt.target.result.split(',')[1],
                mimetype: file.type,
                filename: file.name
            };
            mediaNameTag.textContent = `📎 ${file.name} (${Math.round(file.size / 1024)} KB)`;
            mediaNameTag.style.color = 'var(--primary)';
            btnClearMedia.classList.remove('hidden');
        };
        reader.readAsDataURL(file);
    }
});

btnClearMedia.addEventListener('click', () => {
    currentMediaObj = null;
    mediaFileInput.value = '';
    mediaNameTag.textContent = 'No File Attached';
    btnClearMedia.classList.add('hidden');
});

// EXCEL PARSER
excelDropzone.addEventListener('click', () => excelFileInput.click());

excelFileInput.addEventListener('change', handleExcelUpload);

excelDropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    excelDropzone.classList.add('active');
});

excelDropzone.addEventListener('dragleave', () => {
    excelDropzone.classList.remove('active');
});

excelDropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    excelDropzone.classList.remove('active');
    if (e.dataTransfer.files.length > 0) {
        excelFileInput.files = e.dataTransfer.files;
        handleExcelUpload();
    }
});

function handleExcelUpload() {
    const file = excelFileInput.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, { type: 'array' });
            const firstSheetName = workbook.SheetNames[0];
            const worksheet = workbook.Sheets[firstSheetName];

            const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
            parsedContacts = [];

            if (rows.length < 2) {
                alert('Uploaded Excel/CSV file is empty or missing headers!');
                return;
            }

            const headers = rows[0].map(h => String(h || '').trim().toLowerCase());
            
            let phoneIdx = headers.findIndex(h => h.includes('phone') || h.includes('mobile') || h.includes('number') || h.includes('contact'));
            let nameIdx = headers.findIndex(h => h.includes('name') || h.includes('user') || h.includes('customer'));

            if (phoneIdx === -1) phoneIdx = 0;
            if (nameIdx === -1) nameIdx = 1;

            for (let i = 1; i < rows.length; i++) {
                const row = rows[i];
                if (!row || row.length === 0) continue;

                let rawPhone = row[phoneIdx] ? String(row[phoneIdx]).trim() : '';
                let name = (nameIdx !== -1 && row[nameIdx]) ? String(row[nameIdx]).trim() : 'Customer';

                let cleanPhone = rawPhone.replace(/\D/g, '');

                if (cleanPhone.length >= 10) {
                    parsedContacts.push({
                        name: name || 'Customer',
                        phone: cleanPhone,
                        rawPhone: rawPhone
                    });
                }
            }

            totalContactsCount.textContent = parsedContacts.length;
            pendingCountEl.textContent = parsedContacts.length;
            sentCountEl.textContent = 0;
            failedCountEl.textContent = 0;

            excelFileStatus.innerHTML = `
                <div style="color:var(--success); font-weight:600;">
                    <i class="fa-solid fa-file-csv"></i> Loaded ${parsedContacts.length} valid contacts from ${file.name}
                </div>
            `;

            appendTerminalLog({
                type: 'success',
                timestamp: new Date().toLocaleTimeString(),
                text: `📊 Successfully parsed ${parsedContacts.length} contacts from ${file.name}`
            });

        } catch (err) {
            console.error('Excel parse error:', err);
            alert('Failed to parse Excel file. Please ensure it is a valid .xlsx or .csv file.');
        }
    };
    reader.readAsArrayBuffer(file);
}

// CAMPAIGN CONTROLLER
btnStartCampaign.addEventListener('click', () => {
    if (isCampaignRunning) {
        alert('Campaign is already running!');
        return;
    }

    if (parsedContacts.length === 0) {
        alert('Please select a valid Excel/CSV file with contacts first!');
        return;
    }

    const messageTemplate = campaignMsgText.value.trim();
    if (!messageTemplate) {
        alert('Please enter a campaign message text!');
        return;
    }

    const connectedAccs = accountsState.filter(a => a.status === 'CONNECTED');
    if (connectedAccs.length === 0) {
        alert('No WhatsApp account is connected! Please scan QR code first.');
        return;
    }

    const mode = selectRoutingMode.value;
    let customQuotas = {};

    if (mode === 'CUSTOM_RATIO') {
        document.querySelectorAll('.custom-quota-input').forEach(input => {
            const accId = input.getAttribute('data-accid');
            const val = parseInt(input.value) || 0;
            customQuotas[accId] = val;
        });
    }

    const campaignPayload = {
        contacts: parsedContacts,
        messageTemplate: messageTemplate,
        mediaObj: currentMediaObj,
        dispatchMode: mode,
        specificAccId: selectSpecificAcc.value,
        customQuotas: customQuotas
    };

    isCampaignRunning = true;
    btnStartCampaign.disabled = true;
    btnStartCampaign.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Campaign Running...';

    socket.emit('start_campaign', campaignPayload);

    appendTerminalLog({
        type: 'info',
        timestamp: new Date().toLocaleTimeString(),
        text: `🚀 Launching campaign to ${parsedContacts.length} contacts using ${connectedAccs.length} active WhatsApp accounts...`
    });
});

// TERMINAL LOG HELPERS
function appendTerminalLog(log) {
    if (!terminalLogs) return;
    const div = document.createElement('div');
    div.className = `log-entry ${log.type || 'info'}`;
    div.innerHTML = `<span class="log-time">[${log.timestamp || new Date().toLocaleTimeString()}]</span> ${log.text}`;
    terminalLogs.appendChild(div);
    terminalLogs.scrollTop = terminalLogs.scrollHeight;
}

if (btnClearTerminal) {
    btnClearTerminal.addEventListener('click', () => {
        terminalLogs.innerHTML = '<div class="log-entry info"><span class="log-time">[System]</span> Terminal logs cleared.</div>';
    });
}
