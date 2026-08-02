/**
 * QueueManager.js - Multi-Account & Media Dispatch Load Balancer
 * Official Baileys Engine Adapter (@s.whatsapp.net)
 */

class QueueManager {
    constructor() {
        this.queue = [];
        this.template = '';
        this.mediaObj = null;
        this.autoReplyRules = [];
        
        this.routingMode = 'ROUND_ROBIN';  // 'ROUND_ROBIN' | 'SPECIFIC_ACCOUNT' | 'CUSTOM_RATIO'
        this.selectedAccId = null;
        this.customRatioLimits = {};
        
        this.activeSendingAccounts = [];
        this.accountSendCounts = {};

        this.settings = {
            maxPerMinute: 30,
            maxPer24Hours: 2000,
            minDelaySeconds: 2,
            maxDelaySeconds: 5
        };

        this.status = 'idle';
        this.history24h = [];
        this.history1m = [];
        
        this.stats = {
            total: 0,
            sent: 0,
            failed: 0,
            pending: 0,
            dailySent24h: 0,
            activeAccountsCount: 1,
            speedCapPerMin: 30
        };

        this.logs = [];
        this.currentTimeout = null;
        this.onProgress = null;
        this.onLog = null;
        this.onFinish = null;
        this.sendMessageCallback = null;
        this.rrIndex = 0;
    }

    static getSpeedCapForAccountCount(count) {
        const caps = [0, 30, 60, 100, 150, 250, 350, 400, 450, 500, 600];
        if (count <= 0) return 30;
        if (count >= 10) return 600;
        return caps[count];
    }

    cleanHistory() {
        const now = Date.now();
        const oneMinuteAgo = now - 60 * 1000;
        const twentyFourHoursAgo = now - 24 * 60 * 60 * 1000;

        this.history1m = this.history1m.filter(ts => ts > oneMinuteAgo);
        this.history24h = this.history24h.filter(ts => ts > twentyFourHoursAgo);
        this.stats.dailySent24h = this.history24h.length;
    }

    extractPhoneFromRow(row) {
        if (!row) return null;
        if (row.phone) {
            const formatted = this.formatPhoneNumber(row.phone);
            if (formatted) return { phone: formatted, raw: row.rawPhone || row.phone };
        }
        const phoneKeys = ['phone', 'mobile', 'number', 'contact', 'whatsapp', 'mobile number', 'phone number', 'contact number', 'mob', 'cell'];
        for (const key of Object.keys(row)) {
            const cleanKey = key.toLowerCase().trim();
            if (phoneKeys.includes(cleanKey)) {
                const formatted = this.formatPhoneNumber(row[key]);
                if (formatted) return { phone: formatted, raw: row[key] };
            }
        }
        for (const key of Object.keys(row)) {
            const formatted = this.formatPhoneNumber(row[key]);
            if (formatted) return { phone: formatted, raw: row[key] };
        }
        return null;
    }

    extractNameFromRow(row) {
        if (!row) return '';
        if (row.name) return row.name;
        const nameKeys = ['name', 'customer name', 'contact name', 'person name', 'first name', 'full name', 'lead name', 'naam', 'customer'];
        for (const key of Object.keys(row)) {
            const cleanKey = key.toLowerCase().trim();
            if (nameKeys.includes(cleanKey)) {
                if (row[key] && String(row[key]).trim() !== '') {
                    return String(row[key]).trim();
                }
            }
        }
        for (const key of Object.keys(row)) {
            if (key.toLowerCase().includes('name') || key.toLowerCase().includes('naam')) {
                if (row[key] && String(row[key]).trim() !== '') {
                    return String(row[key]).trim();
                }
            }
        }
        return '';
    }

    formatPhoneNumber(rawPhone) {
        if (!rawPhone && rawPhone !== 0) return null;
        let cleaned = String(rawPhone).replace(/\D/g, '');
        cleaned = cleaned.replace(/^0+/, '');

        if (cleaned.length === 10) {
            cleaned = '91' + cleaned;
        }

        if (cleaned.length >= 10 && cleaned.length <= 15) {
            return cleaned + '@s.whatsapp.net';
        }
        return null;
    }

    compileTemplate(template, rowData) {
        let compiled = template || '';
        const extractedName = this.extractNameFromRow(rowData);
        const phoneExtracted = this.extractPhoneFromRow(rowData);

        Object.keys(rowData).forEach(key => {
            const regex = new RegExp(`\\{${key}\\}`,'gi');
            compiled = compiled.replace(regex, rowData[key] !== undefined ? rowData[key] : '');
        });

        compiled = compiled.replace(/\{name\}/gi, extractedName || 'Customer');
        compiled = compiled.replace(/\{phone\}/gi, phoneExtracted ? phoneExtracted.raw : '');
        compiled = compiled.replace(/Hello\s+,/gi, 'Hello,');

        return compiled;
    }

    loadCampaign(contacts, template, settings, routingConfig = {}, mediaObj = null, autoReplyRules = []) {
        this.stop();
        this.queue = contacts.map((c, index) => {
            const phoneInfo = this.extractPhoneFromRow(c);
            const nameInfo = this.extractNameFromRow(c);
            return {
                id: index + 1,
                data: c,
                name: nameInfo || (phoneInfo ? phoneInfo.raw : `Contact #${index + 1}`),
                formattedPhone: phoneInfo ? phoneInfo.phone : (c.phone ? (c.phone.includes('@') ? c.phone : `${c.phone}@s.whatsapp.net`) : null),
                rawPhone: phoneInfo ? phoneInfo.raw : (c.rawPhone || c.phone || 'N/A'),
                status: 'pending',
                assignedAccount: null,
                error: null
            };
        });

        this.template = template;
        this.mediaObj = mediaObj;
        this.autoReplyRules = autoReplyRules || [];
        this.routingMode = routingConfig.mode || 'ROUND_ROBIN';
        this.selectedAccId = routingConfig.selectedAccId || null;
        this.customRatioLimits = routingConfig.customRatioLimits || {};
        this.activeSendingAccounts = routingConfig.activeAccountIds || ['acc_1'];

        this.accountSendCounts = {};
        this.activeSendingAccounts.forEach(accId => {
            this.accountSendCounts[accId] = 0;
        });

        const activeCount = this.activeSendingAccounts.length;
        const dynamicSpeedCap = QueueManager.getSpeedCapForAccountCount(activeCount);

        this.settings = {
            maxPerMinute: dynamicSpeedCap,
            maxPer24Hours: settings?.maxPer24Hours || 2000,
            minDelaySeconds: settings?.minDelaySeconds || 2,
            maxDelaySeconds: settings?.maxDelaySeconds || 4
        };

        this.stats.total = this.queue.length;
        this.stats.sent = 0;
        this.stats.failed = 0;
        this.stats.pending = this.queue.length;
        this.stats.activeAccountsCount = activeCount;
        this.stats.speedCapPerMin = dynamicSpeedCap;
        this.logs = [];

        this.status = 'loaded';
    }

    selectNextAccount() {
        if (!this.activeSendingAccounts || this.activeSendingAccounts.length === 0) {
            return null;
        }

        if (this.routingMode === 'SPECIFIC_ACCOUNT' && this.selectedAccId) {
            if (this.activeSendingAccounts.includes(this.selectedAccId)) {
                return this.selectedAccId;
            }
        }

        if (this.routingMode === 'CUSTOM_RATIO') {
            for (const accId of this.activeSendingAccounts) {
                const maxAllowed = this.customRatioLimits[accId] !== undefined ? this.customRatioLimits[accId] : Infinity;
                const currentSent = this.accountSendCounts[accId] || 0;
                if (currentSent < maxAllowed) {
                    return accId;
                }
            }
            return null;
        }

        const accId = this.activeSendingAccounts[this.rrIndex % this.activeSendingAccounts.length];
        this.rrIndex++;
        return accId;
    }

    calculateDynamicDelayMs() {
        const speedCapPerMin = this.stats.speedCapPerMin || 30;
        const minIntervalMs = Math.ceil((60 * 1000) / speedCapPerMin);
        const randomBufferMs = Math.floor(Math.random() * 1000) + 500; // 0.5s - 1.5s random jitter
        return Math.max(minIntervalMs, randomBufferMs);
    }

    start(sendMessageCallback, callbacks = {}) {
        if (!sendMessageCallback) throw new Error('sendMessageCallback is required!');
        
        this.sendMessageCallback = sendMessageCallback;
        this.onProgress = callbacks.onProgress || null;
        this.onLog = callbacks.onLog || null;
        this.onFinish = callbacks.onFinish || null;

        this.status = 'running';
        this.processNextItem();
    }

    pause() {
        this.status = 'paused';
        if (this.currentTimeout) {
            clearTimeout(this.currentTimeout);
            this.currentTimeout = null;
        }
        this.emitLog('info', '⏸️ Campaign dispatch paused.');
        this.emitProgress();
    }

    resume() {
        if (this.status === 'paused') {
            this.status = 'running';
            this.emitLog('info', '▶️ Campaign dispatch resumed.');
            this.processNextItem();
        }
    }

    stop() {
        this.status = 'idle';
        if (this.currentTimeout) {
            clearTimeout(this.currentTimeout);
            this.currentTimeout = null;
        }
        this.queue = [];
    }

    async processNextItem() {
        if (this.status !== 'running') return;

        this.cleanHistory();

        const pendingItem = this.queue.find(item => item.status === 'pending');
        if (!pendingItem) {
            this.status = 'completed';
            this.emitLog('success', '🎉 Campaign completed successfully!');
            this.emitProgress();
            if (this.onFinish) this.onFinish(this.stats);
            return;
        }

        const selectedAccId = this.selectNextAccount();
        if (!selectedAccId) {
            this.status = 'completed';
            this.emitLog('warning', '⚠️ All account quotas or limits reached. Campaign finished.');
            this.emitProgress();
            if (this.onFinish) this.onFinish(this.stats);
            return;
        }

        if (!pendingItem.formattedPhone) {
            pendingItem.status = 'failed';
            pendingItem.error = 'Invalid Phone Number';
            this.stats.failed++;
            this.stats.pending--;
            this.emitLog('error', `❌ Invalid phone number for contact: ${pendingItem.rawPhone}`);
            this.emitProgress();
            
            this.scheduleNext(500);
            return;
        }

        pendingItem.status = 'sending';
        pendingItem.assignedAccount = selectedAccId;
        const compiledMsg = this.compileTemplate(this.template, pendingItem.data);

        try {
            await this.sendMessageCallback(selectedAccId, pendingItem.formattedPhone, compiledMsg, this.mediaObj);

            pendingItem.status = 'sent';
            this.stats.sent++;
            this.stats.pending--;
            
            this.history1m.push(Date.now());
            this.history24h.push(Date.now());
            this.accountSendCounts[selectedAccId] = (this.accountSendCounts[selectedAccId] || 0) + 1;

            const cleanDigits = pendingItem.formattedPhone.replace(/\D/g, '');

            this.emitLog('success', `✅ Sent to +${pendingItem.rawPhone || cleanDigits} from slot (${selectedAccId})`, cleanDigits);
            this.emitProgress();

        } catch (err) {
            console.error(`[QueueManager] Send failure for ${pendingItem.formattedPhone}:`, err.message);
            pendingItem.status = 'failed';
            pendingItem.error = err.message || 'Send Failed';
            this.stats.failed++;
            this.stats.pending--;

            const cleanDigits = pendingItem.formattedPhone.replace(/\D/g, '');

            this.emitLog('error', `❌ Failed sending to +${pendingItem.rawPhone || cleanDigits}: ${err.message}`, cleanDigits);
            this.emitProgress();
        }

        const delayMs = this.calculateDynamicDelayMs();
        this.scheduleNext(delayMs);
    }

    scheduleNext(delayMs) {
        if (this.currentTimeout) clearTimeout(this.currentTimeout);
        this.currentTimeout = setTimeout(() => {
            this.processNextItem();
        }, delayMs);
    }

    emitProgress() {
        if (this.onProgress) {
            this.onProgress({
                sent: this.stats.sent,
                pending: this.stats.pending,
                failed: this.stats.failed,
                total: this.stats.total,
                status: this.status,
                dailySent24h: this.stats.dailySent24h,
                speedCapPerMin: this.stats.speedCapPerMin
            });
        }
    }

    emitLog(type, text, phone = null) {
        const logEntry = {
            type,
            timestamp: new Date().toLocaleTimeString(),
            text,
            phone
        };
        this.logs.push(logEntry);
        if (this.onLog) {
            this.onLog(logEntry);
        }
    }
}

module.exports = QueueManager;
