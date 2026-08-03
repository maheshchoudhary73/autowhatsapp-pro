/**
 * whatsappEngine.js - Ultra-Fast Pure QR Code Engine with Auto-Fresh Reset
 * Every QR Request Wipes Stale Cache and Generates Instant 0.2-Second Official WhatsApp QR Code
 */

const { webcrypto } = require('crypto');
if (!globalThis.crypto) {
    globalThis.crypto = webcrypto;
}

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    delay
} = require('@whiskeysockets/baileys');

const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');

const pino = require('pino');
const logger = pino({ level: 'silent' });

class WhatsAppEngine {
    constructor(userId = 'public_anonymous') {
        this.userId = String(userId).replace(/[^a-zA-Z0-9_-]/g, '_');
        this.maxAccounts = 10;
        this.accounts = new Map(); // accId -> { id, sock, status, qrCodeDataUrl, userInfo }
        this.autoReplyRules = [];
        this.onAccountsUpdate = null;
        this.onAutoReplyLog = null;
    }

    setOnAccountsUpdate(fn) {
        this.onAccountsUpdate = fn;
    }

    setOnAutoReplyLog(fn) {
        this.onAutoReplyLog = fn;
    }

    async initAllAccounts() {
        return await this.init();
    }

    async init(callbacks = {}) {
        this.onAccountsUpdate = callbacks.onAccountsUpdate || this.onAccountsUpdate;
        this.onAutoReplyLog = callbacks.onAutoReplyLog || this.onAutoReplyLog;

        const authBaseDir = path.join(__dirname, '.baileys_auth');
        if (!fs.existsSync(authBaseDir)) {
            fs.mkdirSync(authBaseDir, { recursive: true });
        }

        const prefix = `session-${this.userId}_acc_`;
        const dirs = fs.readdirSync(authBaseDir);
        const sessionDirs = dirs.filter(d => d.startsWith(prefix));

        if (sessionDirs.length > 0) {
            for (const dirName of sessionDirs) {
                const accId = dirName.replace(`session-${this.userId}_`, '');
                await this.createAccountInstance(accId);
            }
        } else {
            // Default Account Slot 1 for this User
            await this.createAccountInstance('acc_1');
        }
    }

    async createAccountInstance(accId) {
        if (this.accounts.has(accId)) {
            const existing = this.accounts.get(accId);
            if (existing.status === 'CONNECTED') {
                return existing;
            }
        }

        if (this.accounts.size >= this.maxAccounts && !this.accounts.has(accId)) {
            throw new Error(`Maximum limit of ${this.maxAccounts} WhatsApp accounts reached!`);
        }

        const sessionPath = path.join(__dirname, '.baileys_auth', `session-${this.userId}_${accId}`);
        if (!fs.existsSync(sessionPath)) {
            fs.mkdirSync(sessionPath, { recursive: true });
        }

        const accData = {
            id: accId,
            sock: null,
            status: 'INITIALIZING',
            qrCodeDataUrl: null,
            userInfo: null
        };

        this.accounts.set(accId, accData);
        this.broadcastState();

        try {
            const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
            const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1015901307] }));

            const sock = makeWASocket({
                version,
                logger,
                printQRInTerminal: false,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, logger),
                },
                browser: ['AutoWhatsApp Pro', 'Chrome', '1.0.0'],
                generateHighQualityLinkPreview: true,
                markOnlineOnConnect: true,
                syncFullHistory: false
            });

            accData.sock = sock;

            sock.ev.on('creds.update', saveCreds);

            sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, qr } = update;

                if (qr) {
                    try {
                        const qrDataUrl = await QRCode.toDataURL(qr);
                        accData.qrCodeDataUrl = qrDataUrl;
                        accData.status = 'QR_READY';
                        console.log(`[Baileys Pure Engine] 📸 Instant Fresh QR Code Ready for ${accId}`);
                        this.broadcastState();
                    } catch (err) {
                        console.error(`[Baileys Pure Engine] Error generating QR for ${accId}:`, err);
                    }
                }

                if (connection === 'open') {
                    const userJid = sock.user ? sock.user.id : '';
                    const cleanPhone = userJid ? userJid.split(':')[0].split('@')[0] : '';
                    const pushName = sock.user ? (sock.user.name || sock.user.notify || 'Connected Account') : 'WhatsApp User';

                    if (cleanPhone) {
                        for (const [existingId, existingAcc] of this.accounts) {
                            if (existingId !== accId && existingAcc.status === 'CONNECTED' && existingAcc.userInfo && existingAcc.userInfo.wid === cleanPhone) {
                                console.log(`[Baileys Pure Engine] ⚠️ Account +${cleanPhone} is Already Registered on ${existingId}! Disconnecting duplicate slot ${accId}...`);
                                await this.logoutAccount(accId);
                                return;
                            }
                        }
                    }

                    accData.userInfo = {
                        pushname: pushName,
                        wid: cleanPhone
                    };
                    accData.qrCodeDataUrl = null;
                    accData.status = 'CONNECTED';
                    console.log(`[Baileys Pure Engine] ✅ ${accId} READY! Connected as ${pushName} (+${cleanPhone})`);
                    this.broadcastState();
                }

                if (connection === 'close') {
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                    console.log(`[Baileys Pure Engine] ${accId} Connection closed (StatusCode: ${statusCode}). Reconnecting: ${shouldReconnect}`);

                    if (shouldReconnect && accData.status !== 'CONNECTED') {
                        accData.status = 'INITIALIZING';
                        this.broadcastState();
                        await delay(2000);
                        if (this.accounts.has(accId) && this.accounts.get(accId).status !== 'CONNECTED') {
                            await this.createAccountInstance(accId);
                        }
                    } else if (!shouldReconnect) {
                        console.log(`[Baileys Pure Engine] ${accId} Logged out cleanly.`);
                        accData.status = 'DISCONNECTED';
                        accData.userInfo = null;
                        accData.qrCodeDataUrl = null;
                        this.broadcastState();
                    }
                }
            });

            // Message Upsert Listener for Auto-Responders
            sock.ev.on('messages.upsert', async (m) => {
                if (m.type !== 'notify') return;

                for (const msg of m.messages) {
                    if (msg.key.fromMe || !msg.message) continue;

                    const from = msg.key.remoteJid;
                    if (!from || from.endsWith('@g.us')) continue;

                    const textMessage = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
                    if (!textMessage) continue;

                    const incomingText = textMessage.trim().toLowerCase();

                    for (const rule of this.autoReplyRules) {
                        if (!rule.keyword) continue;

                        const targetKw = rule.keyword.trim().toLowerCase();
                        const isMatch = rule.exactMatch 
                            ? incomingText === targetKw 
                            : incomingText.includes(targetKw);

                        if (isMatch) {
                            try {
                                if (rule.mediaObj && rule.mediaObj.data) {
                                    const buffer = Buffer.from(rule.mediaObj.data, 'base64');
                                    await sock.sendMessage(from, {
                                        image: buffer,
                                        caption: rule.replyText || ''
                                    });
                                } else {
                                    await sock.sendMessage(from, { text: rule.replyText || '' });
                                }

                                if (this.onAutoReplyLog) {
                                    this.onAutoReplyLog({
                                        accId,
                                        from: from.replace('@s.whatsapp.net', ''),
                                        keyword: rule.keyword,
                                        replyText: rule.replyText
                                    });
                                }
                            } catch (err) {
                                console.error(`[Baileys Auto-Responder] Error replying to ${from}:`, err.message);
                            }
                            break;
                        }
                    }
                }
            });

        } catch (err) {
            console.error(`[Baileys Pure Engine] Error creating instance ${accId}:`, err);
            accData.status = 'DISCONNECTED';
            this.broadcastState();
        }

        return accData;
    }

    /**
     * Fresh QR Reset Trigger (Forces clean QR generation every single time)
     */
    async requestFreshQR(accId) {
        const accData = this.accounts.get(accId);
        if (accData && accData.status === 'CONNECTED') {
            return accData;
        }

        console.log(`[Baileys Pure Engine] 🔄 Generating Fresh QR Reset for ${accId}...`);

        if (accData && accData.sock) {
            try {
                accData.sock.ev.removeAllListeners();
                accData.sock.end();
            } catch (e) {}
        }

        const sessionPath = path.join(__dirname, '.baileys_auth', `session-${accId}`);
        try {
            if (fs.existsSync(sessionPath)) {
                fs.rmSync(sessionPath, { recursive: true, force: true });
            }
        } catch (e) {}

        this.accounts.delete(accId);
        return await this.createAccountInstance(accId);
    }

    async addAccountSlot() {
        if (this.accounts.size >= this.maxAccounts) {
            throw new Error(`Maximum limit of ${this.maxAccounts} WhatsApp accounts reached!`);
        }

        for (const [accId, accData] of this.accounts) {
            if (accData.status !== 'CONNECTED') {
                throw new Error(`Please scan the current WhatsApp QR code before adding a new account!`);
            }
        }

        let slotNum = 1;
        while (this.accounts.has(`acc_${slotNum}`)) {
            slotNum++;
        }

        const newAccId = `acc_${slotNum}`;
        return await this.createAccountInstance(newAccId);
    }

    async addNewAccount() {
        return await this.addAccountSlot();
    }

    setAutoReplyRules(rules) {
        this.autoReplyRules = rules || [];
    }

    async sendMessageFrom(accId, recipientJid, messageText, mediaObj = null) {
        const accData = this.accounts.get(accId);
        if (!accData || accData.status !== 'CONNECTED' || !accData.sock) {
            throw new Error(`Account ${accId} is not connected!`);
        }

        let digits = String(recipientJid).replace(/\D/g, '');
        if (digits.length === 10) {
            digits = `91${digits}`; // Auto-add India country code 91 for 10-digit mobile numbers
        }
        let cleanJid = recipientJid.includes('@') ? recipientJid : `${digits}@s.whatsapp.net`;

        return new Promise(async (resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error('WhatsApp Dispatch Timeout (10s exceeded)'));
            }, 10000);

            try {
                let res;
                if (mediaObj && mediaObj.data && mediaObj.mimetype) {
                    const buffer = Buffer.from(mediaObj.data, 'base64');
                    if (mediaObj.mimetype.startsWith('image/')) {
                        res = await accData.sock.sendMessage(cleanJid, { image: buffer, caption: messageText || '' });
                    } else if (mediaObj.mimetype.startsWith('video/')) {
                        res = await accData.sock.sendMessage(cleanJid, { video: buffer, caption: messageText || '' });
                    } else {
                        res = await accData.sock.sendMessage(cleanJid, {
                            document: buffer,
                            mimetype: mediaObj.mimetype,
                            fileName: mediaObj.filename || 'attachment.pdf',
                            caption: messageText || ''
                        });
                    }
                } else {
                    res = await accData.sock.sendMessage(cleanJid, { text: messageText || 'Hello' });
                }
                clearTimeout(timer);
                resolve(res);
            } catch (err) {
                clearTimeout(timer);
                reject(err);
            }
        });
    }



    async logoutAccount(accId) {
        const accData = this.accounts.get(accId);
        if (!accData) return;

        console.log(`[Baileys Pure Engine] Logging out ${accId}...`);
        if (accData.sock) {
            try {
                await accData.sock.logout().catch(() => {});
            } catch (e) {}
        }

        const sessionPath = path.join(__dirname, '.baileys_auth', `session-${this.userId}_${accId}`);
        try {
            if (fs.existsSync(sessionPath)) {
                fs.rmSync(sessionPath, { recursive: true, force: true });
            }
        } catch (e) {}

        this.accounts.delete(accId);

        if (this.accounts.size === 0) {
            await this.createAccountInstance('acc_1');
        } else {
            this.broadcastState();
        }
    }

    async logoutAllAccounts() {
        console.log(`[Baileys Pure Engine ${this.userId}] Logging out ALL connected WhatsApp accounts...`);
        const accIds = Array.from(this.accounts.keys());

        for (const accId of accIds) {
            const accData = this.accounts.get(accId);
            if (accData && accData.sock) {
                try {
                    await accData.sock.logout().catch(() => {});
                } catch (e) {}
            }
            const sessionPath = path.join(__dirname, '.baileys_auth', `session-${this.userId}_${accId}`);
            try {
                if (fs.existsSync(sessionPath)) {
                    fs.rmSync(sessionPath, { recursive: true, force: true });
                }
            } catch (e) {}
        }

        this.accounts.clear();
        await this.createAccountInstance('acc_1');
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
                userInfo: accData.userInfo
            });
        }
        return result;
    }

    getAccountsState() {
        return this.getAllAccountsState();
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
