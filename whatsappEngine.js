/**
 * whatsappEngine.js - Ultra-Fast Native WebSocket Engine using Baileys
 * Zero Chrome Dependency, Instant 1-Second QR Code & 8-Digit Pairing Code
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

// Dummy logger to silence pino verbose logs
const pino = require('pino');
const logger = pino({ level: 'silent' });

class WhatsAppEngine {
    constructor() {
        this.maxAccounts = 10;
        this.accounts = new Map(); // accId -> { id, sock, status, qrCodeDataUrl, pairingCode, userInfo }
        this.autoReplyRules = [];
        this.onAccountsUpdate = null;
        this.onAutoReplyLog = null;
    }

    async init(callbacks = {}) {
        this.onAccountsUpdate = callbacks.onAccountsUpdate || this.onAccountsUpdate;
        this.onAutoReplyLog = callbacks.onAutoReplyLog || this.onAutoReplyLog;

        const authBaseDir = path.join(__dirname, '.baileys_auth');
        if (!fs.existsSync(authBaseDir)) {
            fs.mkdirSync(authBaseDir, { recursive: true });
        }

        const dirs = fs.readdirSync(authBaseDir);
        const sessionDirs = dirs.filter(d => d.startsWith('session-acc_'));

        if (sessionDirs.length > 0) {
            for (const dirName of sessionDirs) {
                const accId = dirName.replace('session-', '');
                await this.createAccountInstance(accId);
            }
        } else {
            // Default Account Slot 1
            await this.createAccountInstance('acc_1');
        }
    }

    async createAccountInstance(accId) {
        if (this.accounts.has(accId)) return this.accounts.get(accId);
        if (this.accounts.size >= this.maxAccounts) {
            throw new Error(`Maximum limit of ${this.maxAccounts} WhatsApp accounts reached!`);
        }

        const sessionPath = path.join(__dirname, '.baileys_auth', `session-${accId}`);
        if (!fs.existsSync(sessionPath)) {
            fs.mkdirSync(sessionPath, { recursive: true });
        }

        const accData = {
            id: accId,
            sock: null,
            status: 'INITIALIZING',
            qrCodeDataUrl: null,
            pairingCode: null,
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
                        accData.qrCodeDataUrl = await QRCode.toDataURL(qr);
                        accData.status = 'QR_READY';
                        console.log(`[Baileys Engine] 📸 Instant QR Code Ready for ${accId}`);
                        this.broadcastState();
                    } catch (err) {
                        console.error(`[Baileys Engine] Error generating QR for ${accId}:`, err);
                    }
                }

                if (connection === 'open') {
                    const userJid = sock.user ? sock.user.id : '';
                    const cleanPhone = userJid ? userJid.split(':')[0].split('@')[0] : '';
                    const pushName = sock.user ? (sock.user.name || sock.user.notify || 'Connected Account') : 'WhatsApp User';

                    // Check if this phone number is ALREADY connected on another slot
                    if (cleanPhone) {
                        for (const [existingId, existingAcc] of this.accounts) {
                            if (existingId !== accId && existingAcc.status === 'CONNECTED' && existingAcc.userInfo && existingAcc.userInfo.wid === cleanPhone) {
                                console.log(`[Baileys Engine] ⚠️ Account +${cleanPhone} is Already Registered on ${existingId}! Disconnecting duplicate slot ${accId}...`);
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
                    accData.pairingCode = null;
                    accData.status = 'CONNECTED';
                    console.log(`[Baileys Engine] ✅ ${accId} READY! Connected as ${pushName} (+${cleanPhone})`);
                    this.broadcastState();
                }

                if (connection === 'close') {
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                    console.log(`[Baileys Engine] ${accId} Connection closed (StatusCode: ${statusCode}). Reconnecting: ${shouldReconnect}`);

                    if (shouldReconnect) {
                        accData.status = 'INITIALIZING';
                        this.broadcastState();
                        await delay(3000);
                        this.accounts.delete(accId);
                        await this.createAccountInstance(accId);
                    } else {
                        console.log(`[Baileys Engine] ${accId} Logged out cleanly.`);
                        accData.status = 'DISCONNECTED';
                        accData.userInfo = null;
                        accData.qrCodeDataUrl = null;
                        accData.pairingCode = null;
                        this.broadcastState();
                    }
                }
            });

            // Incoming Messages Listener for Auto-Responders
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
            console.error(`[Baileys Engine] Error creating instance ${accId}:`, err);
            accData.status = 'DISCONNECTED';
            this.broadcastState();
        }

        return accData;
    }

    /**
     * Instant Native 8-Digit Phone Pairing Code Generation
     */
    async requestPairingCode(accId, phoneNumber) {
        const accData = this.accounts.get(accId);
        if (!accData || !accData.sock) {
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

        console.log(`[Baileys Engine] Requesting native 8-digit pairing code for ${accId} with phone: ${cleanPhone}...`);

        try {
            // Native WebSocket Pairing Code Request (0.5 Seconds!)
            const code = await accData.sock.requestPairingCode(cleanPhone);
            const formattedCode = code?.match(/.{1,4}/g)?.join('-') || code;
            accData.pairingCode = formattedCode;
            accData.status = 'PAIRING_CODE_READY';
            console.log(`[Baileys Engine] 🔑 Native Pairing Code for ${accId}: ${formattedCode}`);
            this.broadcastState();
            return formattedCode;
        } catch (err) {
            console.error(`[Baileys Engine] Error requesting pairing code for ${accId}:`, err.message);
            throw new Error(`Failed to request pairing code: ${err.message}`);
        }
    }

    async addAccountSlot() {
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
        return await this.createAccountInstance(newAccId);
    }

    setAutoReplyRules(rules) {
        this.autoReplyRules = rules || [];
    }

    async sendMessageFrom(accId, recipientJid, messageText, mediaObj = null) {
        const accData = this.accounts.get(accId);
        if (!accData || accData.status !== 'CONNECTED' || !accData.sock) {
            throw new Error(`Account ${accId} is not connected!`);
        }

        let cleanJid = recipientJid.includes('@') ? recipientJid : `${recipientJid.replace(/\D/g, '')}@s.whatsapp.net`;

        if (mediaObj && mediaObj.data && mediaObj.mimetype) {
            const buffer = Buffer.from(mediaObj.data, 'base64');
            if (mediaObj.mimetype.startsWith('image/')) {
                return await accData.sock.sendMessage(cleanJid, { image: buffer, caption: messageText || '' });
            } else if (mediaObj.mimetype.startsWith('video/')) {
                return await accData.sock.sendMessage(cleanJid, { video: buffer, caption: messageText || '' });
            } else {
                return await accData.sock.sendMessage(cleanJid, {
                    document: buffer,
                    mimetype: mediaObj.mimetype,
                    fileName: mediaObj.filename || 'attachment.pdf',
                    caption: messageText || ''
                });
            }
        } else {
            return await accData.sock.sendMessage(cleanJid, { text: messageText });
        }
    }

    async logoutAccount(accId) {
        const accData = this.accounts.get(accId);
        if (!accData) return;

        console.log(`[Baileys Engine] Logging out ${accId}...`);
        if (accData.sock) {
            try {
                await accData.sock.logout().catch(() => {});
            } catch (e) {}
        }

        const sessionPath = path.join(__dirname, '.baileys_auth', `session-${accId}`);
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
        console.log('[Baileys Engine] Logging out ALL connected WhatsApp accounts...');
        const accIds = Array.from(this.accounts.keys());

        for (const accId of accIds) {
            const accData = this.accounts.get(accId);
            if (accData && accData.sock) {
                try {
                    await accData.sock.logout().catch(() => {});
                } catch (e) {}
            }
            const sessionPath = path.join(__dirname, '.baileys_auth', `session-${accId}`);
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
