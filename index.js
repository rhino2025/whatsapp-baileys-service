const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const express = require('express');
const qrcode = require('qrcode-terminal');
const app = express();

app.use(express.json());

let sock;
const PORT = process.env.PORT || 3000;
const AUTH_SECRET = process.env.AUTH_SECRET || 'your-secure-shared-secret';

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    // 1. Fetch the exact, up-to-date version accepted by the WhatsApp servers
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`Using WA version: ${version.join('.')} (Is latest: ${isLatest})`);

    sock = makeWASocket({
        auth: state,
        version,
        // Mimicking a MacOS platform forces WhatsApp to bypass certain pairing restrictions
        browser: ['Mac OS', 'Chrome', '122.0.0.0'],
        defaultQueryTimeoutMs: undefined
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('\n--- SCAN BELOW ---');
            // 'small: true' uses special block characters that scan much better on Railway
            qrcode.generate(qr, { small: true });
            console.log('--- END QR ---\n');
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            console.log(`Connection closed (Reason code: ${statusCode}). Reconnecting: ${shouldReconnect}`);
            
            if (shouldReconnect) {
                // Wait a few seconds before retrying to prevent rapid spamming loops
                setTimeout(() => {
                    connectToWhatsApp();
                }, 5000);
            }
        } else if (connection === 'open') {
            console.log('\n=============================================');
            console.log('--- WHATSAPP CONNECTION ACTIVE ---');
            console.log('=============================================\n');
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

// REST API Endpoint
app.post('/send-message', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (authHeader !== `Bearer ${AUTH_SECRET}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { phone, message } = req.body;
    if (!phone || !message) {
        return res.status(400).json({ error: 'Missing phone or message fields.' });
    }

    try {
        const formattedPhone = `${phone.replace(/\D/g, '')}@s.whatsapp.net`;
        await sock.sendMessage(formattedPhone, { text: message });
        return res.status(200).json({ success: true, message: 'Message sent successfully.' });
    } catch (err) {
        console.error('Failed to send WhatsApp message:', err);
        return res.status(500).json({ error: 'Failed to send message.' });
    }
});

connectToWhatsApp().then(() => {
    app.listen(PORT, () => console.log(`Service listening on port ${PORT}`));
});