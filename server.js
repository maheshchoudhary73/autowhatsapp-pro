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
function getUserQuotaRecord(uid, email = '') {
    const data = loadUserQuotas();
    const todayStr = new Date().toISOString().split('T')[0];

    if (!data.users[uid]) {
        data.users[uid] = {
            uid,
            email,
            plan: 'FREE', // 'FREE' | 'PRO'
            dailyMaxQuota: 50,
            dailySentToday: 0,
            lastResetDate: todayStr
        };
        saveUserQuotas(data);
    } else {
        // Reset daily counter at midnight
        if (data.users[uid].lastResetDate !== todayStr) {
            data.users[uid].dailySentToday = 0;
            data.users[uid].lastResetDate = todayStr;
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
        data.users[uid].plan = planTier; // 'PRO' or 'FREE'
        saveUserQuotas(data);
    }
}

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
