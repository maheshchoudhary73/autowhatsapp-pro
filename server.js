/**
 * AutoWhatsApp Pro - Server Backend Entry Point
 * Baileys pure QR Engine + Express + Socket.io
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
    }
});

const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Serve static web app from public directory & root directory
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

// Initialize WhatsApp Baileys Engine & Queue Manager
const waEngine = new WhatsAppEngine();
const queueMgr = new QueueManager();

// Broadcast Accounts Update to Socket.io Clients
waEngine.setOnAccountsUpdate((accounts) => {
    io.emit('accounts_update', accounts);
});

// Broadcast Auto-Reply Logs to Socket.io Clients
waEngine.setOnAutoReplyLog((logData) => {
    io.emit('auto_reply_log', logData);
});

// Socket.io Connection Logic
io.on('connection', (socket) => {
    console.log(`[Socket.io] Client connected: ${socket.id}`);

    // Send current accounts state on connect
    socket.emit('accounts_update', waEngine.getAccountsState());

    // Event: Request Fresh QR Code for Specific Account Slot
    socket.on('request_qr', async ({ accId }) => {
        try {
            const targetAccId = accId || 'acc_1';
            const qrCode = await waEngine.requestFreshQR(targetAccId);
            socket.emit('qr_code_response', { success: true, accId: targetAccId, qrCode });
        } catch (err) {
            console.error('[Server] request_qr error:', err.message);
            socket.emit('error_alert', { message: err.message });
        }
    });

    // Event: Add New WhatsApp Account Slot
    socket.on('add_account', async () => {
        try {
            const newAcc = await waEngine.addNewAccount();
            socket.emit('accounts_update', waEngine.getAccountsState());
        } catch (err) {
            console.error('[Server] add_account error:', err.message);
            socket.emit('error_alert', { message: err.message });
        }
    });

    // Event: Request 8-Digit Phone Pairing Code
    socket.on('request_pairing_code', async ({ accId, phoneNumber }) => {
        try {
            const code = await waEngine.requestPairingCode(accId, phoneNumber);
            socket.emit('pairing_code_response', { success: true, accId, code });
        } catch (err) {
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

    // Event: Start Campaign with Media & Auto-Reply Rules
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
                return await waEngine.sendMessageFrom(accId, phoneJid, messageText, mediaItem);
            },
            {
                onProgress: (progressData) => {
                    io.emit('campaign_progress', progressData);
                },
                onLog: (logEntry) => {
                    io.emit('campaign_log', logEntry);
                },
                onFinish: (summary) => {
                    io.emit('campaign_finished', summary);
                }
            }
        );
    });

    socket.on('pause_campaign', () => queueMgr.pause());
    socket.on('resume_campaign', () => queueMgr.resume());
    socket.on('stop_campaign', () => queueMgr.stop());

    socket.on('disconnect', () => {
        console.log(`[Socket.io] Client disconnected: ${socket.id}`);
    });
});

// REST API Health Check Endpoint
app.get('/api/health', (req, res) => {
    res.json({
        status: 'online',
        uptime: process.uptime(),
        connectedAccounts: waEngine.getConnectedAccountIds()
    });
});

// Serve index.html for all other routes
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Initialize Engine and Start HTTP Server
waEngine.initAllAccounts().then(() => {
    server.listen(PORT, () => {
        console.log(`====================================================`);
        console.log(`🚀 AutoWhatsApp Pro Cloud Server running on port ${PORT}`);
        console.log(`====================================================`);
    });
}).catch(err => {
    console.error('Failed to initialize Baileys engine:', err);
});
