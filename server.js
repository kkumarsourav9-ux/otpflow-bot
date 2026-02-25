/**
 * index.js — Express REST API for multi-WhatsApp service
 * Endpoints for session management, QR codes, sending messages with auto-rotation
 */

const express = require('express');
const QRCode = require('qrcode');
const { startSession, getSession, disconnectSession, getAllSessions, restoreAllSessions } = require('./sessionManager');
const { sendWithRotation, sendWithSharedRotation } = require('./rotationEngine');
const { getAllInstancesForUser, createInstance, getPool } = require('./dbStore');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ──────────────────────────────────────────────
//  Health Check (also keeps Render from sleeping when pinged)
// ──────────────────────────────────────────────
app.get('/', (req, res) => {
    res.json({ status: 'ok', service: 'OTPFlow WhatsApp Service', uptime: process.uptime() });
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', sessions: Object.keys(getAllSessions()).length });
});

// ──────────────────────────────────────────────
//  Initialize a new WhatsApp session
// ──────────────────────────────────────────────
app.post('/init/:instanceId', async (req, res) => {
    try {
        const { instanceId } = req.params;
        const session = await startSession(instanceId);

        // Wait for QR to generate (Baileys can take up to 10s)
        for (let i = 0; i < 10; i++) {
            await new Promise(r => setTimeout(r, 1000));
            const s = getSession(instanceId);
            if (s?.qr || s?.status === 'connected') break;
        }

        const currentSession = getSession(instanceId);
        if (currentSession?.qr) {
            const qrDataUrl = await QRCode.toDataURL(currentSession.qr);
            return res.json({
                status: 'qr_ready',
                qr: qrDataUrl,
                instance_id: instanceId
            });
        }

        res.json({
            status: currentSession?.status || 'connecting',
            instance_id: instanceId
        });
    } catch (err) {
        console.error('Init error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ──────────────────────────────────────────────
//  Get QR code for an instance
// ──────────────────────────────────────────────
app.get('/qr/:instanceId', async (req, res) => {
    try {
        const { instanceId } = req.params;
        const session = getSession(instanceId);

        if (!session) {
            // Try to start the session if not running
            await startSession(instanceId);
            for (let i = 0; i < 8; i++) {
                await new Promise(r => setTimeout(r, 1000));
                const s = getSession(instanceId);
                if (s?.qr || s?.status === 'connected') break;
            }
            const newSession = getSession(instanceId);

            if (newSession?.qr) {
                const qrDataUrl = await QRCode.toDataURL(newSession.qr);
                return res.json({ status: 'qr_ready', qr: qrDataUrl });
            }
            return res.json({ status: newSession?.status || 'connecting' });
        }

        if (session.status === 'connected') {
            return res.json({ status: 'connected', phoneNumber: session.phoneNumber });
        }

        if (session.qr) {
            const qrDataUrl = await QRCode.toDataURL(session.qr);
            return res.json({ status: 'qr_ready', qr: qrDataUrl });
        }

        res.json({ status: session.status });
    } catch (err) {
        console.error('QR error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ──────────────────────────────────────────────
//  Get status of a specific instance
// ──────────────────────────────────────────────
app.get('/status/:instanceId', (req, res) => {
    const session = getSession(req.params.instanceId);
    if (!session) {
        return res.json({ status: 'disconnected', instance_id: req.params.instanceId });
    }
    res.json({
        status: session.status,
        instance_id: req.params.instanceId,
        phoneNumber: session.phoneNumber,
        hasQr: !!session.qr
    });
});

// ──────────────────────────────────────────────
//  Get status of all active sessions  
// ──────────────────────────────────────────────
app.get('/status', (req, res) => {
    res.json({ sessions: getAllSessions() });
});

// ──────────────────────────────────────────────
//  Send a message with auto-rotation (personal instances)
// ──────────────────────────────────────────────
app.post('/send', async (req, res) => {
    try {
        const { user_id, phone, message, instance_id, routing_type } = req.body;

        if (!phone || !message) {
            return res.status(400).json({ error: 'phone and message are required' });
        }

        let result;

        // If a specific instance is requested (legacy single-instance mode)
        if (instance_id && !user_id) {
            const { sendMessage } = require('./sessionManager');
            const { incrementMessageCount } = require('./dbStore');
            result = await sendMessage(instance_id, phone, message);
            if (result.success) {
                await incrementMessageCount(instance_id);
            }
            return res.json(result);
        }

        // Shared/company routing
        if (routing_type === 'wallet' || routing_type === 'shared') {
            result = await sendWithSharedRotation(phone, message);
        }
        // Personal instance routing with auto-rotation
        else if (user_id) {
            result = await sendWithRotation(user_id, phone, message);
        }
        else {
            return res.status(400).json({ error: 'user_id or instance_id is required' });
        }

        if (result.success) {
            return res.json(result);
        }

        const statusCode = result.all_exhausted ? 503 : 500;
        return res.status(statusCode).json(result);

    } catch (err) {
        console.error('Send error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ──────────────────────────────────────────────
//  Disconnect a specific instance
// ──────────────────────────────────────────────
app.post('/disconnect/:instanceId', async (req, res) => {
    try {
        await disconnectSession(req.params.instanceId);
        res.json({ success: true, message: 'Instance disconnected' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ──────────────────────────────────────────────
//  List all instances for a user (called by PHP dashboard)
// ──────────────────────────────────────────────
app.get('/instances/:userId', async (req, res) => {
    try {
        const instances = await getAllInstancesForUser(req.params.userId);

        // Enrich with in-memory session status
        const enriched = instances.map(inst => {
            const session = getSession(inst.instance_id);
            return {
                ...inst,
                live_status: session?.status || inst.status,
                has_qr: !!(session?.qr)
            };
        });

        res.json({ instances: enriched });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ──────────────────────────────────────────────
//  Create a new instance record and start session
// ──────────────────────────────────────────────
app.post('/create-instance', async (req, res) => {
    try {
        const { user_id } = req.body;
        if (!user_id) {
            return res.status(400).json({ error: 'user_id is required' });
        }

        // Generate unique instance ID
        const instanceId = `wa_${user_id}_${Date.now()}`;

        // Create DB record
        await createInstance(user_id, instanceId);

        // Start WhatsApp session to generate QR
        await startSession(instanceId);
        for (let i = 0; i < 10; i++) {
            await new Promise(r => setTimeout(r, 1000));
            const s = getSession(instanceId);
            if (s?.qr || s?.status === 'connected') break;
        }

        const session = getSession(instanceId);
        let qrDataUrl = null;

        if (session?.qr) {
            qrDataUrl = await QRCode.toDataURL(session.qr);
        }

        res.json({
            success: true,
            instance_id: instanceId,
            status: session?.status || 'connecting',
            qr: qrDataUrl
        });
    } catch (err) {
        console.error('Create instance error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ──────────────────────────────────────────────
//  Start server and restore sessions
// ──────────────────────────────────────────────
app.listen(PORT, async () => {
    console.log(`\n🟢 OTPFlow WhatsApp Service running on port ${PORT}`);
    console.log(`   Endpoints: /init, /send, /qr, /status, /instances\n`);

    // Restore previously connected sessions from database
    try {
        await restoreAllSessions();
    } catch (err) {
        console.error('Failed to restore sessions on startup:', err.message);
    }
});
