/**
 * whatsappEngine.js - Fast Multi-Account & Dual Login Engine (QR Code & 8-Digit Phone Pairing Code)
 */

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

function cleanStaleLockFiles(dir) {
    if (!fs.existsSync(dir)) return;
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                cleanStaleLockFiles(fullPath);
            } else if (entry.name === 'lockfile' || entry.name.endsWith('.lock')) {
                try {
                    fs.unlinkSync(fullPath);
                } catch (e) {}
            }
        }
    } catch (err) {}
}

class WhatsAppEngine {
    constructor() {
        this.maxAccounts = 10;
        this.accounts = new Map(); // Map<accId, { id, client, status, qrCodeDataUrl, pairingCode, userInfo }>
        this.autoReplyRules = [];
        this.onAccountsUpdate = null;
        this.onAutoReplyLog = null;
        this.onPairingCode = null;
    }

    init(callbacks = {}) {
        this.onAccountsUpdate = callbacks.onAccountsUpdate || this.onAccountsUpdate;
        this.onAutoReplyLog = callbacks.onAutoReplyLog || this.onAutoReplyLog;
        this.onPairingCode = callbacks.onPairingCode || this.onPairingCode;

        const authBaseDir = path.join(__dirname, '.wwebjs_auth');
        if (fs.existsSync(authBaseDir)) {
            const dirs = fs.readdirSync(authBaseDir);
            const sessionDirs = dirs.filter(d => d.startsWith('session-acc_'));

            if (sessionDirs.length > 0) {
                sessionDirs.forEach(dirName => {
                    const accId = dirName.replace('session-', '');
                    this.createAccountInstance(accId);
                });
                return;
            }
        }

        // Default Account Slot 1
        this.createAccountInstance('acc_1');
    }

    createAccountInstance(accId) {
        if (this.accounts.has(accId)) return this.accounts.get(accId);
        if (this.accounts.size >= this.maxAccounts) {
            throw new Error(`Maximum limit of ${this.maxAccounts} WhatsApp accounts reached!`);
        }

        const authPath = path.join(__dirname, '.wwebjs_auth');
        cleanStaleLockFiles(authPath);

        const accData = {
            id: accId,
            client: null,
            status: 'INITIALIZING',
            qrCodeDataUrl: null,
            pairingCode: null,
            userInfo: null
        };

        this.accounts.set(accId, accData);
        this.broadcastState();

        let chromePath = null;
        try {
            chromePath = puppeteer.executablePath();
        } catch (e) {}

        const puppeteerConfig = {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu',
                '--disable-features=IsolateOrigins,site-per-process'
            ]
        };

        if (chromePath && fs.existsSync(chromePath)) {
            puppeteerConfig.executablePath = chromePath;
        }

        const client = new Client({
            authStrategy: new LocalAuth({
                clientId: accId,
                dataPath: authPath
            }),
            webVersionCache: {
                type: 'remote',
                remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
            },
            puppeteer: puppeteerConfig
        });

        accData.client = client;

        // QR Code Event (Fast 3-Second QR Generation)
        client.on('qr', async (qr) => {
            try {
                accData.qrCodeDataUrl = await QRCode.toDataURL(qr);
                accData.status = 'QR_READY';
                console.log(`[WhatsApp Engine] 📸 QR Code ready for ${accId}`);
                this.broadcastState();
            } catch (err) {
                console.error(`[WhatsApp Engine] Error generating QR for ${accId}:`, err);
            }
        });

        // Authenticating Event
        client.on('authenticated', () => {
            accData.qrCodeDataUrl = null;
            accData.pairingCode = null;
            accData.status = 'AUTHENTICATING';
            console.log(`[WhatsApp Engine] Session authenticated for ${accId}`);
            this.broadcastState();
        });

        // Ready Event (Connected)
        client.on('ready', async () => {
            try {
                const info = client.info;
                accData.userInfo = {
                    pushname: info.pushname || 'WhatsApp Account',
                    wid: info.wid ? info.wid.user : 'Unknown'
                };
            } catch (e) {
                accData.userInfo = { pushname: 'Connected Account', wid: '' };
            }
            accData.qrCodeDataUrl = null;
            accData.pairingCode = null;
            accData.status = 'CONNECTED';
            console.log(`[WhatsApp Engine] ✅ ${accId} READY! Connected as ${accData.userInfo.pushname} (+${accData.userInfo.wid})`);
            this.broadcastState();
        });

        // Incoming Message Listener for Live Auto-Responders
        client.on('message', async (msg) => {
            if (!msg.body || msg.from.endsWith('@g.us')) return;

            const incomingText = msg.body.trim().toLowerCase();

            for (const rule of this.autoReplyRules) {
                if (!rule.keyword) continue;

                const targetKw = rule.keyword.trim().toLowerCase();
                const isMatch = rule.exactMatch 
                    ? incomingText === targetKw 
                    : incomingText.includes(targetKw);

                if (isMatch) {
                    try {
                        if (rule.mediaObj && rule.mediaObj.data) {
                            const media = new MessageMedia(rule.mediaObj.mimetype, rule.mediaObj.data, rule.mediaObj.filename);
                            await client.sendMessage(msg.from, media, { caption: rule.replyText || '' });
                        } else {
                            await client.sendMessage(msg.from, rule.replyText || '');
                        }

                        if (this.onAutoReplyLog) {
                            this.onAutoReplyLog({
                                accId,
                                from: msg.from.replace('@c.us', ''),
                                keyword: rule.keyword,
                                replyText: rule.replyText
                            });
                        }
                    } catch (err) {
                        console.error(`[Auto-Responder] Error sending reply to ${msg.from}:`, err.message);
                    }
                    break;
                }
            }
        });

        // Event: Disconnected
        client.on('disconnected', (reason) => {
            console.log(`[WhatsApp Engine] ${accId} disconnected:`, reason);
            accData.status = 'DISCONNECTED';
            accData.userInfo = null;
            accData.qrCodeDataUrl = null;
            accData.pairingCode = null;
            this.broadcastState();
        });

        // Event: Auth Failure
        client.on('auth_failure', (msg) => {
            console.error(`[WhatsApp Engine] Auth failure on ${accId}:`, msg);
            accData.status = 'DISCONNECTED';
            this.broadcastState();
        });

        client.initialize().catch(err => {
            console.error(`[WhatsApp Engine] Initialize error on ${accId}:`, err.message);
            accData.status = 'DISCONNECTED';
            this.broadcastState();
        });

        return accData;
    }

    /**
     * Request 8-Digit Phone Pairing Code (Link with Phone Number)
     */
    async requestPairingCode(accId, phoneNumber) {
        const accData = this.accounts.get(accId);
        if (!accData || !accData.client) {
            throw new Error(`Account slot ${accId} is not initialized!`);
        }

        let cleanPhone = String(phoneNumber).replace(/\D/g, '');
        if (!cleanPhone || cleanPhone.length < 10) {
            throw new Error('Please enter a valid 10 to 12 digit phone number (e.g. 917340216019)');
        }

        // Wait for Puppeteer page to be fully loaded if initializing
        let attempts = 0;
        while ((!accData.client.pupPage || accData.status === 'INITIALIZING') && attempts < 15) {
            await new Promise(r => setTimeout(r, 1000));
            attempts++;
        }

        if (!accData.client.pupPage) {
            throw new Error('WhatsApp Engine is starting up... Please wait 3 seconds and click Get Code again.');
        }

        console.log(`[WhatsApp Engine] Requesting 8-digit pairing code for ${accId} with phone: ${cleanPhone}...`);
        try {
            const code = await accData.client.requestPairingCode(cleanPhone);
            accData.pairingCode = code;
            accData.status = 'PAIRING_CODE_READY';
            console.log(`[WhatsApp Engine] 🔑 Pairing Code for ${accId}: ${code}`);
            this.broadcastState();
            return code;
        } catch (err) {
            console.error(`[WhatsApp Engine] Error requesting pairing code for ${accId}:`, err.message);
            throw new Error(`Failed to request pairing code: ${err.message}`);
        }
    }

    addAccountSlot() {
        if (this.accounts.size >= this.maxAccounts) {
            throw new Error(`Maximum limit of ${this.maxAccounts} WhatsApp accounts reached!`);
        }

        for (const [accId, accData] of this.accounts) {
            if (accData.status !== 'CONNECTED') {
                throw new Error(`Please scan or pair the current WhatsApp QR / Code before adding a new account!`);
            }
        }

        let slotNum = 1;
        while (this.accounts.has(`acc_${slotNum}`)) {
            slotNum++;
        }

        const newAccId = `acc_${slotNum}`;
        return this.createAccountInstance(newAccId);
    }

    setAutoReplyRules(rules) {
        this.autoReplyRules = rules || [];
    }

    async sendMessageFrom(accId, recipientJid, messageText, mediaObj = null) {
        const accData = this.accounts.get(accId);
        if (!accData || accData.status !== 'CONNECTED' || !accData.client) {
            throw new Error(`Account ${accId} is not connected!`);
        }

        if (mediaObj && mediaObj.data && mediaObj.mimetype) {
            const media = new MessageMedia(mediaObj.mimetype, mediaObj.data, mediaObj.filename || 'attachment');
            return await accData.client.sendMessage(recipientJid, media, { caption: messageText || '' });
        } else {
            return await accData.client.sendMessage(recipientJid, messageText);
        }
    }

    async logoutAccount(accId) {
        const accData = this.accounts.get(accId);
        if (!accData) return;

        console.log(`[WhatsApp Engine] Logging out ${accId}...`);
        if (accData.client) {
            try {
                await accData.client.logout().catch(() => {});
                await accData.client.destroy().catch(() => {});
            } catch (e) {}
        }

        const sessionPath = path.join(__dirname, '.wwebjs_auth', `session-${accId}`);
        try {
            if (fs.existsSync(sessionPath)) {
                fs.rmSync(sessionPath, { recursive: true, force: true });
            }
        } catch (e) {}

        this.accounts.delete(accId);
        
        if (this.accounts.size === 0) {
            this.createAccountInstance('acc_1');
        } else {
            this.broadcastState();
        }
    }

    async logoutAllAccounts() {
        console.log('[WhatsApp Engine] Logging out ALL connected WhatsApp accounts...');
        const accIds = Array.from(this.accounts.keys());
        
        for (const accId of accIds) {
            const accData = this.accounts.get(accId);
            if (accData && accData.client) {
                try {
                    await accData.client.logout().catch(() => {});
                    await accData.client.destroy().catch(() => {});
                } catch (e) {}
            }
            const sessionPath = path.join(__dirname, '.wwebjs_auth', `session-${accId}`);
            try {
                if (fs.existsSync(sessionPath)) {
                    fs.rmSync(sessionPath, { recursive: true, force: true });
                }
            } catch (e) {}
        }

        this.accounts.clear();
        this.createAccountInstance('acc_1');
    }

    broadcastState() {
        if (this.onAccountsUpdate) {
            this.onAccountsUpdate(this.getAllAccountsState());
        }
    }

    getAllAccountsState() {
        const result = [];
        for (const [accId, accData] of this.accounts) {
            result.push({
                id: accId,
                status: accData.status,
                qrCode: accData.qrCodeDataUrl,
                pairingCode: accData.pairingCode,
                userInfo: accData.userInfo
            });
        }
        return result;
    }

    getConnectedAccountIds() {
        const connected = [];
        for (const [accId, accData] of this.accounts) {
            if (accData.status === 'CONNECTED') {
                connected.push(accId);
            }
        }
        return connected;
    }
}

module.exports = WhatsAppEngine;
