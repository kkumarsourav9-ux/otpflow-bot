/**
 * OTPFlow WhatsApp Service — Single-file multi-instance WhatsApp manager
 * Uses Baileys (ESM) via dynamic import() from CommonJS
 * Supports auto-rotation, ban detection, daily message limits
 */

const express = require('express');
const mysql = require('mysql2/promise');
const QRCode = require('qrcode');
const pino = require('pino');

const app = express();
app.use(express.json());
// CORS — allow browser requests from InfinityFree website
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});
const PORT = process.env.PORT || 3000;
const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });

// Will hold Baileys exports after dynamic import
let makeWASocket, DisconnectReason, fetchLatestBaileysVersion, initAuthCreds, BufferJSON;

// Active sessions: instanceId -> { socket, qr, status, phoneNumber }
const sessions = new Map();

// Round-Robin Trackers
const personalRoundRobinIndex = new Map(); // userId -> currentIndex
let sharedRoundRobinIndex = 0;

// ═══════════════════════════════════════════════
//  DATABASE
// ═══════════════════════════════════════════════
let pool = null;
function getPool() {
    if (!pool) {
        pool = mysql.createPool({
            host: process.env.DB_HOST || 'mysql-f908901-kkumarsourav9-3509.i.aivencloud.com',
            port: parseInt(process.env.DB_PORT || '20360'),
            user: process.env.DB_USER || 'avnadmin',
            password: process.env.DB_PASS || 'AVNS_yeQwbjwhAVWpr04KALJ',
            database: process.env.DB_NAME || 'defaultdb',
            waitForConnections: true,
            connectionLimit: 10,
            charset: 'utf8mb4',
            ssl: { rejectUnauthorized: false }
        });
    }
    return pool;
}

// Auto-create whatsapp_instances table on Aiven if missing
async function initDatabase() {
    const db = getPool();
    await db.execute(`CREATE TABLE IF NOT EXISTS whatsapp_instances (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        instance_id VARCHAR(255) NOT NULL UNIQUE,
        phone_number VARCHAR(50) DEFAULT NULL,
        status ENUM('disconnected','connecting','connected','reconnecting','banned') DEFAULT 'disconnected',
        is_banned TINYINT(1) DEFAULT 0,
        is_company_shared TINYINT(1) DEFAULT 0,
        daily_message_limit INT DEFAULT 50,
        messages_sent_today INT DEFAULT 0,
        last_reset_date DATE DEFAULT NULL,
        priority INT DEFAULT 1,
        auth_creds JSON DEFAULT NULL,
        auth_keys JSON DEFAULT NULL,
        last_ping TIMESTAMP NULL DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    console.log('[DB] whatsapp_instances table ready');
}

// ═══════════════════════════════════════════════
//  AUTH STATE (MySQL-backed)
// ═══════════════════════════════════════════════
async function useDBAuthState(instanceId) {
    const db = getPool();

    // Load creds
    const [credRows] = await db.execute('SELECT auth_creds FROM whatsapp_instances WHERE instance_id = ?', [instanceId]);
    let creds;
    if (credRows.length && credRows[0].auth_creds) {
        try {
            const raw = typeof credRows[0].auth_creds === 'string' ? credRows[0].auth_creds : JSON.stringify(credRows[0].auth_creds);
            creds = JSON.parse(raw, BufferJSON.reviver);
        } catch (e) { creds = null; }
    }
    if (!creds) creds = initAuthCreds();

    // Load keys
    const [keyRows] = await db.execute('SELECT auth_keys FROM whatsapp_instances WHERE instance_id = ?', [instanceId]);
    let storedKeys = {};
    if (keyRows.length && keyRows[0].auth_keys) {
        try {
            const raw = typeof keyRows[0].auth_keys === 'string' ? keyRows[0].auth_keys : JSON.stringify(keyRows[0].auth_keys);
            storedKeys = JSON.parse(raw, BufferJSON.reviver);
        } catch (e) { storedKeys = {}; }
    }

    const keys = {
        get: (type, ids) => {
            const data = {};
            for (const id of ids) {
                const k = `${type}-${id}`;
                if (storedKeys[k]) data[id] = storedKeys[k];
            }
            return data;
        },
        set: async (data) => {
            for (const cat in data) {
                for (const id in data[cat]) {
                    const k = `${cat}-${id}`;
                    if (data[cat][id]) storedKeys[k] = data[cat][id];
                    else delete storedKeys[k];
                }
            }
            await db.execute('UPDATE whatsapp_instances SET auth_keys = ? WHERE instance_id = ?', [JSON.stringify(storedKeys, BufferJSON.replacer), instanceId]);
        }
    };

    return {
        state: { creds, keys },
        saveCreds: async () => {
            await db.execute('UPDATE whatsapp_instances SET auth_creds = ? WHERE instance_id = ?', [JSON.stringify(creds, BufferJSON.replacer), instanceId]);
        }
    };
}

// ═══════════════════════════════════════════════
//  DB HELPERS
// ═══════════════════════════════════════════════
async function updateInstanceStatus(instanceId, status, phoneNumber = null) {
    const db = getPool();
    const fields = ['status = ?', 'last_ping = NOW()'];
    const values = [status];
    if (phoneNumber) { fields.push('phone_number = ?'); values.push(phoneNumber); }
    values.push(instanceId);
    await db.execute(`UPDATE whatsapp_instances SET ${fields.join(', ')} WHERE instance_id = ?`, values);
}

async function markBanned(instanceId) {
    const db = getPool();
    await db.execute('UPDATE whatsapp_instances SET is_banned = 1, status = ? WHERE instance_id = ?', ['banned', instanceId]);
}

async function incrementMessageCount(instanceId) {
    const db = getPool();
    const today = new Date().toISOString().split('T')[0];
    await db.execute(
        `UPDATE whatsapp_instances SET messages_sent_today = CASE WHEN last_reset_date IS NULL OR last_reset_date < ? THEN 1 ELSE messages_sent_today + 1 END, last_reset_date = ? WHERE instance_id = ?`,
        [today, today, instanceId]
    );
}

async function getAvailableInstances(userId) {
    const db = getPool();
    const today = new Date().toISOString().split('T')[0];
    const [rows] = await db.execute(
        `SELECT id, instance_id, phone_number, daily_message_limit, messages_sent_today, last_reset_date, priority FROM whatsapp_instances WHERE user_id = ? AND status = 'connected' AND is_banned = 0 ORDER BY priority ASC, messages_sent_today ASC`,
        [userId]
    );
    return rows.map(r => {
        const cnt = (r.last_reset_date && r.last_reset_date >= today) ? r.messages_sent_today : 0;
        return { ...r, messages_sent_today: cnt };
    }).filter(r => r.messages_sent_today < r.daily_message_limit);
}

async function getAvailableSharedInstances() {
    const db = getPool();
    const today = new Date().toISOString().split('T')[0];
    const [rows] = await db.execute(
        `SELECT id, instance_id, phone_number, daily_message_limit, messages_sent_today, last_reset_date FROM whatsapp_instances WHERE is_company_shared = 1 AND status = 'connected' AND is_banned = 0 ORDER BY messages_sent_today ASC`
    );
    return rows.map(r => {
        const cnt = (r.last_reset_date && r.last_reset_date >= today) ? r.messages_sent_today : 0;
        return { ...r, messages_sent_today: cnt };
    }).filter(r => r.messages_sent_today < r.daily_message_limit);
}

async function getAllInstancesForUser(userId) {
    const db = getPool();
    const [rows] = await db.execute(
        `SELECT id, instance_id, phone_number, status, is_banned, daily_message_limit, messages_sent_today, last_reset_date, last_ping FROM whatsapp_instances WHERE user_id = ? ORDER BY priority ASC`,
        [userId]
    );
    return rows;
}

async function createInstanceRecord(userId, instanceId) {
    const db = getPool();
    await db.execute(`INSERT INTO whatsapp_instances (user_id, instance_id, status) VALUES (?, ?, 'disconnected')`, [userId, instanceId]);
}

// ═══════════════════════════════════════════════
//  SESSION MANAGER
// ═══════════════════════════════════════════════
async function startSession(instanceId) {
    if (sessions.has(instanceId)) {
        const existing = sessions.get(instanceId);
        if (existing.status === 'connected') return existing;
        // If stuck in 'connecting' for over 45 seconds, force restart
        if (existing.status === 'connecting' || existing.status === 'qr_ready') {
            const age = Date.now() - (existing.createdAt || 0);
            if (age < 45000) return existing; // Still fresh, don't restart
            console.log(`[${instanceId}] Session stuck for ${Math.round(age / 1000)}s, restarting...`);
            try { existing.socket?.end(); } catch (e) { }
            sessions.delete(instanceId);
        }
    }

    const session = { socket: null, qr: null, status: 'connecting', phoneNumber: null, createdAt: Date.now() };
    sessions.set(instanceId, session);

    try {
        const { state, saveCreds } = await useDBAuthState(instanceId);
        const { version } = await fetchLatestBaileysVersion();
        console.log(`[${instanceId}] Starting session with Baileys v${version.join('.')}...`);

        const socket = makeWASocket({
            version,
            auth: state,
            logger,
            printQRInTerminal: true,
            browser: ['OTPFlow', 'Chrome', '120.0'],
            connectTimeoutMs: 60000,
            markOnlineOnConnect: false,
            generateHighQualityLinkPreview: false
        });

        session.socket = socket;
        socket.ev.on('creds.update', saveCreds);

        socket.ev.on('connection.update', async (update) => {
            try {
                const { connection, lastDisconnect, qr } = update;

                if (qr) {
                    session.qr = qr;
                    session.status = 'qr_ready';
                    console.log(`[${instanceId}] QR code generated, waiting for scan...`);
                }

                if (connection === 'open') {
                    session.status = 'connected';
                    session.qr = null;
                    const phone = socket.user?.id?.split(':')[0] || socket.user?.id?.split('@')[0] || null;
                    session.phoneNumber = phone;
                    await updateInstanceStatus(instanceId, 'connected', phone);
                    console.log(`[${instanceId}] Connected! Phone: ${phone}`);
                }

                if (connection === 'close') {
                    const code = lastDisconnect?.error?.output?.statusCode || 500;
                    console.log(`[${instanceId}] Disconnected: ${code}`);

                    if ([401, 403].includes(code)) {
                        session.status = 'banned';
                        await markBanned(instanceId);
                        sessions.delete(instanceId);
                        return;
                    }
                    if (code === DisconnectReason.loggedOut) {
                        session.status = 'disconnected';
                        await updateInstanceStatus(instanceId, 'disconnected');
                        sessions.delete(instanceId);
                        return;
                    }
                    // Handle 515 (Stream Errored) or 408 safely without crashing
                    session.status = 'reconnecting';
                    await updateInstanceStatus(instanceId, 'reconnecting');
                    setTimeout(() => startSession(instanceId), 5000);
                }
            } catch (eventErr) {
                console.error(`[${instanceId}] Internal Event Error:`, eventErr.message);
                session.status = 'reconnecting';
                setTimeout(() => startSession(instanceId), 5000);
            }
        });

        return session;
    } catch (err) {
        console.error(`[${instanceId}] Failed:`, err.message);
        session.status = 'error';
        try { await updateInstanceStatus(instanceId, 'disconnected'); } catch (e) { }
        return session;
    }
}

async function sendMsg(instanceId, phone, message) {
    const session = sessions.get(instanceId);
    if (!session || session.status !== 'connected') return { success: false, error: 'Not connected' };
    try {
        const jid = phone.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
        await session.socket.sendMessage(jid, { text: message });
        return { success: true };
    } catch (err) {
        if (err.message?.includes('banned') || err.message?.includes('blocked')) {
            await markBanned(instanceId);
            session.status = 'banned';
            return { success: false, error: 'Banned', banned: true };
        }
        return { success: false, error: err.message };
    }
}

function getSession(id) { return sessions.get(id) || null; }

async function disconnectSession(instanceId) {
    const session = sessions.get(instanceId);
    if (session?.socket) {
        try { await session.socket.logout(); } catch (e) { }
        try { session.socket.end(); } catch (e) { }
    }
    sessions.delete(instanceId);
    await updateInstanceStatus(instanceId, 'disconnected');
}

function getAllSessions() {
    const result = {};
    for (const [id, s] of sessions) {
        result[id] = { status: s.status, hasQr: !!s.qr, phoneNumber: s.phoneNumber };
    }
    return result;
}

// Wait for QR with polling
async function waitForQr(instanceId, maxSeconds = 15) {
    for (let i = 0; i < maxSeconds; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const s = getSession(instanceId);
        if (s?.qr || s?.status === 'connected') return s;
    }
    return getSession(instanceId);
}

// ═══════════════════════════════════════════════
//  ROTATION ENGINE (Sequential Round-Robin)
// ═══════════════════════════════════════════════
async function sendWithRotation(userId, phone, message) {
    const instances = await getAvailableInstances(userId);
    if (!instances.length) return { success: false, error: 'All personal instances at limit/banned/disconnected', all_exhausted: true };

    const uId = String(userId);
    if (!personalRoundRobinIndex.has(uId)) personalRoundRobinIndex.set(uId, 0);

    let startIndex = personalRoundRobinIndex.get(uId);
    let attempts = 0;
    const total = instances.length;

    while (attempts < total) {
        let currentIndex = (startIndex + attempts) % total;
        const inst = instances[currentIndex];

        const s = getSession(inst.instance_id);
        if (s && s.status === 'connected') {
            const result = await sendMsg(inst.instance_id, phone, message);
            if (result.success) {
                await incrementMessageCount(inst.instance_id);
                // Move tracker forward for NEXT request
                personalRoundRobinIndex.set(uId, (currentIndex + 1) % total);
                return {
                    success: true,
                    instance_id: inst.instance_id,
                    instance_db_id: inst.id,
                    phone_number: inst.phone_number,
                    messages_sent_today: inst.messages_sent_today + 1,
                    daily_limit: inst.daily_message_limit,
                    rotated: total > 1
                };
            }
            if (!result.banned) {
                // Unknown error (not a ban), try next node if available
            }
        }
        attempts++;
    }

    // All active nodes failed
    return { success: false, error: 'All personal instances failed during dispatch', all_exhausted: true };
}

async function sendWithSharedRotation(phone, message) {
    const instances = await getAvailableSharedInstances();
    if (!instances.length) return { success: false, error: 'No shared instances available', all_exhausted: true };

    let attempts = 0;
    const total = instances.length;

    while (attempts < total) {
        let currentIndex = (sharedRoundRobinIndex + attempts) % total;
        const inst = instances[currentIndex];

        const s = getSession(inst.instance_id);
        if (s && s.status === 'connected') {
            const result = await sendMsg(inst.instance_id, phone, message);
            if (result.success) {
                await incrementMessageCount(inst.instance_id);
                // Move tracker forward for NEXT request
                sharedRoundRobinIndex = (currentIndex + 1) % total;
                return {
                    success: true,
                    instance_id: inst.instance_id,
                    instance_db_id: inst.id,
                    phone_number: inst.phone_number
                };
            }
            if (!result.banned) {
                // Unknown error, try next node
            }
        }
        attempts++;
    }

    return { success: false, error: 'All shared instances failed during dispatch', all_exhausted: true };
}

// ═══════════════════════════════════════════════
//  API ROUTES
// ═══════════════════════════════════════════════
app.get('/', (req, res) => res.json({ status: 'ok', service: 'OTPFlow WhatsApp', uptime: process.uptime() }));
app.get('/health', (req, res) => res.json({ status: 'ok', sessions: Object.keys(getAllSessions()).length }));

app.post('/init/:instanceId', async (req, res) => {
    try {
        await startSession(req.params.instanceId);
        const s = await waitForQr(req.params.instanceId);
        if (s?.qr) {
            const qr = await QRCode.toDataURL(s.qr);
            return res.json({ status: 'qr_ready', qr, instance_id: req.params.instanceId });
        }
        res.json({ status: s?.status || 'connecting', instance_id: req.params.instanceId });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/qr/:instanceId', async (req, res) => {
    try {
        const { instanceId } = req.params;
        let s = getSession(instanceId);

        if (!s) {
            // No session at all — start fresh
            await startSession(instanceId);
            s = await waitForQr(instanceId, 12);
        } else if (s.status === 'connecting' && !s.qr) {
            // Session exists but no QR yet — wait a bit
            s = await waitForQr(instanceId, 5);
        } else if (s.status === 'error' || s.status === 'disconnected') {
            // Dead session — restart
            try { s.socket?.end(); } catch (e) { }
            sessions.delete(instanceId);
            await startSession(instanceId);
            s = await waitForQr(instanceId, 12);
        }

        // Check for stale connecting (>60s without QR)
        if (s && s.status === 'connecting' && !s.qr) {
            const age = Date.now() - (s.createdAt || 0);
            if (age > 60000) {
                console.log(`[${instanceId}] Stale session detected (${Math.round(age / 1000)}s), forcing restart`);
                try { s.socket?.end(); } catch (e) { }
                sessions.delete(instanceId);
                await startSession(instanceId);
                s = await waitForQr(instanceId, 12);
            }
        }

        if (s?.status === 'connected') return res.json({ status: 'connected', phoneNumber: s.phoneNumber });
        if (s?.qr) {
            const qr = await QRCode.toDataURL(s.qr);
            return res.json({ status: 'qr_ready', qr });
        }

        // Return detailed status
        const age = s ? Math.round((Date.now() - (s.createdAt || Date.now())) / 1000) : 0;
        res.json({ status: s?.status || 'connecting', age_seconds: age });
    } catch (err) {
        console.error(`[/qr] Error:`, err.message);
        res.status(500).json({ status: 'error', error: err.message });
    }
});

app.get('/status/:instanceId', (req, res) => {
    const s = getSession(req.params.instanceId);
    res.json(s ? { status: s.status, instance_id: req.params.instanceId, phoneNumber: s.phoneNumber, hasQr: !!s.qr } : { status: 'disconnected', instance_id: req.params.instanceId });
});

app.get('/status', (req, res) => res.json({ sessions: getAllSessions() }));

app.post('/send', async (req, res) => {
    try {
        const { user_id, phone, message, instance_id, routing_type } = req.body;
        if (!phone || !message) return res.status(400).json({ error: 'phone and message required' });

        let result;
        if (instance_id && !user_id) {
            result = await sendMsg(instance_id, phone, message);
            if (result.success) await incrementMessageCount(instance_id);
            return res.json(result);
        }
        if (routing_type === 'wallet' || routing_type === 'shared') result = await sendWithSharedRotation(phone, message);
        else if (user_id) result = await sendWithRotation(user_id, phone, message);
        else return res.status(400).json({ error: 'user_id or instance_id required' });

        res.status(result.success ? 200 : (result.all_exhausted ? 503 : 500)).json(result);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/disconnect/:instanceId', async (req, res) => {
    try { await disconnectSession(req.params.instanceId); res.json({ success: true }); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/instances/:userId', async (req, res) => {
    try {
        const instances = await getAllInstancesForUser(req.params.userId);
        const enriched = instances.map(i => ({ ...i, live_status: getSession(i.instance_id)?.status || i.status, has_qr: !!getSession(i.instance_id)?.qr }));
        res.json({ instances: enriched });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Delete / remove an instance
app.delete('/instance/:instanceId', async (req, res) => {
    try {
        const { instanceId } = req.params;
        // Close socket if active
        const s = sessions.get(instanceId);
        if (s?.socket) {
            try { s.socket.end(); } catch (e) { }
        }
        sessions.delete(instanceId);
        // Remove from DB
        const db = getPool();
        await db.execute('DELETE FROM whatsapp_instances WHERE instance_id = ?', [instanceId]);
        res.json({ success: true, message: 'Instance removed' });
    } catch (err) {
        console.error(`[delete] Error:`, err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/create-instance', async (req, res) => {
    try {
        const { user_id } = req.body;
        if (!user_id) return res.status(400).json({ error: 'user_id required' });
        const instanceId = `wa_${user_id}_${Date.now()}`;
        await createInstanceRecord(user_id, instanceId);
        await startSession(instanceId);
        const s = await waitForQr(instanceId, 20);
        let qr = null;
        if (s?.qr) qr = await QRCode.toDataURL(s.qr);
        res.json({ success: true, instance_id: instanceId, status: s?.status || 'connecting', qr });
    } catch (err) {
        console.error(`[create-instance] Error:`, err.message);
        res.status(500).json({ status: 'error', error: err.message });
    }
});

// Force restart a stuck instance
app.post('/restart/:instanceId', async (req, res) => {
    try {
        const { instanceId } = req.params;
        const existing = sessions.get(instanceId);
        if (existing?.socket) {
            try { existing.socket.end(); } catch (e) { }
        }
        sessions.delete(instanceId);
        // Clear auth data to force fresh QR
        const db = getPool();
        await db.execute('UPDATE whatsapp_instances SET auth_creds = NULL, auth_keys = NULL, status = ? WHERE instance_id = ?', ['disconnected', instanceId]);
        await startSession(instanceId);
        const s = await waitForQr(instanceId, 20);
        let qr = null;
        if (s?.qr) qr = await QRCode.toDataURL(s.qr);
        res.json({ success: true, instance_id: instanceId, status: s?.status || 'connecting', qr });
    } catch (err) {
        console.error(`[restart] Error:`, err.message);
        res.status(500).json({ status: 'error', error: err.message });
    }
});

// ═══════════════════════════════════════════════
//  STARTUP — Dynamic import of Baileys (ESM)
// ═══════════════════════════════════════════════
async function main() {
    console.log('Loading Baileys...');
    const baileys = await import('@whiskeysockets/baileys');
    makeWASocket = baileys.default;
    DisconnectReason = baileys.DisconnectReason;
    fetchLatestBaileysVersion = baileys.fetchLatestBaileysVersion;
    initAuthCreds = baileys.initAuthCreds;
    BufferJSON = baileys.BufferJSON;
    console.log('Baileys loaded successfully!');

    // Create tables on Aiven if they don't exist
    await initDatabase();

    // Restore previously connected sessions
    try {
        const db = getPool();
        const [rows] = await db.execute(
            `SELECT instance_id FROM whatsapp_instances WHERE status IN ('connected', 'reconnecting') AND is_banned = 0 AND auth_creds IS NOT NULL`
        );
        console.log(`[Restore] Found ${rows.length} sessions to restore...`);
        for (const row of rows) {
            console.log(`[Restore] Starting: ${row.instance_id}`);
            await startSession(row.instance_id);
            await new Promise(r => setTimeout(r, 2000));
        }
    } catch (err) {
        console.error('[Restore] Error:', err.message);
    }

    app.listen(PORT, () => {
        console.log(`\n🟢 OTPFlow WhatsApp Service running on port ${PORT}`);
        console.log(`   Endpoints: /init, /send, /qr, /status, /instances\n`);
    });
}

main().catch(err => {
    console.error('FATAL:', err);
    process.exit(1);
});
