/**
 * AutoWhatsApp Pro - Official Cloud Backend Controller with AWS EC2 Server IP
 */

// Official AWS Cloud Server IP
const RENDER_CLOUD_URL = 'http://16.16.160.123:3000';

let socketHost = RENDER_CLOUD_URL;
if (window.location.protocol.startsWith('http') && !window.location.origin.includes('file://')) {
    socketHost = window.location.origin;
}

const socket = io(socketHost, { 
    reconnection: true, 
    reconnectionDelay: 1000, 
    timeout: 10000,
    transports: ['websocket', 'polling']
});

// Helper for Privacy Masking (e.g. 7340216019 -> 7340XXXXXX)
function maskPhoneNumber(phone) {
    if (!phone) return '';
    const clean = String(phone).replace(/\D/g, '');
    if (clean.length <= 6) return clean;
    const visible = clean.substring(0, clean.length - 6);
    return visible + 'XXXXXX';
}

// Global State
let accountsState = [];
let parsedContacts = [];
let currentMediaObj = null;
let autoReplyRules = [];
let activeLoginModes = {};
let requestedPhoneNumbers = {};
let campaignStats = { total: 0, sent: 0, pending: 0, failed: 0, dailySent24h: 0, activeAccountsCount: 0, speedCapPerMin: 30 };

// DOM Elements
const accountsGrid = document.getElementById('accountsGrid');
const btnAddAccount = document.getElementById('btnAddAccount');
const btnLogoutAll = document.getElementById('btnLogoutAll');
const accCountTag = document.getElementById('accCountTag');

// Routing Controls
const selectRoutingMode = document.getElementById('selectRoutingMode');
const specificAccContainer = document.getElementById('specificAccContainer');
const selectSpecificAcc = document.getElementById('selectSpecificAcc');
const customRatioContainer = document.getElementById('customRatioContainer');
const ratioInputsGrid = document.getElementById('ratioInputsGrid');

// Media Controls
const mediaFileInput = document.getElementById('mediaFileInput');
const btnPickMedia = document.getElementById('btnPickMedia');
const mediaNameTag = document.getElementById('mediaNameTag');
const btnClearMedia = document.getElementById('btnClearMedia');

// Auto-Responder Controls
const btnAddRule = document.getElementById('btnAddRule');
const rulesList = document.getElementById('rulesList');

// Speed Matrix
const speedLockBadge = document.getElementById('speedLockBadge');
const statSpeedCap = document.getElementById('statSpeedCap');

// Message & Excel
const messageTemplate = document.getElementById('messageTemplate');
const dropzone = document.getElementById('dropzone');
const excelFileInput = document.getElementById('excelFileInput');
const fileStatusBadge = document.getElementById('fileStatusBadge');
const tablePreviewContainer = document.getElementById('tablePreviewContainer');
const previewInfo = document.getElementById('previewInfo');
const btnChangeFile = document.getElementById('btnChangeFile');
const contactsTable = document.getElementById('contactsTable');
const tableHeaderRow = document.getElementById('tableHeaderRow');
const tableBody = document.getElementById('tableBody');

// Action Buttons
const btnStartCampaign = document.getElementById('btnStartCampaign');
const btnPauseCampaign = document.getElementById('btnPauseCampaign');
const btnResumeCampaign = document.getElementById('btnResumeCampaign');
const btnStopCampaign = document.getElementById('btnStopCampaign');
const btnExportReport = document.getElementById('btnExportReport');

// Stats Counters
const statTotal = document.getElementById('statTotal');
const statSent = document.getElementById('statSent');
const statPending = document.getElementById('statPending');
const statFailed = document.getElementById('statFailed');
const terminalLogs = document.getElementById('terminalLogs');

// Socket Listeners
socket.on('connect', () => {
    console.log('✅ Socket connected to AWS Server:', socketHost);
    appendTerminalLog({
        type: 'success',
        timestamp: new Date().toLocaleTimeString(),
        text: `✅ Connected to 24/7 AWS Server (${socketHost})`
    });
});

socket.on('accounts_update', (accounts) => {
    accountsState = accounts || [];
    renderAccountsUI(accountsState);
});

socket.on('pairing_code_response', ({ success, accId, code, phoneNumber }) => {
    if (success) {
        const maskedPhone = maskPhoneNumber(phoneNumber || requestedPhoneNumbers[accId]);
        const resultContainer = document.getElementById(`code-result-${accId}`);
        if (resultContainer) {
            resultContainer.innerHTML = `
                <div class="pairing-code-box">
                    <span style="font-size:11px; color:var(--text-muted);">Pairing Code for <strong>${maskedPhone}</strong>:</span>
                    <div class="pairing-code-display">${code}</div>
                    <span style="font-size:10px; color:var(--warning); font-weight:600;">Open WhatsApp ➔ Linked Devices ➔ Link with phone number</span>
                </div>
            `;
        }
        appendTerminalLog({
            type: 'success',
            timestamp: new Date().toLocaleTimeString(),
            text: `🔑 8-Digit Pairing Code for ${maskedPhone}: ${code}`
        });
    }
});

socket.on('queue_update', (data) => {
    if (data.stats) {
        campaignStats = data.stats;
        statTotal.textContent = data.stats.total || 0;
        statSent.textContent = data.stats.sent || 0;
        statPending.textContent = data.stats.pending || 0;
        statFailed.textContent = data.stats.failed || 0;
    }
    if (data.status) toggleCampaignButtons(data.status);
    if (data.queue && data.queue.length > 0) updateTableStatusPills(data.queue);
});

socket.on('campaign_log', (logEntry) => appendTerminalLog(logEntry));

socket.on('campaign_finished', (summary) => {
    appendTerminalLog({
        type: 'success',
        timestamp: new Date().toLocaleTimeString(),
        text: '🎉 Campaign Execution Finished!'
    });
    toggleCampaignButtons('completed');
});

socket.on('error_alert', ({ message }) => {
    alert(message);
    appendTerminalLog({ type: 'error', timestamp: new Date().toLocaleTimeString(), text: `⚠️ ${message}` });
});

// Helper Functions
window.insertTag = function(tag) {
    const startPos = messageTemplate.selectionStart;
    const endPos = messageTemplate.selectionEnd;
    const text = messageTemplate.value;
    messageTemplate.value = text.substring(0, startPos) + tag + text.substring(endPos, text.length);
    messageTemplate.focus();
    messageTemplate.selectionStart = startPos + tag.length;
    messageTemplate.selectionEnd = startPos + tag.length;
};

window.clearTerminalLogs = function() {
    terminalLogs.innerHTML = '<div class="log-line system">[System] Logs cleared.</div>';
};

const SPEED_CAPS = [0, 30, 60, 100, 150, 250, 350, 400, 450, 500, 600];

// ----------------------------------------------------
// MULTI-ACCOUNT RENDERER (2-BOX GRID PATTERN)
// ----------------------------------------------------

window.onLoginModeSwitched = function(accId, mode) {
    activeLoginModes[accId] = mode;
};

function renderAccountsUI(accounts) {
    if (!accounts || accounts.length === 0) {
        accounts = [{ id: 'acc_1', status: 'DISCONNECTED', qrCodeDataUrl: null, pairingCode: null, userInfo: null }];
    }

    if (accCountTag) accCountTag.textContent = accounts.length;

    let connectedCount = 0;
    accounts.forEach(a => {
        if (a.status === 'CONNECTED') connectedCount++;
    });

    if (btnLogoutAll) {
        if (connectedCount > 0) btnLogoutAll.classList.remove('hidden');
        else btnLogoutAll.classList.add('hidden');
    }

    let html = '';
    let specificOptionsHtml = '';
    let ratioInputsHtml = '';

    accounts.forEach((acc, index) => {
        const isConnected = acc.status === 'CONNECTED';
        const isQrReady = acc.status === 'QR_READY' && acc.qrCode;
        const isCodeReady = acc.status === 'PAIRING_CODE_READY' && acc.pairingCode;

        let mode = activeLoginModes[acc.id] || (isCodeReady ? 'PHONE' : (isQrReady ? 'QR' : null));

        const slotTitle = `WhatsApp Account Slot ${index + 1}`;
        const rawWid = isConnected && acc.userInfo && acc.userInfo.wid ? acc.userInfo.wid : '';
        const phoneMasked = rawWid ? `+${maskPhoneNumber(rawWid)}` : 'Disconnected';
        const namePush = isConnected && acc.userInfo ? acc.userInfo.pushname : slotTitle;

        if (isConnected) {
            specificOptionsHtml += `<option value="${acc.id}">📲 ${phoneMasked} (${namePush})</option>`;
            ratioInputsHtml += `
                <div class="form-group">
                    <label class="form-label">${phoneMasked} (${namePush})</label>
                    <input type="number" id="quota-${acc.id}" class="form-input custom-quota-input" data-accid="${acc.id}" placeholder="Max msgs e.g. 50" value="100">
                </div>
            `;
        }

        html += `
            <div class="account-card ${isConnected ? 'connected' : (isQrReady || isCodeReady ? 'qr-ready' : '')}" id="acc-card-${acc.id}">
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
                    <!-- 2-BOX GRID SELECTION -->
                    <div class="login-grid-2box">
                        <div class="login-box-card ${mode === 'QR' ? 'active' : ''}" id="box-qr-${acc.id}" onclick="selectLoginBoxMode('${acc.id}', 'QR')">
                            <div class="login-box-icon"><i class="fa-solid fa-qrcode"></i></div>
                            <div class="login-box-title">Scan QR Code</div>
                            <div class="login-box-sub">Tap to scan QR using phone</div>
                        </div>

                        <div class="login-box-card phone-card ${mode === 'PHONE' ? 'active' : ''}" id="box-phone-${acc.id}" onclick="selectLoginBoxMode('${acc.id}', 'PHONE')">
                            <div class="login-box-icon"><i class="fa-solid fa-key"></i></div>
                            <div class="login-box-title">Phone Pair Code</div>
                            <div class="login-box-sub">Tap for 8-digit code (****-****)</div>
                        </div>
                    </div>

                    <!-- QR DISPLAY CONTAINER -->
                    <div class="qr-container-box ${mode === 'QR' ? '' : 'hidden'}" id="qr-container-${acc.id}" style="margin-top:10px;">
                        ${isQrReady ? `
                            <div class="qr-box-center">
                                <img src="${acc.qrCode}" alt="Scan QR Code">
                                <div class="qr-instruction">
                                    <i class="fa-solid fa-qrcode"></i> Scan this QR code with WhatsApp Linked Devices on your phone
                                </div>
                            </div>
                        ` : `
                            <div class="acc-loading-box" style="padding: 14px;">
                                <i class="fa-solid fa-spinner fa-spin"></i> Loading WhatsApp QR Code... Please wait 3 seconds.
                            </div>
                        `}
                    </div>

                    <!-- PHONE PAIRING CONTAINER -->
                    <div class="pairing-input-box ${mode === 'PHONE' ? '' : 'hidden'}" id="phone-container-${acc.id}" style="margin-top:10px;">
                        <label class="form-label" style="font-size:11px;">Enter Phone Number with Country Code (e.g. 917340216019)</label>
                        <div class="pairing-input-row">
                            <input type="tel" id="phone-input-${acc.id}" class="pairing-input" placeholder="917340216019">
                            <button type="button" class="btn btn-primary btn-sm" onclick="submitPairingCodeRequest('${acc.id}')">Get 8-Digit Code</button>
                        </div>
                        <div id="code-result-${acc.id}">
                            ${isCodeReady ? `
                                <div class="pairing-code-box">
                                    <span style="font-size:11px; color:var(--text-muted);">Pairing Code for <strong>${maskPhoneNumber(requestedPhoneNumbers[acc.id])}</strong>:</span>
                                    <div class="pairing-code-display">${acc.pairingCode}</div>
                                    <span style="font-size:10px; color:var(--warning); font-weight:600;">Open WhatsApp ➔ Linked Devices ➔ Link with phone number</span>
                                </div>
                            ` : ''}
                        </div>
                    </div>
                ` : ''}
            </div>
        `;
    });

    // Save existing input values and pairing code display boxes before re-render
    const existingInputValues = {};
    const existingCodeBoxes = {};
    const activeElId = document.activeElement ? document.activeElement.id : null;
    const activeSelStart = (document.activeElement && typeof document.activeElement.selectionStart === 'number') ? document.activeElement.selectionStart : null;
    const activeSelEnd = (document.activeElement && typeof document.activeElement.selectionEnd === 'number') ? document.activeElement.selectionEnd : null;

    accounts.forEach(acc => {
        const inputEl = document.getElementById(`phone-input-${acc.id}`);
        if (inputEl) existingInputValues[acc.id] = inputEl.value;

        const codeEl = document.getElementById(`code-result-${acc.id}`);
        if (codeEl && codeEl.innerHTML.includes('pairing-code-display')) {
            existingCodeBoxes[acc.id] = codeEl.innerHTML;
        }
    });

    accountsGrid.innerHTML = html;

    // Restore existing input values and pairing code display boxes after re-render
    accounts.forEach(acc => {
        const inputEl = document.getElementById(`phone-input-${acc.id}`);
        if (inputEl && existingInputValues[acc.id] !== undefined) {
            inputEl.value = existingInputValues[acc.id];
        }

        const codeEl = document.getElementById(`code-result-${acc.id}`);
        if (codeEl && existingCodeBoxes[acc.id]) {
            codeEl.innerHTML = existingCodeBoxes[acc.id];
        }
    });

    if (activeElId) {
        const restoredEl = document.getElementById(activeElId);
        if (restoredEl && typeof restoredEl.focus === 'function') {
            restoredEl.focus();
            if (activeSelStart !== null && activeSelEnd !== null && typeof restoredEl.setSelectionRange === 'function') {
                try { restoredEl.setSelectionRange(activeSelStart, activeSelEnd); } catch (e) {}
            }
        }
    }

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

window.submitPairingCodeRequest = function(accId) {
    const input = document.getElementById(`phone-input-${accId}`);
    if (!input || !input.value.trim()) {
        alert('Please enter your phone number with country code (e.g. 917340216019)');
        return;
    }

    const phone = input.value.trim();
    requestedPhoneNumbers[accId] = phone;
    activeLoginModes[accId] = 'PHONE';

    socket.emit('request_pairing_code', { accId, phoneNumber: phone });
    
    const maskedPhone = maskPhoneNumber(phone);
    const resultContainer = document.getElementById(`code-result-${accId}`);
    if (resultContainer) {
        resultContainer.innerHTML = `
            <div class="acc-loading-box" style="padding: 12px; margin-top: 8px;">
                <i class="fa-solid fa-spinner fa-spin"></i> Requesting 8-digit pairing code for <strong>${maskedPhone}</strong>...
            </div>
        `;
    }

    appendTerminalLog({
        type: 'info',
        timestamp: new Date().toLocaleTimeString(),
        text: `⏳ Requesting 8-digit pairing code for ${maskedPhone}...`
    });
};

window.logoutAccount = function(accId) {
    if (confirm(`Logout WhatsApp account slot (${accId})?`)) {
        socket.emit('logout_account', { accId });
    }
};

if (btnAddAccount) {
    btnAddAccount.addEventListener('click', () => {
        const hasUnconnected = accountsState.some(a => a.status !== 'CONNECTED');
        if (hasUnconnected) {
            alert('Please scan or pair the current WhatsApp QR / Code before adding a new account!');
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
    mediaNameTag.style.color = 'var(--text-muted)';
    btnClearMedia.classList.add('hidden');
});

// AUTO-RESPONDER RULES
let ruleIdCounter = 1;

btnAddRule.addEventListener('click', () => {
    const ruleId = ruleIdCounter++;
    autoReplyRules.push({ id: ruleId, keyword: '', replyText: '' });
    renderAutoReplyRules();
});

function renderAutoReplyRules() {
    if (autoReplyRules.length === 0) {
        rulesList.innerHTML = '<p style="font-size:11px; color:var(--text-muted);">No rules added. Click "+ Add Rule" to create automated replies.</p>';
        return;
    }

    let html = '';
    autoReplyRules.forEach((rule, idx) => {
        html += `
            <div class="rule-card" id="rule-card-${rule.id}">
                <div class="rule-header">
                    <span style="font-size:11px; font-weight:700; color:var(--primary);">Rule #${idx + 1}</span>
                    <button type="button" class="btn-clear" onclick="removeRule(${rule.id})">
                        <i class="fa-solid fa-trash-can" style="color:var(--danger);"></i> Remove
                    </button>
                </div>
                <input type="text" class="rule-kw-input" placeholder="Keyword e.g. 1 or BUY or HI" value="${rule.keyword}" oninput="updateRuleKw(${rule.id}, this.value)">
                <textarea class="rule-reply-input" rows="2" placeholder="Automated Reply Message e.g. Here is your Buy Link: https://..." oninput="updateRuleReply(${rule.id}, this.value)">${rule.replyText}</textarea>
            </div>
        `;
    });
    rulesList.innerHTML = html;
}

window.updateRuleKw = function(id, val) {
    const r = autoReplyRules.find(x => x.id === id);
    if (r) r.keyword = val;
};

window.updateRuleReply = function(id, val) {
    const r = autoReplyRules.find(x => x.id === id);
    if (r) r.replyText = val;
};

window.removeRule = function(id) {
    autoReplyRules = autoReplyRules.filter(x => x.id !== id);
    renderAutoReplyRules();
};

// EXCEL PARSER
dropzone.addEventListener('click', () => excelFileInput.click());
dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.style.borderColor = 'var(--primary)'; });
dropzone.addEventListener('dragleave', () => { dropzone.style.borderColor = 'var(--card-border)'; });
dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.style.borderColor = 'var(--card-border)';
    if (e.dataTransfer.files.length > 0) handleFileSelect(e.dataTransfer.files[0]);
});

excelFileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) handleFileSelect(e.target.files[0]);
});

btnChangeFile.addEventListener('click', () => {
    parsedContacts = [];
    dropzone.classList.remove('hidden');
    tablePreviewContainer.classList.add('hidden');
    fileStatusBadge.textContent = 'No File';
    fileStatusBadge.style.color = 'var(--text-muted)';
    statTotal.textContent = '0';
    statPending.textContent = '0';
});

function handleFileSelect(file) {
    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, { type: 'array' });
            const sheetName = workbook.SheetNames[0];
            const sheet = workbook.Sheets[sheetName];

            let rawRows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
            if (!rawRows || rawRows.length === 0) {
                alert('Excel sheet is empty!');
                return;
            }

            let headers = Object.keys(rawRows[0]);
            const isHeaderAPhoneNumber = headers.some(h => String(h).replace(/\D/g, '').length >= 10);
            if (isHeaderAPhoneNumber) {
                const headerRow = {};
                headers.forEach(h => headerRow[h] = h);
                rawRows.unshift(headerRow);
            }

            parsedContacts = rawRows;
            renderContactsPreview(headers, rawRows);

            dropzone.classList.add('hidden');
            tablePreviewContainer.classList.remove('hidden');
            fileStatusBadge.textContent = `Loaded ${file.name}`;
            fileStatusBadge.style.color = 'var(--primary)';
            
            previewInfo.textContent = `Total Contacts Loaded: ${parsedContacts.length}`;
            statTotal.textContent = parsedContacts.length;
            statPending.textContent = parsedContacts.length;

            appendTerminalLog({
                type: 'info',
                timestamp: new Date().toLocaleTimeString(),
                text: `📁 Loaded file ${file.name} with ${parsedContacts.length} contacts.`
            });
        } catch (err) {
            alert('File processing error: ' + err.message);
        }
    };
    reader.readAsArrayBuffer(file);
}

function renderContactsPreview(headers, rows) {
    let headerHtml = '<th>#</th>';
    headers.forEach(h => headerHtml += `<th>${h}</th>`);
    headerHtml += '<th>Status</th>';
    tableHeaderRow.innerHTML = headerHtml;

    let bodyHtml = '';
    rows.slice(0, 100).forEach((row, i) => {
        bodyHtml += `<tr id="contact-row-${i + 1}">`;
        bodyHtml += `<td>${i + 1}</td>`;
        headers.forEach(h => bodyHtml += `<td>${row[h] !== undefined ? row[h] : ''}</td>`);
        bodyHtml += `<td><span class="status-pill pending" id="pill-${i + 1}">Pending</span></td>`;
        bodyHtml += `</tr>`;
    });
    tableBody.innerHTML = bodyHtml;
}

function updateTableStatusPills(queue) {
    queue.forEach((item) => {
        const pill = document.getElementById(`pill-${item.id}`);
        if (pill) {
            pill.className = `status-pill ${item.status}`;
            pill.textContent = item.status.toUpperCase();
        }
    });
}

// CAMPAIGN EXECUTION
btnStartCampaign.addEventListener('click', () => {
    const connectedAccounts = accountsState.filter(a => a.status === 'CONNECTED');
    if (connectedAccounts.length === 0) {
        alert('Please connect at least 1 WhatsApp account before starting campaign!');
        return;
    }

    if (parsedContacts.length === 0) {
        alert('Please upload an Excel file containing contacts first!');
        return;
    }

    const template = messageTemplate.value.trim();
    if (!template && !currentMediaObj) {
        alert('Please write a message template or attach a media file before starting!');
        return;
    }

    const mode = selectRoutingMode.value;
    const routingConfig = {
        mode,
        selectedAccId: selectSpecificAcc.value,
        customRatioLimits: {}
    };

    if (mode === 'CUSTOM_RATIO') {
        document.querySelectorAll('.custom-quota-input').forEach(input => {
            const accId = input.getAttribute('data-accid');
            const val = parseInt(input.value) || 99999;
            routingConfig.customRatioLimits[accId] = val;
        });
    }

    const settings = { maxPer24Hours: 2000, minDelaySeconds: 3, maxDelaySeconds: 8 };

    socket.emit('start_campaign', {
        contacts: parsedContacts,
        template,
        settings,
        routingConfig,
        mediaObj: currentMediaObj,
        autoReplyRules
    });

    appendTerminalLog({
        type: 'info',
        timestamp: new Date().toLocaleTimeString(),
        text: `🚀 Starting Campaign (${mode} mode across ${connectedAccounts.length} numbers)...`
    });
});

btnPauseCampaign.addEventListener('click', () => socket.emit('pause_campaign'));
btnResumeCampaign.addEventListener('click', () => socket.emit('resume_campaign'));
btnStopCampaign.addEventListener('click', () => socket.emit('stop_campaign'));

function toggleCampaignButtons(status) {
    btnStartCampaign.classList.add('hidden');
    btnPauseCampaign.classList.add('hidden');
    btnResumeCampaign.classList.add('hidden');
    btnStopCampaign.classList.add('hidden');

    if (status === 'running') {
        btnPauseCampaign.classList.remove('hidden');
        btnStopCampaign.classList.remove('hidden');
    } else if (status === 'paused') {
        btnResumeCampaign.classList.remove('hidden');
        btnStopCampaign.classList.remove('hidden');
    } else {
        btnStartCampaign.classList.remove('hidden');
    }
}

btnExportReport.addEventListener('click', () => {
    if (parsedContacts.length === 0) {
        alert('No campaign data to export!');
        return;
    }

    let csvContent = "data:text/csv;charset=utf-8,Index,Name,Phone,Status\n";
    parsedContacts.forEach((c, idx) => {
        const pill = document.getElementById(`pill-${idx + 1}`);
        const status = pill ? pill.textContent : 'Pending';
        csvContent += `${idx + 1},"${c.Name || c.name || ''}","${c.Phone || c.phone || ''}","${status}"\n`;
    });

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `autowhatsapp_pro_report_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
});

function appendTerminalLog(log) {
    const line = document.createElement('div');
    line.className = `log-line ${log.type || 'info'}`;
    line.textContent = `[${log.timestamp || new Date().toLocaleTimeString()}] ${log.text}`;
    terminalLogs.appendChild(line);
    terminalLogs.scrollTop = terminalLogs.scrollHeight;
}
