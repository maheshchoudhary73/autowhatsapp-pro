/**
 * AutoWhatsApp Pro - SaaS Multi-Tenant Backend Server Entry Point
 * Multi-User Session Isolation, Firebase User Scoping & Daily 50 SMS Free Trial Engine
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const WhatsAppEngine = require('./whatsappEngine');
const QueueManager = require('./QueueManager');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    maxHttpBufferSize: 1e8
});

const PORT = process.env.PORT || 3000;
const QUOTAS_FILE = path.join(__dirname, 'user_quotas.json');

// Helper to load user quotas database
function loadUserQuotas() {
    try {
        if (fs.existsSync(QUOTAS_FILE)) {
            const content = fs.readFileSync(QUOTAS_FILE, 'utf8');
            return JSON.parse(content);
        }
    } catch (e) {}
    return { users: {} };
}

// Helper to save user quotas database
function saveUserQuotas(data) {
    try {
        fs.writeFileSync(QUOTAS_FILE, JSON.stringify(data, null, 2));
    } catch (e) {}
}

// Helper to get or initialize user quota record
function getUserQuotaRecord(uid, email) {
    const data = loadUserQuotas();
    const todayStr = new Date().toISOString().split('T')[0];
    const nowMs = Date.now();
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

    if (!data.users[uid]) {
        data.users[uid] = {
            uid,
            email,
            plan: 'FREE', // 'FREE' | 'PRO' | 'Starter' | 'Basic' | 'Business' | 'FREE_EXPIRED'
            createdAt: nowMs,
            dailyMaxQuota: 50,
            dailySentToday: 0,
            lastResetDate: todayStr
        };
        saveUserQuotas(data);
    } else {
        if (!data.users[uid].createdAt) {
            data.users[uid].createdAt = nowMs;
            saveUserQuotas(data);
        }

        // Reset daily counter at midnight
        if (data.users[uid].lastResetDate !== todayStr) {
            data.users[uid].dailySentToday = 0;
            data.users[uid].lastResetDate = todayStr;
            saveUserQuotas(data);
        }

        // Check 7-Day Free Trial Expiry for FREE users
        const isFree = !data.users[uid].plan || data.users[uid].plan === 'FREE';
        if (isFree && (nowMs - data.users[uid].createdAt) > SEVEN_DAYS_MS) {
            data.users[uid].plan = 'FREE_EXPIRED';
            data.users[uid].dailyMaxQuota = 0;
            saveUserQuotas(data);
        }
    }

    return data.users[uid];
}


// Increment user sent count
function incrementUserSentCount(uid, count = 1) {
    const data = loadUserQuotas();
    if (data.users[uid]) {
        data.users[uid].dailySentToday = (data.users[uid].dailySentToday || 0) + count;
        saveUserQuotas(data);
    }
}

// Admin API to Upgrade User to PRO Plan
function setUserPlan(uid, planTier) {
    const data = loadUserQuotas();
    if (data.users[uid]) {
        data.users[uid].plan = planTier; // 'PRO', 'Starter', 'Basic', 'Business' or 'FREE'
        saveUserQuotas(data);
    }
}

// Pending Payments Storage
const PAYMENTS_FILE = path.join(__dirname, 'pending_payments.json');
function loadPendingPayments() {
    try {
        if (fs.existsSync(PAYMENTS_FILE)) {
            return JSON.parse(fs.readFileSync(PAYMENTS_FILE, 'utf8'));
        }
    } catch (e) {}
    return { payments: [] };
}
function savePendingPayments(data) {
    try {
        fs.writeFileSync(PAYMENTS_FILE, JSON.stringify(data, null, 2));
    } catch (e) {}
}

// HTML Admin Web Dashboard UI
app.get('/admin', (req, res) => {
    const secret = req.query.secret;
    if (secret !== 'admin123') return res.status(403).send('<h1>🔒 403 Forbidden: Invalid Secret Key</h1><p>Usage: /admin?secret=admin123</p>');
    
    const payData = loadPendingPayments();
    const payments = payData.payments || [];
    
    let rowsHtml = payments.map((p, idx) => `
        <tr style="border-bottom:1px solid #334155;">
            <td style="padding:12px;">${idx + 1}</td>
            <td style="padding:12px; font-weight:bold;">${p.email || p.uid}</td>
            <td style="padding:12px; color:#00f2fe;">${p.plan} (${p.duration || '1M'})</td>
            <td style="padding:12px; color:#10b981; font-weight:bold;">${p.price}</td>
            <td style="padding:12px; font-family:monospace; background:rgba(255,255,255,0.05);">${p.utrNumber}</td>
            <td style="padding:12px; font-size:12px; color:#94a3b8;">${new Date(p.timestamp).toLocaleString()}</td>
            <td style="padding:12px;">
                ${p.status === 'APPROVED' 
                    ? '<span style="color:#10b981; font-weight:bold;">✅ APPROVED</span>' 
                    : `<a href="/api/admin/approve-utr?utr=${p.utrNumber}&secret=admin123" style="background:#25d366; color:#000; padding:6px 14px; border-radius:6px; font-weight:bold; text-decoration:none; display:inline-block;">✅ Approve Plan</a>`}
            </td>
        </tr>
    `).join('');

    if (payments.length === 0) {
        rowsHtml = `<tr><td colspan="7" style="padding:30px; text-align:center; color:#94a3b8;">No UTR payment submissions found yet.</td></tr>`;
    }

    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>AutoWhatsApp Pro - Admin Payment Control Center</title>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
                body { background:#090d16; color:#f8fafc; font-family:sans-serif; padding:30px; }
                .card { background:#151c2c; border:1px solid rgba(255,255,255,0.1); border-radius:14px; padding:24px; max-width:1100px; margin:0 auto; }
                table { width:100%; border-collapse:collapse; text-align:left; margin-top:20px; }
                th { padding:12px; border-bottom:2px solid #334155; color:#00f2fe; }
            </style>
        </head>
        <body>
            <div class="card">
                <h2>👑 AutoWhatsApp Pro - Admin UTR Payment Verification Center</h2>
                <p style="color:#94a3b8; font-size:14px;">Review 12-digit UTR numbers submitted by users and click "Approve Plan" to instantly activate their PRO SaaS account.</p>
                <table>
                    <thead>
                        <tr>
                            <th>#</th>
                            <th>User Email</th>
                            <th>Selected Plan</th>
                            <th>Amount</th>
                            <th>12-Digit UTR No.</th>
                            <th>Date & Time</th>
                            <th>Action</th>
                        </tr>
                    </thead>
                    <tbody>${rowsHtml}</tbody>
                </table>
            </div>
        </body>
        </html>
    `);
});



// User-Isolated WhatsApp Engines Store: userId -> WhatsAppEngine instance
const userEngines = new Map();
const userQueueManagers = new Map();

function getUserEngine(uid) {
    if (!userEngines.has(uid)) {
        const engine = new WhatsAppEngine(uid);
        engine.init();
        userEngines.set(uid, engine);
    }
    return userEngines.get(uid);
}

function getUserQueueManager(uid) {
    if (!userQueueManagers.has(uid)) {
        userQueueManagers.set(uid, new QueueManager());
    }
    return userQueueManagers.get(uid);
}

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Serve static web app from public directory & root directory
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

// Socket.io Multi-Tenant Authenticated Connection Logic
io.on('connection', (socket) => {
    const authData = socket.handshake.auth || {};
    const uid = authData.uid || 'public_anonymous';
    const email = authData.email || '';

    console.log(`[SaaS Socket] User connected: ${uid} (${email}) | Socket: ${socket.id}`);

    const waEngine = getUserEngine(uid);
    const queueMgr = getUserQueueManager(uid);

    // Send User Quota Info & Account State on Connect
    const userQuota = getUserQuotaRecord(uid, email);
    socket.emit('user_quota_info', userQuota);

    // Socket Listener for UTR Payment Submissions
    socket.on('submit_utr_payment', (utrPayload) => {
        console.log(`[Payment UTR Submitted] User: ${utrPayload.email} | Plan: ${utrPayload.plan} | UTR: ${utrPayload.utrNumber}`);
        const payData = loadPendingPayments();
        payData.payments.push({
            uid: utrPayload.uid || uid,
            email: utrPayload.email || email,
            plan: utrPayload.plan,
            duration: utrPayload.duration,
            price: utrPayload.price,
            utrNumber: utrPayload.utrNumber,
            status: 'PENDING',
            submittedAt: new Date().toISOString()
        });
        savePendingPayments(payData);

        // Send Instant WhatsApp Notification Alert to Admin
        try {
            const adminMsg = `🚨 *NEW PAYMENT UTR RECEIVED* 🚨\n\n👤 *User Email:* ${utrPayload.email}\n📦 *Plan:* ${utrPayload.plan} (${utrPayload.duration})\n💰 *Amount:* ${utrPayload.price}\n🔢 *UTR Number:* ${utrPayload.utrNumber}\n\n👉 *Click to Approve Plan:* http://16.16.160.123:3000/api/admin/approve-utr?utr=${utrPayload.utrNumber}&secret=admin123`;
            
            // Try sending via active engine accounts
            const activeAccs = waEngine.getActiveAccounts();
            if (activeAccs.length > 0) {
                const accId = activeAccs[0].id;
                waEngine.sendMessage(accId, '917340216019@c.us', adminMsg);
            }
        } catch (e) {
            console.error('Error sending WhatsApp admin alert:', e.message);
        }
    });



    // Broadcast Accounts Update to specific User Socket
    waEngine.setOnAccountsUpdate((accounts) => {
        socket.emit('accounts_update', accounts);
    });

    waEngine.setOnAutoReplyLog((logData) => {
        socket.emit('auto_reply_log', logData);
    });

    socket.emit('accounts_update', waEngine.getAccountsState());

    // Event: Request Fresh QR Code for Specific Account Slot
    socket.on('request_qr', async ({ accId }) => {
        try {
            const targetAccId = accId || 'acc_1';
            const qrCode = await waEngine.requestFreshQR(targetAccId);
            socket.emit('qr_code_response', { success: true, accId: targetAccId, qrCode });
        } catch (err) {
            console.error(`[Server ${uid}] request_qr error:`, err.message);
            socket.emit('error_alert', { message: err.message });
        }
    });

    // Event: Add New WhatsApp Account Slot
    socket.on('add_account', async () => {
        try {
            await waEngine.addNewAccount();
            socket.emit('accounts_update', waEngine.getAccountsState());
        } catch (err) {
            console.error(`[Server ${uid}] add_account error:`, err.message);
            socket.emit('error_alert', { message: err.message });
        }
    });

    // Event: Logout Specific Account
    socket.on('logout_account', async ({ accId }) => {
        try {
            await waEngine.logoutAccount(accId);
        } catch (err) {
            socket.emit('error_alert', { message: err.message });
        }
    });

    // Event: Logout ALL Accounts
    socket.on('logout_all_accounts', async () => {
        try {
            await waEngine.logoutAllAccounts();
        } catch (err) {
            socket.emit('error_alert', { message: err.message });
        }
    });

    // Event: Start Campaign with Free Trial 50 SMS Limit Check
    socket.on('start_campaign', (payload) => {
        const connectedAccounts = waEngine.getConnectedAccountIds();

        if (connectedAccounts.length === 0) {
            socket.emit('error_alert', { message: 'No WhatsApp account is connected! Please scan QR code first.' });
            return;
        }

        const contacts = payload.contacts || [];
        if (!contacts || contacts.length === 0) {
            socket.emit('error_alert', { message: 'No valid contacts found in campaign!' });
            return;
        }

        // DAILY FREE TRIAL QUOTA CHECK
        const currentQuota = getUserQuotaRecord(uid, email);
        if (currentQuota.plan === 'FREE') {
            const remainingQuota = currentQuota.dailyMaxQuota - currentQuota.dailySentToday;
            if (remainingQuota <= 0) {
                socket.emit('error_alert', { 
                    message: `⚠️ Free Trial Limit Reached (${currentQuota.dailySentToday}/50 msgs sent today). Daily limit resets at midnight or upgrade to PRO Plan!` 
                });
                return;
            }
        }

        const template = payload.messageTemplate || payload.template || '';
        const mediaObj = payload.mediaObj || null;
        const autoReplyRules = payload.autoReplyRules || [];

        waEngine.setAutoReplyRules(autoReplyRules);

        const routingConfig = {
            mode: payload.dispatchMode || 'ROUND_ROBIN',
            selectedAccId: payload.specificAccId || null,
            customRatioLimits: payload.customQuotas || {},
            activeAccountIds: connectedAccounts
        };

        const settings = payload.settings || {};

        queueMgr.loadCampaign(contacts, template, settings, routingConfig, mediaObj, autoReplyRules);
        queueMgr.start(
            async (accId, phoneJid, messageText, mediaItem) => {
                const res = await waEngine.sendMessageFrom(accId, phoneJid, messageText, mediaItem);
                
                // Track usage on successful send
                incrementUserSentCount(uid, 1);
                const updatedQuota = getUserQuotaRecord(uid, email);
                socket.emit('user_quota_info', updatedQuota);

                return res;
            },
            {
                onProgress: (progressData) => {
                    socket.emit('campaign_progress', progressData);
                },
                onLog: (logEntry) => {
                    socket.emit('campaign_log', logEntry);
                },
                onFinish: (summary) => {
                    socket.emit('campaign_finished', summary);
                }
            }
        );
    });

    socket.on('pause_campaign', () => queueMgr.pause());
    socket.on('resume_campaign', () => queueMgr.resume());
    socket.on('stop_campaign', () => queueMgr.stop());

    socket.on('disconnect', () => {
        console.log(`[SaaS Socket] User disconnected: ${uid} | Socket: ${socket.id}`);
    });
});

// REST API Health Check & Admin Upgrade Endpoint
app.get('/api/health', (req, res) => {
    res.json({
        status: 'online SaaS Platform Active',
        activeUsersCount: userEngines.size,
        uptime: process.uptime()
    });
});

// Admin Endpoint: Upgrade User to PRO Plan
// Example: http://16.16.160.123:3000/api/admin/upgrade-user?uid=FIREBASE_UID&plan=PRO&secret=admin123
app.get('/api/admin/upgrade-user', (req, res) => {
    const { uid, plan, secret } = req.query;
    if (secret !== 'admin123') {
        return res.status(403).json({ error: 'Unauthorized secret key' });
    }
    if (!uid) {
        return res.status(400).json({ error: 'Missing uid' });
    }
    const targetPlan = plan === 'PRO' ? 'PRO' : 'FREE';
    setUserPlan(uid, targetPlan);
    res.json({ success: true, uid, plan: targetPlan });
});

// Serve index.html for all other routes
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Start HTTP Server
server.listen(PORT, () => {
    console.log(`====================================================`);
    console.log(`🚀 AutoWhatsApp Pro SaaS Server running on port ${PORT}`);
    console.log(`====================================================`);
});
