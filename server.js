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

process.on('uncaughtException', (err) => {
    console.error('[CRITICAL] Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[CRITICAL] Unhandled Rejection:', reason);
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

// Admin Auth Constants
const ADMIN_EMAIL = 'maheshchoudhary7340@gmail.com';
const ADMIN_PASSWORD = '@@Mahesh@7340';
const ADMIN_SECRET = 'admin123';

// Admin Route to Approve UTR & Upgrade User
app.get('/api/admin/approve-utr', (req, res) => {
    const { utr, secret } = req.query;
    if (secret !== ADMIN_SECRET && req.query.pass !== ADMIN_PASSWORD) {
        return res.status(403).send('<h1>🔒 Unauthorized Admin Action</h1>');
    }
    
    const payData = loadPendingPayments();
    const payment = payData.payments.find(p => p.utrNumber === utr);
    if (!payment) return res.status(404).send('<h1>❌ UTR Payment Submission Not Found</h1>');

    payment.status = 'APPROVED';
    savePendingPayments(payData);

    // Upgrade User Quota Database
    const data = loadUserQuotas();
    if (data.users[payment.uid]) {
        data.users[payment.uid].plan = payment.plan || 'PRO';
        saveUserQuotas(data);

        // Real-time socket update to user browser
        const userRoom = `user_${payment.uid}`;
        io.to(userRoom).emit('user_quota_info', data.users[payment.uid]);
    }

    // Redirect cleanly back to Admin Control Center with success message!
    res.redirect(`/admin?secret=${ADMIN_SECRET}&approved=true&user=${encodeURIComponent(payment.email || payment.uid)}&plan=${encodeURIComponent(payment.plan)}`);
});

// Admin Route to Revoke / Expire User Plan
app.get('/api/admin/revoke-utr', (req, res) => {
    const { utr, secret } = req.query;
    if (secret !== ADMIN_SECRET && req.query.pass !== ADMIN_PASSWORD) {
        return res.status(403).send('<h1>🔒 Unauthorized Admin Action</h1>');
    }
    
    const payData = loadPendingPayments();
    const payment = payData.payments.find(p => p.utrNumber === utr);
    if (!payment) return res.status(404).send('<h1>❌ UTR Payment Record Not Found</h1>');

    payment.status = 'EXPIRED';
    savePendingPayments(payData);

    // Revert User Quota Database to Expired Free Trial
    const data = loadUserQuotas();
    if (data.users && data.users[payment.uid]) {
        data.users[payment.uid].plan = 'FREE_EXPIRED';
        data.users[payment.uid].dailyMaxQuota = 0;
        saveUserQuotas(data);

        // Real-time socket update to user browser
        const userRoom = `user_${payment.uid}`;
        io.to(userRoom).emit('user_quota_info', data.users[payment.uid]);
    }

    res.redirect(`/admin?secret=${ADMIN_SECRET}&revoked=true&user=${encodeURIComponent(payment.email || payment.uid)}`);
});

// Protected HTML Admin Web Dashboard UI
app.get('/admin', (req, res) => {
    const secret = req.query.secret;
    const email = req.query.email ? req.query.email.trim() : '';
    const pass = req.query.pass ? req.query.pass.trim() : '';
    const isApprovedAlert = req.query.approved === 'true';
    const isRevokedAlert = req.query.revoked === 'true';
    const approvedUser = req.query.user || '';
    const approvedPlan = req.query.plan || '';

    // Strict Admin Auth Check (Email + Password OR Secret Key)
    const isAuthenticated = (secret === ADMIN_SECRET) || (email === ADMIN_EMAIL && pass === ADMIN_PASSWORD);

    if (!isAuthenticated) {
        return res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Admin Login - AutoWhatsApp Pro</title>
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <style>
                    body { background: #0b1120; color: #f8fafc; font-family: sans-serif; display:flex; align-items:center; justify-content:center; height:100vh; margin:0; }
                    .card { background: #1e293b; padding: 32px; border-radius: 16px; border:1px solid #334155; width:340px; text-align:center; box-shadow:0 10px 30px rgba(0,0,0,0.5); }
                    input { width:100%; padding:10px; margin-top:8px; border-radius:8px; border:1px solid #475569; background:#0f172a; color:#fff; box-sizing:border-box; }
                    button { width:100%; padding:12px; margin-top:16px; border-radius:8px; border:none; background:#25d366; color:#000; font-weight:800; cursor:pointer; }
                    .input-group { text-align:left; margin-bottom:12px; font-size:12px; color:#94a3b8; }
                </style>
            </head>
            <body>
                <div class="card">
                    <h2 style="margin-top:0; color:#25d366;">🔑 Admin Security Login</h2>
                    
                    <form action="/admin" method="GET">
                        <div class="input-group">
                            <label>Admin Email Address</label>
                            <input type="email" name="email" placeholder="admin@example.com" required autofocus>
                        </div>
                        <div class="input-group">
                            <label>Admin Security Password</label>
                            <input type="password" name="pass" placeholder="••••••••" required>
                        </div>
                        <button type="submit">Unlock Admin Control Center</button>
                    </form>
                </div>
            </body>
            </html>
        `);
    }

    
    const payData = loadPendingPayments();
    const payments = payData.payments || [];
    
    let rowsHtml = payments.map((p, idx) => `
        <tr style="border-bottom:1px solid #334155;">
            <td style="padding:14px;">${idx + 1}</td>
            <td style="padding:14px; font-weight:700; color:#f8fafc;">${p.email || p.uid}</td>
            <td style="padding:14px; font-weight:700; color:#38bdf8;">${p.phone || 'N/A'}</td>
            <td style="padding:14px; color:#00f2fe; font-weight:700;">${p.plan} (${p.duration || '1M'})</td>
            <td style="padding:14px; color:#10b981; font-weight:800;">${p.price}</td>
            <td style="padding:14px; font-family:monospace; font-size:14px; background:rgba(255,255,255,0.05); letter-spacing:1px;">${p.utrNumber}</td>
            <td style="padding:14px; font-size:12px; color:#94a3b8;">${new Date(p.timestamp).toLocaleString()}</td>
            <td style="padding:14px;">
                ${p.status === 'APPROVED' 
                    ? `<span style="color:#10b981; font-weight:800; background:rgba(16,185,129,0.15); padding:6px 12px; border-radius:20px; font-size:12px; margin-right:8px; display:inline-block;">✅ APPROVED</span>
                       <a href="/api/admin/revoke-utr?utr=${p.utrNumber}&secret=${ADMIN_SECRET}" onclick="return confirm('Expire/Revoke Plan for ${p.email}?')" style="background:linear-gradient(135deg, #ef4444, #dc2626); color:#fff; padding:6px 12px; border-radius:8px; font-weight:700; font-size:11px; text-decoration:none; display:inline-block; box-shadow:0 4px 12px rgba(239,68,68,0.3);">🚫 Revoke / Expire Plan</a>` 
                    : p.status === 'EXPIRED'
                    ? '<span style="color:#ef4444; font-weight:800; background:rgba(239,68,68,0.15); padding:6px 12px; border-radius:20px; font-size:12px;">🚫 EXPIRED</span>'
                    : `<a href="/api/admin/approve-utr?utr=${p.utrNumber}&secret=${ADMIN_SECRET}" style="background:linear-gradient(135deg, #25d366, #10b981); color:#000; padding:8px 16px; border-radius:8px; font-weight:800; text-decoration:none; display:inline-block; box-shadow:0 4px 12px rgba(37,211,102,0.3);">✅ Approve Plan</a>`}
            </td>
        </tr>
    `).join('');

    if (payments.length === 0) {
        rowsHtml = `<tr><td colspan="8" style="padding:40px; text-align:center; color:#94a3b8;">No UTR payment submissions found yet.</td></tr>`;
    }

    const alertBannerHtml = isApprovedAlert ? `
        <div style="background:rgba(37,211,102,0.15); border:1px solid #25d366; color:#25d366; padding:14px 20px; border-radius:12px; margin-bottom:20px; font-weight:700; font-size:14px; display:flex; align-items:center; justify-content:space-between;">
            <span>🎉 SUCCESS! Plan "${approvedPlan}" has been Approved & Activated for ${approvedUser}!</span>
            <a href="/admin?secret=${ADMIN_SECRET}" style="color:#fff; text-decoration:none; font-size:12px;">Dismiss ✖</a>
        </div>
    ` : isRevokedAlert ? `
        <div style="background:rgba(239,68,68,0.15); border:1px solid #ef4444; color:#ef4444; padding:14px 20px; border-radius:12px; margin-bottom:20px; font-weight:700; font-size:14px; display:flex; align-items:center; justify-content:space-between;">
            <span>🚫 NOTICE: User Plan has been Expired / Revoked for ${approvedUser}!</span>
            <a href="/admin?secret=${ADMIN_SECRET}" style="color:#fff; text-decoration:none; font-size:12px;">Dismiss ✖</a>
        </div>
    ` : '';

    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>AutoWhatsApp Pro - Admin Payment Control Center</title>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap" rel="stylesheet">
            <style>
                body { background:#090d16; color:#f8fafc; font-family:'Plus Jakarta Sans', sans-serif; padding:30px 20px; margin:0; }
                .card { background:rgba(21, 28, 44, 0.95); border:1px solid rgba(0, 242, 254, 0.3); border-radius:18px; padding:28px; max-width:1150px; margin:0 auto; box-shadow:0 10px 40px rgba(0,0,0,0.5); }
                .flex-between { display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; }
                table { width:100%; border-collapse:collapse; text-align:left; margin-top:10px; }
                th { padding:14px; border-bottom:2px solid #334155; color:#00f2fe; font-size:13px; text-transform:uppercase; letter-spacing:0.5px; }
            </style>
        </head>
        <body>
            <div class="card">
                ${alertBannerHtml}
                <div class="flex-between">
                    <div>
                        <h2 style="margin:0; font-size:22px; font-weight:800; color:#f8fafc;">👑 Admin UTR Payment Control Center</h2>
                        <p style="color:#94a3b8; font-size:13px; margin-top:4px;">Authorized Email: <strong>${ADMIN_EMAIL}</strong></p>
                    </div>
                    <a href="/admin" style="background:rgba(239,68,68,0.2); color:#ef4444; border:1px solid rgba(239,68,68,0.4); padding:8px 16px; border-radius:8px; text-decoration:none; font-size:12px; font-weight:700;">🔒 Logout Admin</a>
                </div>
                
                <div style="overflow-x:auto;">
                    <table>
                        <thead>
                            <tr>
                                <th>#</th>
                                <th>User Email</th>
                                <th>Mobile No.</th>
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
        console.log(`[SaaS Multi-Tenant] Instantiating WhatsApp Engine for User: ${uid}`);
        const engine = new WhatsAppEngine(uid);
        const userRoom = `user_${uid}`;
        engine.setOnAccountsUpdate((accounts) => {
            io.to(userRoom).emit('accounts_update', accounts);
        });
        engine.setOnAutoReplyLog((logData) => {
            io.to(userRoom).emit('auto_reply_log', logData);
        });
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

// Force No Cache Header so Mobile Browsers (Chrome/Safari) Never Store Old HTML/JS
app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    next();
});

// Serve static web app from root directory & public directory
app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname, 'public')));



// Socket.io Multi-Tenant Authenticated Connection Logic
io.on('connection', (socket) => {
    const authData = socket.handshake.auth || {};
    const uid = authData.uid || 'public_anonymous';
    const email = authData.email || '';

    console.log(`[SaaS Socket] User connected: ${uid} (${email}) | Socket: ${socket.id}`);

    const userRoom = `user_${uid}`;
    socket.join(userRoom);

    const waEngine = getUserEngine(uid);
    const queueMgr = getUserQueueManager(uid);

    // Send User Quota Info & Account State on Connect
    const userQuota = getUserQuotaRecord(uid, email);
    socket.emit('user_quota_info', userQuota);
    socket.emit('accounts_update', waEngine.getAccountsState());


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

        // Send Instant WhatsApp Notification Alert to Admin Number (7340216019)
        try {
            const adminMsg = `🚨 *NEW PAYMENT UTR RECEIVED* 🚨\n\n👤 *User Email:* ${utrPayload.email}\n📦 *Plan:* ${utrPayload.plan} (${utrPayload.duration || '1M'})\n💰 *Amount:* ${utrPayload.price}\n🔢 *UTR Number:* ${utrPayload.utrNumber}\n\n⚠️ *Please verify UTR receipt on PhonePe/GPay.*`;
            
            const connectedAccs = waEngine.getConnectedAccountIds();
            if (connectedAccs.length > 0) {
                const accId = connectedAccs[0];
                waEngine.sendMessageFrom(accId, '917340216019@s.whatsapp.net', adminMsg);
            }
        } catch (e) {
            console.error('Error sending WhatsApp admin alert:', e.message);
        }



    });

    // Real-Time Event Listener bound to User Room
    waEngine.setOnAccountsUpdate((accounts) => {
        io.to(userRoom).emit('accounts_update', accounts);
    });
    waEngine.setOnAutoReplyLog((logData) => {
        io.to(userRoom).emit('auto_reply_log', logData);
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

    // Event: Add New WhatsApp Account Slot with Strict SaaS Plan Limits Check
    socket.on('add_account', async () => {
        try {
            const userQuota = getUserQuotaRecord(uid, email);
            const currentAccCount = waEngine.getAccountsState().length;
            if (currentAccCount >= userQuota.maxAccs) {
                socket.emit('plan_limit_exceeded', {
                    type: 'MAX_ACCOUNT_LIMIT',
                    message: `⚠️ Your ${userQuota.plan} Plan permits a maximum of ${userQuota.maxAccs} WhatsApp Account(s)!\n\nPlease Upgrade your plan to add more accounts.`
                });
                return;
            }
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

    // Event: Start Campaign with Daily Limit & Free Expiry Check
    socket.on('start_campaign', (payload) => {
        const userQuota = getUserQuotaRecord(uid, email);
        if (userQuota.plan === 'FREE_EXPIRED') {
            socket.emit('plan_limit_exceeded', {
                type: 'TRIAL_EXPIRED',
                message: '⚠️ Your Free 7-Day Trial has Expired!\n\nPlease Upgrade to a PRO Plan to continue sending campaigns.'
            });
            return;
        }

        const remainingQuota = userQuota.dailyMaxQuota - (userQuota.dailySentToday || 0);
        if (remainingQuota <= 0) {
            socket.emit('plan_limit_exceeded', {
                type: 'DAILY_QUOTA_EXCEEDED',
                message: `⚠️ Daily limit reached (${userQuota.dailySentToday}/${userQuota.dailyMaxQuota} msgs today) for your ${userQuota.plan} Plan!\n\nPlease Upgrade your plan to send more messages today.`
            });
            return;
        }

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
        const settings = payload.settings || {};

        waEngine.setAutoReplyRules(autoReplyRules);

        const routingConfig = {
            mode: payload.dispatchMode || 'ROUND_ROBIN',
            selectedAccId: payload.specificAccId || null,
            customRatioLimits: payload.customQuotas || {},
            activeAccountIds: connectedAccounts
        };

        const templates = payload.templates && payload.templates.length > 0 ? payload.templates : [template];
        queueMgr.loadCampaign(contacts, template, settings, routingConfig, mediaObj, autoReplyRules, templates);


        queueMgr.start(
            async (accId, phoneJid, messageText, mediaItem) => {
                await waEngine.sendMessageFrom(accId, phoneJid, messageText, mediaItem);
                
                // Track usage on successful send
                incrementUserSentCount(uid, 1);
                const updatedQuota = getUserQuotaRecord(uid, email);
                io.to(userRoom).emit('user_quota_info', updatedQuota);

                return { success: true };
            },

            {
                onProgress: (progressData) => {
                    io.to(userRoom).emit('campaign_progress', progressData);
                },
                onLog: (logEntry) => {
                    io.to(userRoom).emit('campaign_log', logEntry);
                },
                onFinish: (summary) => {
                    io.to(userRoom).emit('campaign_finished', summary);
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

// Start HTTP Server (Explicitly bind to 0.0.0.0 for AWS Public IPv4 Access)
server.listen(PORT, '0.0.0.0', () => {
    console.log(`====================================================`);
    console.log(`🚀 AutoWhatsApp Pro SaaS Server running on 0.0.0.0:${PORT}`);
    console.log(`====================================================`);
});

