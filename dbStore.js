/**
 * dbStore.js — MySQL-backed auth state store for Baileys
 * Replaces file-based useMultiFileAuthState so sessions persist across Render spin-downs
 */

const mysql = require('mysql2/promise');

let pool = null;

function getPool() {
    if (!pool) {
        pool = mysql.createPool({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASS || '',
            database: process.env.DB_NAME || 'whatsapp_otp_saas',
            waitForConnections: true,
            connectionLimit: 10,
            charset: 'utf8mb4'
        });
    }
    return pool;
}

/**
 * Save auth credentials to the database
 */
async function saveCreds(instanceId, creds) {
    const db = getPool();
    await db.execute(
        'UPDATE whatsapp_instances SET auth_creds = ? WHERE instance_id = ?',
        [JSON.stringify(creds), instanceId]
    );
}

/**
 * Load auth credentials from the database
 */
async function loadCreds(instanceId) {
    const db = getPool();
    const [rows] = await db.execute(
        'SELECT auth_creds FROM whatsapp_instances WHERE instance_id = ?',
        [instanceId]
    );
    if (rows.length && rows[0].auth_creds) {
        return typeof rows[0].auth_creds === 'string'
            ? JSON.parse(rows[0].auth_creds)
            : rows[0].auth_creds;
    }
    return null;
}

/**
 * Save auth keys to the database
 */
async function saveKeys(instanceId, keys) {
    const db = getPool();
    await db.execute(
        'UPDATE whatsapp_instances SET auth_keys = ? WHERE instance_id = ?',
        [JSON.stringify(keys), instanceId]
    );
}

/**
 * Load auth keys from the database
 */
async function loadKeys(instanceId) {
    const db = getPool();
    const [rows] = await db.execute(
        'SELECT auth_keys FROM whatsapp_instances WHERE instance_id = ?',
        [instanceId]
    );
    if (rows.length && rows[0].auth_keys) {
        return typeof rows[0].auth_keys === 'string'
            ? JSON.parse(rows[0].auth_keys)
            : rows[0].auth_keys;
    }
    return null;
}

/**
 * Create a Baileys-compatible auth state backed by MySQL
 */
async function useDBAuthState(instanceId) {
    const creds = (await loadCreds(instanceId)) || {};
    const keys = (await loadKeys(instanceId)) || {};

    return {
        state: {
            creds,
            keys: {
                get: (type, ids) => {
                    const data = {};
                    for (const id of ids) {
                        const key = `${type}-${id}`;
                        if (keys[key]) data[id] = keys[key];
                    }
                    return data;
                },
                set: async (data) => {
                    for (const category in data) {
                        for (const id in data[category]) {
                            const key = `${category}-${id}`;
                            keys[key] = data[category][id];
                        }
                    }
                    await saveKeys(instanceId, keys);
                }
            }
        },
        saveCreds: async () => {
            await saveCreds(instanceId, creds);
        }
    };
}

/**
 * Update instance status in DB
 */
async function updateInstanceStatus(instanceId, status, phoneNumber = null) {
    const db = getPool();
    const fields = ['status = ?', 'last_ping = NOW()'];
    const values = [status];

    if (phoneNumber) {
        fields.push('phone_number = ?');
        values.push(phoneNumber);
    }

    values.push(instanceId);
    await db.execute(
        `UPDATE whatsapp_instances SET ${fields.join(', ')} WHERE instance_id = ?`,
        values
    );
}

/**
 * Mark instance as banned
 */
async function markBanned(instanceId) {
    const db = getPool();
    await db.execute(
        'UPDATE whatsapp_instances SET is_banned = 1, status = ? WHERE instance_id = ?',
        ['banned', instanceId]
    );
}

/**
 * Increment messages_sent_today for an instance, reset if new day
 */
async function incrementMessageCount(instanceId) {
    const db = getPool();
    const today = new Date().toISOString().split('T')[0];

    // Reset counter if it's a new day
    await db.execute(
        `UPDATE whatsapp_instances 
         SET messages_sent_today = CASE 
             WHEN last_reset_date IS NULL OR last_reset_date < ? THEN 1 
             ELSE messages_sent_today + 1 
         END,
         last_reset_date = ?
         WHERE instance_id = ?`,
        [today, today, instanceId]
    );
}

/**
 * Get all connected, non-banned instances for a user with available capacity
 */
async function getAvailableInstances(userId) {
    const db = getPool();
    const today = new Date().toISOString().split('T')[0];

    const [rows] = await db.execute(
        `SELECT id, instance_id, phone_number, daily_message_limit, messages_sent_today, 
                last_reset_date, priority
         FROM whatsapp_instances 
         WHERE user_id = ? 
           AND status = 'connected' 
           AND is_banned = 0
         ORDER BY priority ASC, messages_sent_today ASC`,
        [userId]
    );

    // Reset counts for new day and filter by capacity
    return rows.map(row => {
        const effectiveCount = (row.last_reset_date && row.last_reset_date >= today)
            ? row.messages_sent_today
            : 0;
        return { ...row, messages_sent_today: effectiveCount };
    }).filter(row => row.messages_sent_today < row.daily_message_limit);
}

/**
 * Get all instances for a user (regardless of status)
 */
async function getAllInstancesForUser(userId) {
    const db = getPool();
    const [rows] = await db.execute(
        `SELECT id, instance_id, phone_number, status, is_banned, 
                daily_message_limit, messages_sent_today, last_reset_date, last_ping
         FROM whatsapp_instances 
         WHERE user_id = ?
         ORDER BY priority ASC`,
        [userId]
    );
    return rows;
}

/**
 * Get all company shared instances with available capacity
 */
async function getAvailableSharedInstances() {
    const db = getPool();
    const today = new Date().toISOString().split('T')[0];

    const [rows] = await db.execute(
        `SELECT id, instance_id, phone_number, daily_message_limit, messages_sent_today, last_reset_date
         FROM whatsapp_instances 
         WHERE is_company_shared = 1 
           AND status = 'connected' 
           AND is_banned = 0
         ORDER BY messages_sent_today ASC`
    );

    return rows.map(row => {
        const effectiveCount = (row.last_reset_date && row.last_reset_date >= today)
            ? row.messages_sent_today
            : 0;
        return { ...row, messages_sent_today: effectiveCount };
    }).filter(row => row.messages_sent_today < row.daily_message_limit);
}

/**
 * Create a new instance record in the database
 */
async function createInstance(userId, instanceId) {
    const db = getPool();
    await db.execute(
        `INSERT INTO whatsapp_instances (user_id, instance_id, status) VALUES (?, ?, 'disconnected')`,
        [userId, instanceId]
    );
}

module.exports = {
    getPool,
    useDBAuthState,
    updateInstanceStatus,
    markBanned,
    incrementMessageCount,
    getAvailableInstances,
    getAllInstancesForUser,
    getAvailableSharedInstances,
    createInstance
};
