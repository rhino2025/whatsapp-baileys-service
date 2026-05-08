const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const express = require('express');
const pino = require('pino');

// 1. Global Error Handling
process.on('uncaughtException', (err) => console.error('UNCAUGHT EXCEPTION:', err));
process.on('unhandledRejection', (err) => console.error('UNHANDLED REJECTION:', err));

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const MY_PHONE_NUMBER = '905431436966';

let sock = null;
let pairingCodeRequested = false;

// --- API ROUTES ---

// Health check endpoint
app.get('/', (req, res) => res.send('WhatsApp Baileys Service Running'));

// The endpoint for your Supabase Edge Function
app.post('/api/send-message', async (req, res) => {
    const { number, message } = req.body;

    if (!sock || !sock.authState.creds.registered) {
        return res.status(503).json({ 
            ok: false, 
            error: 'WhatsApp not connected/paired yet' 
        });
    }

    try {
        // Normalize number format for WhatsApp
        const jid = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`;
        await sock.sendMessage(jid, { text: message });
        res.json({ ok: true, status: 'sent', recipient: jid });
    } catch (err) {
        console.error('Send Error:', err);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// --- WHATSAPP CONNECTION LOGIC ---

async function connectToWhatsApp() {
    console.log('=================================');
    console.log('Starting WhatsApp Service...');
    console.log('=================================');

    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();
    console.log('Using WA Version:', version);

    sock = makeWASocket({
        auth: state,
        version,
        browser: ['Ubuntu', 'Chrome', '20.0.04'],
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 0,
        markOnlineOnConnect: false,
        syncFullHistory: false,
        generateHighQualityLinkPreview: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        console.log('Connection Update:', connection);

        // Request pairing code only when connecting and not registered
        if (
            connection === 'connecting' &&
            !sock.authState.creds.registered &&
            !pairingCodeRequested
        ) {
            try {
                pairingCodeRequested = true;
                console.log('\n>>> REQUESTING PAIRING CODE...');
                
                await new Promise(resolve => setTimeout(resolve, 7000));

                const code = await sock.requestPairingCode(MY_PHONE_NUMBER);
                console.log('\n=================================');
                console.log(`   PAIRING CODE: ${code}`);
                console.log('=================================\n');
            } catch (err) {
                console.error('PAIRING ERROR:', err);
                pairingCodeRequested = false;
            }
        }

        if (connection === 'open') {
            console.log('--- WHATSAPP CONNECTED ---');
            pairingCodeRequested = false; 
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            pairingCodeRequested = false;

            if (shouldReconnect) {
                console.log('Reconnecting in 5 seconds...');
                setTimeout(connectToWhatsApp, 5000);
            }
        }
    });
}

// --- STARTUP ---

// Start API Server FIRST (Crucial for Railway health checks)
app.listen(PORT, '0.0.0.0', () => {
    console.log(`API Server running on port ${PORT}`);
    
    // Start WhatsApp in background
    connectToWhatsApp().catch(err => console.error('STARTUP ERROR:', err));
});