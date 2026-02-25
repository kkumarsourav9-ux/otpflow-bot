const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');

const app = express();
app.use(express.json());

// In a full multi-tenant SaaS, you would manage an array/map of clients dynamically.
// For InfinityFree bridge simplicity & memory limits, we demonstrate a single shared Company bot instance.
// It can easily be extended to Map<String, Client> if hosted on a larger VPS.
let qrCodeData = null;
let isReady = false;

const client = new Client({
    authStrategy: new LocalAuth({ clientId: "default_shared" }),
    puppeteer: {
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

client.on('qr', (qr) => {
    // Generate QR code base64 so PHP interface can grab it easily via API
    qrcode.toDataURL(qr, (err, url) => {
        qrCodeData = url;
        console.log('QR Code generated. Waiting for scan...');
    });
});

client.on('ready', () => {
    console.log('WhatsApp Client is READY!');
    isReady = true;
    qrCodeData = null; // Clear QR once authenticated
});

client.on('disconnected', (reason) => {
    console.log('Client was logged out', reason);
    isReady = false;
});

// Start WhatsApp Client
client.initialize();

// -- EXPOSED API ENDPOINTS FOR PHP FRONTEND --

// 1. Get Status / QR Code Endpoint
app.get('/status', (req, res) => {
    if (isReady) {
        return res.json({ status: 'connected' });
    } else if (qrCodeData) {
        return res.json({ status: 'qr_ready', qr: qrCodeData });
    } else {
        return res.json({ status: 'starting' });
    }
});

// 2. Send Message Webhook
app.post('/send', async (req, res) => {
    const { phone, message, instance_id } = req.body;

    if (!phone || !message) {
        return res.status(400).json({ error: 'Phone and message are required' });
    }

    if (!isReady) {
        return res.status(503).json({ error: 'WhatsApp instance is not connected' });
    }

    try {
        // whatsapp-web.js uses number@c.us format
        // strip non-numeric characters
        const cleanPhone = phone.replace(/\D/g, '');
        const chatId = `${cleanPhone}@c.us`;

        const response = await client.sendMessage(chatId, message);
        return res.json({ success: true, messageId: response.id._serialized });
    } catch (error) {
        console.error('Failed to send message:', error);
        return res.status(500).json({ error: 'Failed to dispatch via WhatsApp' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`WhatsApp Microservice listening on port ${PORT}`);
});
