/**
 * server.js - Multi-Account & Dual Login System
 * Express & Socket.io server supporting up to 10 WhatsApp Accounts, QR Scanning & 8-Digit Phone Pairing Code.
 */

process.on('uncaughtException', (err) => {
    console.error('⚠️ Server Handled Uncaught Exception:', err.message);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('⚠️ Server Handled Unhandled Rejection:', reason && reason.message ? reason.message : reason);
});

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');
const XLSX = require('xlsx');

const WhatsAppEngine = require('./whatsappEngine');
const QueueManager = require('./QueueManager');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Instantiate Core Engines
const waEngine = new WhatsAppEngine();
const queueMgr = new QueueManager();

// Initialize Multi-Account WhatsApp Engine
waEngine.init({
    onAccountsUpdate: (accountsList) => {
        io.emit('accounts_update', accountsList);
    },
    onAutoReplyLog: (logData) => {
        io.emit('campaign_log', {
            type: 'success',
            timestamp: new Date().toLocaleTimeString(),
            text: `🤖 [Auto-Responder] Responded to +${logData.from} for keyword "${logData.keyword}"`
        });
    }
});

// Socket.io Real-time Connection Handler
io.on('connection', (socket) => {
    console.log('⚡ Web Client Connected (Socket ID:', socket.id, ')');

    // Emit initial states
    socket.emit('accounts_update', waEngine.getAllAccountsState());
    socket.emit('queue_update', queueMgr.getSummary());

    // Event: Add New Account Slot
    socket.on('add_account', () => {
        try {
            waEngine.addAccountSlot();
        } catch (err) {
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
    socket.on('start_campaign', ({ contacts, template, settings, routingConfig, mediaObj, autoReplyRules }) => {
        const connectedAccounts = waEngine.getConnectedAccountIds();

        if (connectedAccounts.length === 0) {
            socket.emit('error_alert', { message: 'No WhatsApp account is connected! Please scan QR code or enter Pairing Code first.' });
            return;
        }

        if (!contacts || contacts.length === 0) {
            socket.emit('error_alert', { message: 'No valid contacts found in campaign!' });
            return;
        }

        waEngine.setAutoReplyRules(autoReplyRules || []);

        routingConfig = routingConfig || {};
        routingConfig.activeAccountIds = connectedAccounts;

        queueMgr.loadCampaign(contacts, template, settings, routingConfig, mediaObj, autoReplyRules);
        queueMgr.start(
            async (accId, phoneJid, messageText, mediaItem) => {
                return await waEngine.sendMessageFrom(accId, phoneJid, messageText, mediaItem);
            },
            {
                onProgress: (progressData) => {
                    io.emit('queue_update', progressData);
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
});

// REST API for Excel Parsing Fallback
app.post('/api/parse-excel', (req, res) => {
    try {
        const { fileBase64 } = req.body;
        if (!fileBase64) {
            return res.status(400).json({ success: false, error: 'No file data provided' });
        }

        const buffer = Buffer.from(fileBase64.split(',')[1] || fileBase64, 'base64');
        const workbook = XLSX.read(buffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];

        let rawRows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

        if (rawRows.length === 0) {
            return res.status(400).json({ success: false, error: 'Excel sheet is empty!' });
        }

        let headers = Object.keys(rawRows[0]);
        const isHeaderAPhoneNumber = headers.some(h => String(h).replace(/\D/g, '').length >= 10);
        if (isHeaderAPhoneNumber) {
            const headerRow = {};
            headers.forEach(h => headerRow[h] = h);
            rawRows.unshift(headerRow);
        }

        res.json({
            success: true,
            totalRows: rawRows.length,
            headers,
            sample: rawRows.slice(0, 5),
            rows: rawRows
        });
    } catch (err) {
        console.error('Error parsing excel file:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Start Express HTTP Server
server.listen(PORT, () => {
    console.log(`====================================================`);
    console.log(`🚀 AUTOWHATSAPP PRO ALL-IN-ONE SYSTEM IS READY!`);
    console.log(`🔗 Web Dashboard URL: http://localhost:${PORT}`);
    console.log(`====================================================`);
});
