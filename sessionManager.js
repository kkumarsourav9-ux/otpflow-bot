/**
 * sessionManager.js — Manages multiple Baileys WhatsApp connections
 * Handles connection lifecycle, QR generation, ban detection, and auto-reconnect
 */

const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const { useDBAuthState, updateInstanceStatus, markBanned } = require('./dbStore');

const logger = pino({ level: process.env.LOG_LEVEL || 'silent' });

// Active socket connections: instanceId -> { socket, qr, status }
const sessions = new Map();

/**
 * Initialize a WhatsApp session for a given instance
 */
async function startSession(instanceId) {
    // Don't start duplicate sessions
    if (sessions.has(instanceId)) {
        const existing = sessions.get(instanceId);
        if (existing.status === 'connected' || existing.status === 'connecting') {
            return existing;
        }
    }

    const session = { socket: null, qr: null, status: 'connecting', phoneNumber: null };
    sessions.set(instanceId, session);

    try {
        const { state, saveCreds } = await useDBAuthState(instanceId);
        const { version } = await fetchLatestBaileysVersion();

        const socket = makeWASocket({
            version,
            auth: state,
            logger,
            printQRInTerminal: false,
            browser: ['OTPFlow', 'Chrome', '120.0'],
            connectTimeoutMs: 60000,
            markOnlineOnConnect: false,
            generateHighQualityLinkPreview: false
        });

        session.socket = socket;

        // Handle credentials update (save to DB)
        socket.ev.on('creds.update', saveCreds);

        // Handle connection updates
        socket.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                session.qr = qr;
                session.status = 'qr_ready';
                console.log(`[${instanceId}] QR code generated, waiting for scan...`);
            }

            if (connection === 'open') {
                session.status = 'connected';
                session.qr = null;

                // Extract phone number from socket
                const phoneNumber = socket.user?.id?.split(':')[0] || socket.user?.id?.split('@')[0] || null;
                session.phoneNumber = phoneNumber;

                await updateInstanceStatus(instanceId, 'connected', phoneNumber);
                console.log(`[${instanceId}] Connected! Phone: ${phoneNumber}`);
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const reason = lastDisconnect?.error?.output?.payload?.message || 'Unknown';

                console.log(`[${instanceId}] Disconnected: ${statusCode} - ${reason}`);

                // Check if banned (401, 403, 515 are common ban codes)
                if ([401, 403, 515].includes(statusCode)) {
                    session.status = 'banned';
                    await markBanned(instanceId);
                    sessions.delete(instanceId);
                    console.log(`[${instanceId}] BANNED! Marked in database.`);
                    return;
                }

                // Check if logged out manually
                if (statusCode === DisconnectReason.loggedOut) {
                    session.status = 'disconnected';
                    await updateInstanceStatus(instanceId, 'disconnected');
                    sessions.delete(instanceId);
                    console.log(`[${instanceId}] Logged out. Session cleared.`);
                    return;
                }

                // Auto-reconnect for temporary failures
                session.status = 'reconnecting';
                await updateInstanceStatus(instanceId, 'reconnecting');
                console.log(`[${instanceId}] Reconnecting in 5s...`);
                setTimeout(() => startSession(instanceId), 5000);
            }
        });

        return session;
    } catch (err) {
        console.error(`[${instanceId}] Failed to start session:`, err.message);
        session.status = 'error';
        await updateInstanceStatus(instanceId, 'disconnected');
        return session;
    }
}

/**
 * Send a message via a specific instance
 */
async function sendMessage(instanceId, phone, message) {
    const session = sessions.get(instanceId);

    if (!session || session.status !== 'connected') {
        return { success: false, error: 'Instance not connected' };
    }

    try {
        // Format phone number for WhatsApp (remove + and add @s.whatsapp.net)
        const jid = phone.replace(/[^0-9]/g, '') + '@s.whatsapp.net';

        await session.socket.sendMessage(jid, { text: message });
        return { success: true };
    } catch (err) {
        console.error(`[${instanceId}] Send failed:`, err.message);

        // Check if send failure indicates a ban
        if (err.message?.includes('banned') || err.message?.includes('blocked')) {
            await markBanned(instanceId);
            session.status = 'banned';
            return { success: false, error: 'Instance banned', banned: true };
        }

        return { success: false, error: err.message };
    }
}

/**
 * Get session info for an instance
 */
function getSession(instanceId) {
    return sessions.get(instanceId) || null;
}

/**
 * Disconnect a specific instance
 */
async function disconnectSession(instanceId) {
    const session = sessions.get(instanceId);
    if (session && session.socket) {
        try {
            await session.socket.logout();
        } catch (e) {
            // Ignore logout errors
        }
        session.socket.end();
    }
    sessions.delete(instanceId);
    await updateInstanceStatus(instanceId, 'disconnected');
}

/**
 * Get all active session statuses
 */
function getAllSessions() {
    const result = {};
    for (const [id, session] of sessions) {
        result[id] = {
            status: session.status,
            qr: session.qr ? true : false,
            phoneNumber: session.phoneNumber
        };
    }
    return result;
}

/**
 * Restore all previously connected sessions from the database on startup
 */
async function restoreAllSessions() {
    const { getPool } = require('./dbStore');
    const db = getPool();

    try {
        const [rows] = await db.execute(
            `SELECT instance_id FROM whatsapp_instances 
             WHERE status IN ('connected', 'reconnecting') AND is_banned = 0 AND auth_creds IS NOT NULL`
        );

        console.log(`[Restore] Found ${rows.length} sessions to restore...`);

        for (const row of rows) {
            console.log(`[Restore] Starting session: ${row.instance_id}`);
            await startSession(row.instance_id);
            // Small delay between reconnections to avoid overwhelming
            await new Promise(r => setTimeout(r, 2000));
        }

        console.log(`[Restore] All sessions restored.`);
    } catch (err) {
        console.error('[Restore] Failed to restore sessions:', err.message);
    }
}

module.exports = {
    startSession,
    sendMessage,
    getSession,
    disconnectSession,
    getAllSessions,
    restoreAllSessions
};
