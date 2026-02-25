/**
 * rotationEngine.js — Smart WhatsApp instance selection with auto-rotation
 * Picks the best available instance based on daily limits, ban status, and load balancing
 */

const { getAvailableInstances, getAvailableSharedInstances, incrementMessageCount } = require('./dbStore');
const { sendMessage, getSession } = require('./sessionManager');

/**
 * Send a message using the best available personal instance for a user
 * Auto-rotates to next instance if current one is at limit or banned
 * 
 * @param {number} userId - The user ID
 * @param {string} phone - Phone number to send to
 * @param {string} message - Message text
 * @returns {object} Result with success status, instance used, and rotation info
 */
async function sendWithRotation(userId, phone, message) {
    const instances = await getAvailableInstances(userId);

    if (instances.length === 0) {
        return {
            success: false,
            error: 'All WhatsApp instances are either at their daily limit, banned, or disconnected.',
            all_exhausted: true
        };
    }

    // Try each instance in order (sorted by priority ASC, messages_sent_today ASC)
    for (const instance of instances) {
        const session = getSession(instance.instance_id);

        // Skip instances that aren't actually connected in memory
        if (!session || session.status !== 'connected') {
            continue;
        }

        const result = await sendMessage(instance.instance_id, phone, message);

        if (result.success) {
            // Track the message count
            await incrementMessageCount(instance.instance_id);

            return {
                success: true,
                instance_id: instance.instance_id,
                instance_db_id: instance.id,
                phone_number: instance.phone_number,
                messages_sent_today: instance.messages_sent_today + 1,
                daily_limit: instance.daily_message_limit,
                rotated: instances[0].instance_id !== instance.instance_id
            };
        }

        // If banned during send, continue to next instance
        if (result.banned) {
            console.log(`[Rotation] Instance ${instance.instance_id} banned during send, trying next...`);
            continue;
        }

        // For other send errors, still try next instance
        console.log(`[Rotation] Instance ${instance.instance_id} failed: ${result.error}, trying next...`);
    }

    return {
        success: false,
        error: 'All available instances failed to send the message.',
        all_exhausted: true
    };
}

/**
 * Send a message using a shared/company instance (for wallet-based routing)
 * Same rotation logic but uses company shared instances
 */
async function sendWithSharedRotation(phone, message) {
    const instances = await getAvailableSharedInstances();

    if (instances.length === 0) {
        return {
            success: false,
            error: 'No shared WhatsApp instances available.',
            all_exhausted: true
        };
    }

    for (const instance of instances) {
        const session = getSession(instance.instance_id);

        if (!session || session.status !== 'connected') {
            continue;
        }

        const result = await sendMessage(instance.instance_id, phone, message);

        if (result.success) {
            await incrementMessageCount(instance.instance_id);
            return {
                success: true,
                instance_id: instance.instance_id,
                instance_db_id: instance.id,
                phone_number: instance.phone_number,
                messages_sent_today: instance.messages_sent_today + 1,
                daily_limit: instance.daily_message_limit
            };
        }

        if (result.banned) continue;
    }

    return {
        success: false,
        error: 'All shared instances failed to send.',
        all_exhausted: true
    };
}

module.exports = {
    sendWithRotation,
    sendWithSharedRotation
};
