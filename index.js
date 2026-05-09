const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const express = require('express');
const pino = require('pino');
const axios = require('axios');
const fs = require('fs');

const app = express();
app.use(express.json());

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;
const MY_PHONE_NUMBER = process.env.MY_PHONE_NUMBER || '905431436966';
const LOVABLE_WEBHOOK_URL = 'https://azzyfkdywswhfaqbguev.supabase.co/functions/v1/whatsapp-webhook';

const API_KEY = process.env.API_KEY; 
const WHATSAPP_WEBHOOK_API_KEY = process.env.WHATSAPP_WEBHOOK_API_KEY;

let sock = null;
let pairingCodeRequested = false;

// --- SESSION MANAGEMENT ---
// Clears session only if RESET_SESSION variable is set in Railway
if (process.env.RESET_SESSION) {
    console.log('--- RESET TRIGGERED: Purging Session Files ---');
    if (fs.existsSync('./auth_info_baileys')) {
        fs.rmSync('./auth_info_baileys', { recursive: true, force: true });
    }
}

// --- OUTBOUND: LOVABLE -> RAILWAY ---
app.post('/api/send-message', async (req, res) => {
    const clientKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
    
    if (clientKey !== API_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { number, message, lid } = req.body;
    if ((!number && !lid) || !message) return res.status(400).json({ error: 'Missing data' });

    try {
        let jid;
        
        // PRIORITY: Use LID if provided by Lovable (Guaranteed delivery)
        if (lid || (number && number.startsWith('1') && number.length > 12)) {
            const targetId = lid || number;
            jid = `${targetId.replace(/\D/g, '')}@s.whatsapp.net`;
            console.log(`📤 Outbound (LID Mode): ${jid}`);
        } else {
            // FALLBACK: Standard phone cleaning
            const cleanNumber = number.replace(/\D/g, '').replace(/^0/, '90');
            jid = `${cleanNumber}@s.whatsapp.net`;
            console.log(`📤 Outbound (Phone Mode): ${jid}`);
        }

        await sock.sendMessage(jid, { text: message });
        res.json({ ok: true });
    } catch (err) {
        console.error('❌ Send Error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// --- WHATSAPP CONNECTION ---
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        auth: state,
        version,
        browser: ['Ubuntu', 'Chrome', '20.0.04'],
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        // Stability settings for Railway environments
        keepAliveIntervalMs: 30000,
        defaultQueryTimeoutMs: 0, 
        connectTimeoutMs: 60000,
    });

    sock.ev.on('creds.update', saveCreds);

    // --- INBOUND: WHATSAPP -> LOVABLE ---
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        try {
            if (type !== 'notify') return;
            const msg = messages[0];
            if (!msg.message || msg.key.fromMe) return;

            // 1. Capture raw LID
            const rawLid = msg.key.remoteJid.split('@')[0];
            
            // 2. Extract real phone number if hidden in JID string
            let realPhone = null;
            if (msg.key.remoteJid.includes(':')) {
                realPhone = msg.key.remoteJid.split(':')[0];
            } else if (msg.key.participant) {
                const part = msg.key.participant.split('@')[0];
                if (!part.startsWith('1')) realPhone = part;
            }

            const displayNumber = realPhone || rawLid;
            const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || 'Media Message';

            console.log(`📩 Inbound: ${displayNumber} | LID: ${rawLid}`);

            await axios.post(LOVABLE_WEBHOOK_URL, {
                number: displayNumber,
                raw_lid: rawLid,
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
        } catch (err) {
            console.error('❌ Inbound Webhook Failed:', err.message);
        }
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'connecting') {
            if (!sock.authState.creds.registered && !pairingCodeRequested) {
                pairingCodeRequested = true;
                // Brief delay to ensure socket is ready for pairing request
                setTimeout(async () => {
                    try {
                        const code = await sock.requestPairingCode(MY_PHONE_NUMBER.replace(/\D/g, ''));
                        console.log(`\n🔗 PAIRING CODE: ${code}\n`);
                    } catch (e) { 
                        console.error('Pairing Error:', e.message);
                        pairingCodeRequested = false; 
                    }
                }, 7000);
            }
        }

        if (connection === 'open') {
            console.log('🚀 WHATSAPP READY');
            pairingCodeRequested = false;
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            pairingCodeRequested = false;
            if (statusCode !== DisconnectReason.loggedOut) {
                console.log('Connection lost. Reconnecting...');
                setTimeout(connectToWhatsApp, 5000);
            } else {
                console.log('Logged out. Please delete session and repair.');
            }
        }
    });
}

// --- INITIALIZE ---
app.get('/', (req, res) => res.send('WhatsApp Bridge Active'));

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on port ${PORT}`);
    connectToWhatsApp().catch(console.error);
});