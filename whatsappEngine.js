/**
 * whatsappEngine.js - Production Grade WhatsApp Engine for AWS Linux & Windows
 */

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');

function forceCleanDirectory(dir) {
    if (!fs.existsSync(dir)) return;
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                forceCleanDirectory(fullPath);
            } else if (entry.name === 'lockfile' || entry.name.endsWith('.lock') || entry.name.endsWith('.db-journal')) {
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
        this.accounts = new Map(); // accId -> { id, client, status, qrCodeDataUrl, pairingCode, userInfo }
        this.autoReplyRules = [];
        this.onAccountsUpdate = null;
        this.onAutoReplyLog = null;
    }

    init(callbacks = {}) {
        this.onAccountsUpdate = callbacks.onAccountsUpdate || this.onAccountsUpdate;
        this.onAutoReplyLog = callbacks.onAutoReplyLog || this.onAutoReplyLog;

        const authBaseDir = path.join(__dirname, '.wwebjs_auth');
        forceCleanDirectory(authBaseDir);

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
        forceCleanDirectory(authPath);

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

        const puppeteerArgs = [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu'
        ];

        const puppeteerConfig = {
            headless: true,
            args: puppeteerArgs
        };

        // Check if Linux official google-chrome-stable exists on AWS
        const linuxChromePath = '/usr/bin/google-chrome-stable';
        const linuxChromeAlt = '/usr/bin/google-chrome';
        if (fs.existsSync(linuxChromePath)) {
            puppeteerConfig.executablePath = linuxChromePath;
        } else if (fs.existsSync(linuxChromeAlt)) {
            puppeteerConfig.executablePath = linuxChromeAlt;
        }

        const client = new Client({
            authStrategy: new LocalAuth({
                clientId: accId,
                dataPath: authPath
            }),
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

        // Ready Event (Connected with Duplicate Number Protection)
        client.on('ready', async () => {
            try {
                const info = client.info;
                const currentWid = info.wid ? info.wid.user : '';
                const currentPush = info.pushname || 'WhatsApp Account';

                // Check if this phone number is ALREADY connected on another slot
                if (currentWid) {
                    for (const [existingId, existingAcc] of this.accounts) {
                        if (existingId !== accId && existingAcc.status === 'CONNECTED' && existingAcc.userInfo && existingAcc.userInfo.wid === currentWid) {
                            console.log(`[WhatsApp Engine] ⚠️ Account +${currentWid} is Already Registered on ${existingId}! Disconnecting duplicate slot ${accId}...`);
                            this.logoutAccount(accId);
                            if (this.onAccountsUpdate) {
                                this.broadcastState();
                            }
                            return;
                        }
                    }
                }

                accData.userInfo = {
                    pushname: currentPush,
                    wid: currentWid
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
     * Request 8-Digit Phone Pairing Code (with Duplicate Phone Number Protection)
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

        // Check if phone number is ALREADY connected on another slot
        const raw10 = cleanPhone.length > 10 ? cleanPhone.slice(-10) : cleanPhone;
        for (const [existingId, existingAcc] of this.accounts) {
            if (existingAcc.status === 'CONNECTED' && existingAcc.userInfo && existingAcc.userInfo.wid) {
                const existingWid = String(existingAcc.userInfo.wid).replace(/\D/g, '');
                if (existingWid.endsWith(raw10)) {
                    throw new Error(`Account Already Registered! (+${existingWid})`);
                }
            }
        }

        // Wait up to 20 seconds for WhatsApp Web page to be ready
        let attempts = 0;
        while (attempts < 20) {
            if (accData.client.pupPage) {
                const isReady = await accData.client.pupPage.evaluate(() => {
                    return typeof window !== 'undefined' && window.Store && window.Store.PairingCode;
                }).catch(() => false);
                if (isReady) break;
            }
            await new Promise(r => setTimeout(r, 1000));
            attempts++;
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

        // RULE: Do not allow adding a new account slot until the current slot is 100% connected
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
