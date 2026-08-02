/**
 * AutoWhatsApp Pro - SaaS Multi-Tenant Platform Frontend Logic
 * Firebase Authentication + Strict Session Isolation + Daily 50 SMS Free Trial Limit
 */

const RENDER_CLOUD_URL = 'http://16.16.160.123:3000';

let socketHost = RENDER_CLOUD_URL;
if (typeof window !== 'undefined' && window.location && window.location.hostname && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1' && !window.location.protocol.startsWith('file')) {
    socketHost = window.location.origin;
}

let currentUser = null;
let socket = null;
let isRefreshingQr = false;

// UI State
let accountsState = [];
let parsedContacts = [];
let isCampaignRunning = false;
let currentMediaObj = null;

// DOM Elements - Auth Modal
const saasAuthOverlay = document.getElementById('saas-auth-overlay');
const mainAppContainer = document.getElementById('main-app-container');
const btnGoogleLogin = document.getElementById('btn-google-login');
const btnEmailLogin = document.getElementById('btn-email-login');
const btnEmailSignup = document.getElementById('btn-email-signup');
const authEmailInput = document.getElementById('auth-email');
const authPasswordInput = document.getElementById('auth-password');

// DOM Elements - User Header Profile
const userAvatarImg = document.getElementById('user-avatar-img');
const userDisplayName = document.getElementById('user-display-name');
const userPlanBadge = document.getElementById('user-plan-badge');
const btnUserLogout = document.getElementById('btn-user-logout');

const sidebarUserAvatar = document.getElementById('sidebar-user-avatar');
const sidebarUserName = document.getElementById('sidebar-user-name');
const sidebarUserEmail = document.getElementById('sidebar-user-email');
const sidebarPlanBadge = document.getElementById('sidebar-plan-badge');
const quotaUsedMsgs = document.getElementById('quota-used-msgs');
const quotaMaxMsgs = document.getElementById('quota-max-msgs');

// DOM Elements - App Stats & Controls
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
    1: 30, 2: 60, 3: 100, 4: 150, 5: 250,
    6: 350, 7: 400, 8: 450, 9: 500, 10: 600
};

// FIREBASE AUTH STATE LISTENER
if (typeof firebase !== 'undefined' && firebase.auth) {
    firebase.auth().onAuthStateChanged((user) => {
        if (user) {
            currentUser = user;
            console.log('Firebase User Authenticated:', user.email || user.uid);
            
            // Render Profile UI
            const displayName = user.displayName || user.email?.split('@')[0] || 'Pro SaaS User';
            const avatarUrl = user.photoURL || `https://ui-avatars.com/api/?name=${encodeURIComponent(displayName)}&background=00f2fe&color=fff`;

            if (userDisplayName) userDisplayName.textContent = displayName;
            if (userAvatarImg) userAvatarImg.src = avatarUrl;
            
            if (sidebarUserName) sidebarUserName.textContent = displayName;
            if (sidebarUserEmail) sidebarUserEmail.textContent = user.email || user.uid;
            if (sidebarUserAvatar) sidebarUserAvatar.src = avatarUrl;

            if (saasAuthOverlay) saasAuthOverlay.classList.add('hidden');
            if (mainAppContainer) mainAppContainer.classList.remove('hidden');

            // Connect Isolated Socket for User
            initUserSocket(user);

        } else {
            currentUser = null;
            if (saasAuthOverlay) saasAuthOverlay.classList.remove('hidden');
            if (mainAppContainer) mainAppContainer.classList.add('hidden');
            if (socket) {
                socket.disconnect();
            }
        }
    });
}

// GOOGLE SIGN IN
if (btnGoogleLogin) {
    btnGoogleLogin.addEventListener('click', () => {
        const provider = new firebase.auth.GoogleAuthProvider();
        firebase.auth().signInWithPopup(provider).catch(err => {
            console.error('Google Sign-In Error:', err);
            alert('Google Sign-In failed: ' + err.message);
        });
    });
}

// EMAIL SIGN IN / SIGN UP
if (btnEmailLogin) {
    btnEmailLogin.addEventListener('click', () => {
        const email = authEmailInput.value.trim();
        const password = authPasswordInput.value.trim();
        if (!email || !password) {
            alert('Please enter your email address and password!');
            return;
        }
        firebase.auth().signInWithEmailAndPassword(email, password).catch(err => {
            alert('Sign-In failed: ' + err.message);
        });
    });
}

if (btnEmailSignup) {
    btnEmailSignup.addEventListener('click', () => {
        const email = authEmailInput.value.trim();
        const password = authPasswordInput.value.trim();
        if (!email || !password) {
            alert('Please enter your email address and password!');
            return;
        }
        if (password.length < 6) {
            alert('Password should be at least 6 characters long!');
            return;
        }
        firebase.auth().createUserWithEmailAndPassword(email, password).then(res => {
            alert('Account created successfully! Welcome to AutoWhatsApp Pro SaaS.');
        }).catch(err => {
            alert('Registration failed: ' + err.message);
        });
    });
}

if (btnUserLogout) {
    btnUserLogout.addEventListener('click', () => {
        if (confirm('Sign out of AutoWhatsApp Pro SaaS?')) {
            firebase.auth().signOut();
        }
    });
}

// USER ISOLATED SOCKET CONNECTION
function initUserSocket(user) {
    if (socket) socket.disconnect();

    socket = io(socketHost, {
        transports: ['websocket', 'polling'],
        auth: {
            uid: user.uid,
            email: user.email || ''
        }
    });

    socket.on('connect', () => {
        console.log('Isolated SaaS Socket Connected:', socket.id);
        appendTerminalLog({
            type: 'success',
            timestamp: new Date().toLocaleTimeString(),
            text: `⚡ Authenticated SaaS Cloud Connection [UID: ${user.uid.slice(0, 6)}...]`
        });
        socket.emit('request_qr', { accId: 'acc_1' });
    });

    socket.on('accounts_update', (accounts) => {
        accountsState = accounts;
        renderAccounts(accounts);
    });

    socket.on('user_quota_info', (quota) => {
        if (quota) {
            const used = quota.dailySentToday || 0;
            const max = quota.plan === 'PRO' ? '∞' : (quota.dailyMaxQuota || 50);
            
            if (quotaUsedMsgs) quotaUsedMsgs.textContent = used;
            if (quotaMaxMsgs) quotaMaxMsgs.textContent = max;

            if (quota.plan === 'PRO') {
                if (userPlanBadge) {
                    userPlanBadge.textContent = 'PRO Plan';
                    userPlanBadge.className = 'user-plan-tag pro';
                }
                if (sidebarPlanBadge) {
                    sidebarPlanBadge.textContent = 'PRO Plan';
                    sidebarPlanBadge.style.color = 'var(--primary)';
                }
            } else {
                if (userPlanBadge) {
                    userPlanBadge.textContent = `Free Trial: ${Math.max(0, 50 - used)} msgs left today`;
                    userPlanBadge.className = 'user-plan-tag free';
                }
                if (sidebarPlanBadge) {
                    sidebarPlanBadge.textContent = 'Free Trial';
                    sidebarPlanBadge.style.color = 'var(--accent)';
                }
            }
        }
    });

    socket.on('campaign_progress', (data) => {
        const { sent, pending, failed } = data;
        if (sentCountEl) sentCountEl.textContent = sent;
        if (pendingCountEl) pendingCountEl.textContent = pending;
        if (failedCountEl) failedCountEl.textContent = failed;
    });

    socket.on('campaign_log', (log) => {
        appendTerminalLog(log);
        if (log && log.phone) {
            updateContactTableStatus(log.phone, log.type === 'success' ? 'Sent' : 'Failed');
        }
    });

    socket.on('campaign_finished', (summary) => {
        isCampaignRunning = false;
        if (btnStartCampaign) {
            btnStartCampaign.disabled = false;
            btnStartCampaign.className = 'btn btn-success btn-lg full-btn';
            btnStartCampaign.innerHTML = '<i class="fa-solid fa-play"></i> Start Campaign';
        }
        appendTerminalLog({
            type: 'success',
            timestamp: new Date().toLocaleTimeString(),
            text: `🎉 Campaign Dispatch Completed! (Sent: ${summary?.sent || 0}, Failed: ${summary?.failed || 0})`
        });
    });

    socket.on('error_alert', (data) => {
        isCampaignRunning = false;
        if (btnStartCampaign) {
            btnStartCampaign.disabled = false;
            btnStartCampaign.className = 'btn btn-success btn-lg full-btn';
            btnStartCampaign.innerHTML = '<i class="fa-solid fa-play"></i> Start Campaign';
        }
        alert(data.message);
        appendTerminalLog({
            type: 'error',
            timestamp: new Date().toLocaleTimeString(),
            text: `⚠️ ${data.message}`
        });
    });
}

// Masking Helper
function maskPhoneNumber(phone) {
    if (!phone) return 'Disconnected';
    const clean = String(phone).replace(/\D/g, '');
    if (clean.length < 10) return clean;
    const prefix = clean.slice(0, 4);
    const suffix = clean.slice(-2);
    return `${prefix}XXXX${suffix}`;
}

// Render Accounts Multi-Slot Grid (Direct 0-Click QR)
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
                    ` : `
                        <button class="btn btn-primary btn-sm" onclick="requestFreshQrSlot('${acc.id}')" title="Refresh QR Code">
                            <i class="fa-solid fa-arrows-rotate"></i> Refresh QR
                        </button>
                    `}
                </div>

                ${!isConnected ? `
                    <div class="qr-container-box" id="qr-container-${acc.id}" style="margin-top:12px; text-align:center;">
                        ${isQrReady ? `
                            <div class="qr-box-center" style="display:inline-block; background:#ffffff; padding:12px; border-radius:12px; box-shadow: 0 4px 15px rgba(0,0,0,0.3);">
                                <img src="${acc.qrCode}" alt="Scan QR Code" style="width:200px; height:200px; display:block;">
                            </div>
                            <div class="qr-instruction" style="margin-top:8px; font-size:11px; color:var(--primary); font-weight:600;">
                                <i class="fa-solid fa-qrcode"></i> Open WhatsApp ➔ Linked Devices ➔ Scan this QR Code
                            </div>
                        ` : `
                            <div class="acc-loading-box" style="padding: 16px; border:1px dashed var(--border-color); border-radius:12px;">
                                <i class="fa-solid fa-spinner fa-spin" style="font-size:20px; color:var(--primary);"></i>
                                <div style="margin-top:8px; font-size:12px;">Generating Fresh WhatsApp QR Code...</div>
                            </div>
                        `}
                    </div>
                ` : ''}
            </div>
        `;
    });

    accountsGrid.innerHTML = html;
    if (selectSpecificAcc) selectSpecificAcc.innerHTML = specificOptionsHtml || '<option value="">No Accounts Connected</option>';
    if (ratioInputsGrid) ratioInputsGrid.innerHTML = ratioInputsHtml || '<p style="font-size:11px; color:var(--text-muted);">Connect WhatsApp accounts to set custom quotas.</p>';

    const cap = SPEED_CAPS[connectedCount] || (connectedCount > 10 ? 600 : 30);
    if (speedLockBadge) speedLockBadge.textContent = `${connectedCount} Acc = ${cap} msgs/min`;
    if (statSpeedCap) statSpeedCap.textContent = `${cap} Msgs / Min`;
}

window.requestFreshQrSlot = function(accId) {
    if (!socket || isRefreshingQr) return;
    isRefreshingQr = true;

    appendTerminalLog({
        type: 'info',
        timestamp: new Date().toLocaleTimeString(),
        text: `🔄 Requesting instant fresh QR Code for ${accId}...`
    });

    socket.emit('request_qr', { accId });
    setTimeout(() => { isRefreshingQr = false; }, 2000);
};

window.logoutAccount = function(accId) {
    if (!socket) return;
    if (confirm(`Logout WhatsApp account slot (${accId})?`)) {
        socket.emit('logout_account', { accId });
    }
};

window.triggerExcelFilePicker = function() {
    if (excelFileInput) {
        excelFileInput.click();
    }
};

if (btnAddAccount) {
    btnAddAccount.addEventListener('click', () => {
        if (!socket) return;
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
        if (!socket) return;
        if (confirm('Are you sure you want to LOGOUT ALL connected WhatsApp accounts?')) {
            socket.emit('logout_all_accounts');
        }
    });
}

if (selectRoutingMode) {
    selectRoutingMode.addEventListener('change', (e) => {
        const mode = e.target.value;
        if (specificAccContainer) specificAccContainer.classList.add('hidden');
        if (customRatioContainer) customRatioContainer.classList.add('hidden');

        if (mode === 'SPECIFIC_ACCOUNT' && specificAccContainer) specificAccContainer.classList.remove('hidden');
        else if (mode === 'CUSTOM_RATIO' && customRatioContainer) customRatioContainer.classList.remove('hidden');
    });
}

// MEDIA HANDLERS
if (btnPickMedia) btnPickMedia.addEventListener('click', () => mediaFileInput.click());

if (mediaFileInput) {
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
                if (mediaNameTag) {
                    mediaNameTag.textContent = `📎 ${file.name} (${Math.round(file.size / 1024)} KB)`;
                    mediaNameTag.style.color = 'var(--primary)';
                }
                if (btnClearMedia) btnClearMedia.classList.remove('hidden');
            };
            reader.readAsDataURL(file);
        }
    });
}

if (btnClearMedia) {
    btnClearMedia.addEventListener('click', () => {
        currentMediaObj = null;
        if (mediaFileInput) mediaFileInput.value = '';
        if (mediaNameTag) mediaNameTag.textContent = 'No File Attached';
        btnClearMedia.classList.add('hidden');
    });
}

// EXCEL PARSER & SMART MULTI-COLUMN DATA TABLE PREVIEW
if (excelDropzone) {
    excelDropzone.addEventListener('click', (e) => {
        triggerExcelFilePicker();
    });

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
}

if (excelFileInput) excelFileInput.addEventListener('change', handleExcelUpload);

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
            
            let phoneIdx = headers.findIndex(h => 
                h.includes('phone') || h.includes('mobile') || h.includes('number') || 
                h.includes('contact') || h.includes('whatsapp') || h.includes('tel') || h.includes('cell')
            );
            
            let nameIdx = headers.findIndex(h => 
                h.includes('name') || h.includes('customer') || h.includes('user') || h.includes('client')
            );

            if (phoneIdx === -1) {
                for (let c = 0; c < (rows[1] || []).length; c++) {
                    const sampleVal = String(rows[1][c] || '').replace(/\D/g, '');
                    if (sampleVal.length >= 10) {
                        phoneIdx = c;
                        break;
                    }
                }
            }
            if (phoneIdx === -1) phoneIdx = 0;

            const hasValidNameCol = (nameIdx !== -1 && nameIdx !== phoneIdx);

            for (let i = 1; i < rows.length; i++) {
                const row = rows[i];
                if (!row || row.length === 0) continue;

                let rawPhone = row[phoneIdx] !== undefined && row[phoneIdx] !== null ? String(row[phoneIdx]).trim() : '';
                let rawName = hasValidNameCol && row[nameIdx] !== undefined && row[nameIdx] !== null ? String(row[nameIdx]).trim() : `Contact ${i}`;

                let cleanDigits = rawPhone.replace(/\D/g, '');
                if (cleanDigits.length === 10) {
                    cleanDigits = `91${cleanDigits}`;
                }

                if (cleanDigits.length >= 10) {
                    parsedContacts.push({
                        id: i,
                        name: rawName || `Contact ${i}`,
                        phone: cleanDigits,
                        rawPhone: rawPhone,
                        status: 'Pending'
                    });
                }
            }

            if (totalContactsCount) totalContactsCount.textContent = parsedContacts.length;
            if (pendingCountEl) pendingCountEl.textContent = parsedContacts.length;
            if (sentCountEl) sentCountEl.textContent = 0;
            if (failedCountEl) failedCountEl.textContent = 0;

            if (excelFileStatus) {
                excelFileStatus.innerHTML = `
                    <div style="color:var(--success); font-weight:600;">
                        <i class="fa-solid fa-file-csv"></i> Loaded ${parsedContacts.length} valid contacts from ${file.name}
                    </div>
                `;
            }

            renderExcelPreviewTable(file.name);

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

function renderExcelPreviewTable(fileName) {
    if (!excelDropzone) return;

    let tableRowsHtml = '';
    parsedContacts.forEach((c, idx) => {
        tableRowsHtml += `
            <tr id="contact-row-${c.phone}">
                <td>${idx + 1}</td>
                <td><strong>${c.name}</strong></td>
                <td>${c.rawPhone || c.phone}</td>
                <td id="contact-status-${c.phone}">
                    <span class="status-chip pending" style="background:rgba(245,158,11,0.15); color:var(--warning); padding:3px 8px; border-radius:4px; font-weight:600; font-size:10px;">
                        ⏳ Pending
                    </span>
                </td>
            </tr>
        `;
    });

    excelDropzone.innerHTML = `
        <div style="text-align:left; width:100%; cursor:default;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; flex-wrap:wrap; gap:8px;">
                <span style="font-size:13px; font-weight:700; color:var(--success);">
                    <i class="fa-solid fa-file-csv"></i> ${fileName} (${parsedContacts.length} Contacts)
                </span>
                <button type="button" class="btn btn-secondary btn-sm" onclick="event.stopPropagation(); triggerExcelFilePicker();">
                    <i class="fa-solid fa-rotate"></i> Change File
                </button>
            </div>
            <div style="max-height:220px; overflow-y:auto; border:1px solid var(--card-border); border-radius:8px;">
                <table class="speed-table-matrix" style="font-size:11px;">
                    <thead>
                        <tr>
                            <th>#</th>
                            <th>Name</th>
                            <th>Phone Number (As Written)</th>
                            <th>Status</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${tableRowsHtml}
                    </tbody>
                </table>
            </div>
        </div>
    `;
}

function updateContactTableStatus(cleanPhone, statusStr) {
    const el = document.getElementById(`contact-status-${cleanPhone}`);
    if (el) {
        if (statusStr === 'Sent') {
            el.innerHTML = `<span style="background:rgba(16,185,129,0.15); color:var(--success); padding:3px 8px; border-radius:4px; font-weight:600; font-size:10px;">✅ Sent</span>`;
        } else if (statusStr === 'Failed') {
            el.innerHTML = `<span style="background:rgba(239,68,68,0.15); color:var(--danger); padding:3px 8px; border-radius:4px; font-weight:600; font-size:10px;">❌ Failed</span>`;
        }
    }
}

// CAMPAIGN CONTROLLER (START / STOP FUNCTIONALITY)
if (btnStartCampaign) {
    btnStartCampaign.addEventListener('click', () => {
        if (!socket) return;

        // IF CAMPAIGN IS RUNNING: CLICKING BUTTON STOPS THE CAMPAIGN
        if (isCampaignRunning) {
            isCampaignRunning = false;
            socket.emit('stop_campaign');
            btnStartCampaign.className = 'btn btn-success btn-lg full-btn';
            btnStartCampaign.innerHTML = '<i class="fa-solid fa-play"></i> Start Campaign';
            appendTerminalLog({
                type: 'warning',
                timestamp: new Date().toLocaleTimeString(),
                text: '⏹️ Campaign stopped by user.'
            });
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
        btnStartCampaign.disabled = false;
        btnStartCampaign.className = 'btn btn-danger-soft btn-lg full-btn';
        btnStartCampaign.innerHTML = '<i class="fa-solid fa-square"></i> Stop Campaign';

        socket.emit('start_campaign', campaignPayload);

        appendTerminalLog({
            type: 'info',
            timestamp: new Date().toLocaleTimeString(),
            text: `🚀 Launching campaign to ${parsedContacts.length} contacts using ${connectedAccs.length} active WhatsApp accounts...`
        });
    });
}

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
        if (terminalLogs) terminalLogs.innerHTML = '<div class="log-entry info"><span class="log-time">[System]</span> Terminal logs cleared.</div>';
    });
}
