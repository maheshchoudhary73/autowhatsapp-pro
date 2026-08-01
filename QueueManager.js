/**
 * QueueManager.js - Multi-Account & Media Dispatch Load Balancer
 */

class QueueManager {
    constructor() {
        this.queue = [];
        this.template = '';
        this.mediaObj = null;              // { data: base64, mimetype, filename }
        this.autoReplyRules = [];          // Configured keyword rules
        
        this.routingMode = 'ROUND_ROBIN';  // 'ROUND_ROBIN' | 'SPECIFIC_ACCOUNT' | 'CUSTOM_RATIO'
        this.selectedAccId = null;
        this.customRatioLimits = {};
        
        this.activeSendingAccounts = [];
        this.accountSendCounts = {};

        this.settings = {
            maxPerMinute: 30,
            maxPer24Hours: 2000,
            minDelaySeconds: 3,
            maxDelaySeconds: 8
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

        if (cleaned.length >= 11 && cleaned.length <= 15) {
            return cleaned + '@c.us';
        }
        return null;
    }

    compileTemplate(template, rowData) {
        let compiled = template;
        const extractedName = this.extractNameFromRow(rowData);
        const phoneExtracted = this.extractPhoneFromRow(rowData);

        Object.keys(rowData).forEach(key => {
            const regex = new RegExp(`\\{${key}\\}`,'gi');
            compiled = compiled.replace(regex, rowData[key] !== undefined ? rowData[key] : '');
        });

        compiled = compiled.replace(/\{name\}/gi, extractedName);
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
                formattedPhone: phoneInfo ? phoneInfo.phone : null,
                rawPhone: phoneInfo ? phoneInfo.raw : (c.Phone || c.phone || 'N/A'),
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
            maxPer24Hours: parseInt(settings.maxPer24Hours) || (200 * activeCount),
            minDelaySeconds: parseInt(settings.minDelaySeconds) || Math.max(1, Math.floor(60 / dynamicSpeedCap)),
            maxDelaySeconds: parseInt(settings.maxDelaySeconds) || Math.max(2, Math.floor(120 / dynamicSpeedCap))
        };

        this.stats = {
            total: this.queue.length,
            sent: 0,
            failed: 0,
            pending: this.queue.length,
            dailySent24h: this.history24h.length,
            activeAccountsCount: activeCount,
            speedCapPerMin: dynamicSpeedCap
        };

        this.logs = [];
        this.status = 'idle';
        this.rrIndex = 0;
    }

    getNextAccountForNextItem() {
        if (!this.activeSendingAccounts || this.activeSendingAccounts.length === 0) {
            return null;
        }

        if (this.routingMode === 'SPECIFIC_ACCOUNT' && this.selectedAccId) {
            return this.activeSendingAccounts.includes(this.selectedAccId) ? this.selectedAccId : this.activeSendingAccounts[0];
        }

        if (this.routingMode === 'CUSTOM_RATIO') {
            for (const accId of this.activeSendingAccounts) {
                const maxQuota = this.customRatioLimits[accId] || 999999;
                const currentSent = this.accountSendCounts[accId] || 0;
                if (currentSent < maxQuota) {
                    return accId;
                }
            }
            return this.activeSendingAccounts[0];
        }

        const targetAccId = this.activeSendingAccounts[this.rrIndex % this.activeSendingAccounts.length];
        this.rrIndex++;
        return targetAccId;
    }

    async start(sendMessageFromFn, callbacks = {}) {
        if (this.status === 'running') return;
        this.sendMessageCallback = sendMessageFromFn;
        this.onProgress = callbacks.onProgress || null;
        this.onLog = callbacks.onLog || null;
        this.onFinish = callbacks.onFinish || null;

        this.status = 'running';
        this.processNext();
    }

    pause() {
        if (this.status === 'running') {
            this.status = 'paused';
            if (this.currentTimeout) clearTimeout(this.currentTimeout);
            this.addLog('system', 'Campaign Paused by User');
            this.notifyProgress();
        }
    }

    resume() {
        if (this.status === 'paused') {
            this.status = 'running';
            this.addLog('system', 'Campaign Resumed by User');
            this.processNext();
        }
    }

    stop() {
        this.status = 'stopped';
        if (this.currentTimeout) clearTimeout(this.currentTimeout);
        this.notifyProgress();
    }

    async processNext() {
        if (this.status !== 'running') return;

        this.cleanHistory();

        if (this.history24h.length >= this.settings.maxPer24Hours) {
            this.addLog('warning', `24-Hour Limit Reached (${this.settings.maxPer24Hours} msgs). Auto-paused.`);
            this.pause();
            return;
        }

        if (this.history1m.length >= this.settings.maxPerMinute) {
            const oldestIn1m = this.history1m[0];
            const waitTime = Math.max(1000, 60000 - (Date.now() - oldestIn1m) + 500);
            this.addLog('info', `Speed limit reached (${this.settings.maxPerMinute} msgs/min across ${this.stats.activeAccountsCount} accounts). Waiting ${Math.ceil(waitTime / 1000)}s...`);
            this.currentTimeout = setTimeout(() => this.processNext(), waitTime);
            return;
        }

        const itemIndex = this.queue.findIndex(item => item.status === 'pending');
        if (itemIndex === -1) {
            this.status = 'completed';
            this.addLog('success', '🎉 Multi-Account Campaign Completed Successfully!');
            this.notifyProgress();
            if (this.onFinish) this.onFinish(this.getSummary());
            return;
        }

        const item = this.queue[itemIndex];

        if (!item.formattedPhone) {
            item.status = 'failed';
            item.error = 'Invalid Phone Number';
            this.stats.failed++;
            this.stats.pending--;
            this.addLog('error', `Skipped invalid phone number: ${item.rawPhone}`);
            this.notifyProgress();
            this.currentTimeout = setTimeout(() => this.processNext(), 300);
            return;
        }

        const accId = this.getNextAccountForNextItem();
        if (!accId) {
            this.addLog('error', 'No active WhatsApp account available to send!');
            this.pause();
            return;
        }

        item.assignedAccount = accId;
        const messageText = this.compileTemplate(this.template, item.data);
        const displayName = item.name || item.rawPhone;

        try {
            const hasMedia = this.mediaObj && this.mediaObj.data;
            this.addLog('info', `[${accId}] Sending ${hasMedia ? 'Media +' : ''} message to ${displayName} (${item.rawPhone})...`);
            
            await this.sendMessageCallback(accId, item.formattedPhone, messageText, this.mediaObj);

            // Success
            item.status = 'sent';
            const now = Date.now();
            this.history1m.push(now);
            this.history24h.push(now);
            this.accountSendCounts[accId] = (this.accountSendCounts[accId] || 0) + 1;
            this.stats.sent++;
            this.stats.pending--;
            this.stats.dailySent24h = this.history24h.length;

            this.addLog('success', `✅ [${accId}] Sent to ${displayName} (${item.rawPhone})`);
        } catch (err) {
            item.status = 'failed';
            item.error = err.message || 'Send Failed';
            this.stats.failed++;
            this.stats.pending--;

            this.addLog('error', `❌ [${accId}] Failed sending to ${item.rawPhone}: ${item.error}`);
        }

        this.notifyProgress();

        if (this.status === 'running' && this.stats.pending > 0) {
            const minMs = this.settings.minDelaySeconds * 1000;
            const maxMs = this.settings.maxDelaySeconds * 1000;
            const randomDelay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;

            this.addLog('delay', `Waiting ${Math.round(randomDelay / 1000)}s anti-ban delay before next dispatch...`);
            this.currentTimeout = setTimeout(() => this.processNext(), randomDelay);
        }
    }

    addLog(type, text) {
        const logEntry = {
            id: Date.now() + Math.random(),
            timestamp: new Date().toLocaleTimeString(),
            type,
            text
        };
        this.logs.unshift(logEntry);
        if (this.logs.length > 250) this.logs.pop();
        if (this.onLog) this.onLog(logEntry);
    }

    notifyProgress() {
        if (this.onProgress) {
            this.onProgress({
                status: this.status,
                stats: this.stats,
                queue: this.queue,
                accountSendCounts: this.accountSendCounts
            });
        }
    }

    getSummary() {
        return {
            status: this.status,
            stats: this.stats,
            queue: this.queue,
            logs: this.logs,
            accountSendCounts: this.accountSendCounts
        };
    }
}

module.exports = QueueManager;
