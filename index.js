const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const express = require('express');
const pino = require('pino');
const axios = require('axios'); // Added axios for more robust error handling

// ================================
// GLOBAL ERROR HANDLING
// ================================
process.on('uncaughtException', (err) => console.error('UNCAUGHT EXCEPTION:', err));
process.on('unhandledRejection', (err) => console.error('UNHANDLED REJECTION:', err));

// ================================
// EXPRESS SETUP
// ================================
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const MY_PHONE_NUMBER = '905431436966';

// Security Keys
const API_KEY = process.env.API_KEY; // For Outbound: Lovable -> Railway
const WHATSAPP_WEBHOOK_API_KEY = process.env.WHATSAPP_WEBHOOK_API_KEY; // For Inbound: Railway -> Supabase

// Lovable webhook URL
const LOVABLE_WEBHOOK_URL = 'https://azzyfkdywswhfaqbguev.supabase.co/functions/v1/whatsapp-webhook';

let sock = null;
let pairingCodeRequested = false;

// ================================
// API ROUTES
// ================================

app.get('/', (req, res) => {
    res.send('WhatsApp Baileys Service Running');
});

// Outbound: Send message endpoint (Lovable calls this)
app.post('/api/send-message', async (req, res) => {
    const clientKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
    
    if (clientKey !== API_KEY) {
        return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    const { number, message } = req.body;
    if (!number || !message) {
        return res.status(400).json({ ok: false, error: 'number and message required' });
    }

    if (!sock || !sock.authState.creds.registered) {
        return res.status(503).json({ ok: false, error: 'WhatsApp not connected yet' });
    }

    try {
        const cleanNumber = number.replace(/\D/g, '').replace(/^0/, '90');
        const jid = cleanNumber.includes('@s.whatsapp.net') ? cleanNumber : `${cleanNumber}@s.whatsapp.net`;

        await sock.sendMessage(jid, { text: message });
        console.log(`📤 OUTGOING MESSAGE → ${cleanNumber}: ${message}`);

        res.json({ ok: true, status: 'sent', recipient: jid });
    } catch (err) {
        console.error('SEND ERROR:', err);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ================================
// WHATSAPP CONNECTION
// ================================

async function connectToWhatsApp() {
    console.log('=================================');
    console.log('Starting WhatsApp Service...');
    console.log('=================================');

    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        auth: state,
        version,
        browser: ['Ubuntu', 'Chrome', '20.0.04'],
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        connectTimeoutMs: 60000,
    });

    sock.ev.on('creds.update', saveCreds);

    // ================================
    // INCOMING MESSAGES (Forward to Supabase)
    // ================================
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        try {
            if (type !== 'notify') return;
            const msg = messages[0];
            if (!msg.message || msg.key.fromMe) return;

            const remoteJid = msg.key.remoteJid;
            if (remoteJid.includes('@g.us')) return;

            const number = remoteJid.replace('@s.whatsapp.net', '');
            const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';

            if (!text) return;

            console.log(`📩 INCOMING FROM ${number}: ${text}`);

            // Forward to Supabase using both header styles to prevent 401 errors
            const response = await axios.post(LOVABLE_WEBHOOK_URL, {
                number,
                message: text,
                timestamp: Date.now(),
                direction: 'incoming'
            }, {
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': WHATSAPP_WEBHOOK_API_KEY,
                    'Authorization': `Bearer ${WHATSAPP_WEBHOOK_API_KEY}`
                }
            });

            console.log('✅ Webhook success:', response.data);

        } catch (err) {
            console.error('❌ WHATSAPP WEBHOOK ERROR:', err.response?.status || 'No Response');
            console.error('❌ ERROR BODY:', err.response?.data || err.message);
        }
    });

    // ================================
    // CONNECTION EVENTS
    // ================================
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        console.log('Connection Update:', connection);

        if (connection === 'connecting' && !sock.authState.creds.registered && !pairingCodeRequested) {
            try {
                pairingCodeRequested = true;
                console.log('\n>>> REQUESTING PAIRING CODE...');
                await new Promise(resolve => setTimeout(resolve, 7000));
                const code = await sock.requestPairingCode(MY_PHONE_NUMBER);
                console.log('\n=================================');
                console.log(`PAIRING CODE: ${code}`);
                console.log('=================================\n');
            } catch (err) {
                console.error('PAIRING ERROR:', err);
                pairingCodeRequested = false;
            }
        }

        if (connection === 'open') {
            console.log('\n--- WHATSAPP CONNECTED ---\n');
            pairingCodeRequested = false;
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            pairingCodeRequested = false;
            if (shouldReconnect) {
                console.log('Reconnecting in 5 seconds...\n');
                setTimeout(connectToWhatsApp, 5000);
            }
        }
    });
}

// ================================
// START SERVER
// ================================
app.listen(PORT, '0.0.0.0', () => {
    console.log(`API Server running on port ${PORT}`);
    connectToWhatsApp().catch(err => console.error('STARTUP ERROR:', err));
});