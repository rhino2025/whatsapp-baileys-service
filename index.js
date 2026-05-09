const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const express = require('express');
const pino = require('pino');
const axios = require('axios');

// ================================
// GLOBAL ERROR HANDLING
// ================================
process.on('uncaughtException', (err) => console.error('UNCAUGHT EXCEPTION:', err));
process.on('unhandledRejection', (err) => console.error('UNHANDLED REJECTION:', err));

const app = express();
app.use(express.json());

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;
const MY_PHONE_NUMBER = process.env.MY_PHONE_NUMBER || '905431436966';
const LOVABLE_WEBHOOK_URL = 'https://azzyfkdywswhfaqbguev.supabase.co/functions/v1/whatsapp-webhook';

// Keys from Railway Variables
const API_KEY = process.env.API_KEY; 
const WHATSAPP_WEBHOOK_API_KEY = process.env.WHATSAPP_WEBHOOK_API_KEY;

let sock = null;
let pairingCodeRequested = false;

// ================================
// API ROUTES
// ================================

app.get('/', (req, res) => res.send('WhatsApp Service Online'));

// --- OUTBOUND: LOVABLE -> RAILWAY (Dashboard sending a message) ---
app.post('/api/send-message', async (req, res) => {
    // Extract key from either header style
    const clientKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
    
    console.log('--- Outbound Security Check ---');
    console.log(`Received key starts with: "${clientKey?.substring(0, 5)}..."`);
    console.log(`Expected key starts with: "${API_KEY?.substring(0, 5)}..."`);

    if (clientKey !== API_KEY) {
        console.error('❌ UNAUTHORIZED: API Key mismatch.');
        return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    const { number, message } = req.body;
    if (!number || !message) return res.status(400).json({ error: 'Missing data' });

    try {
        const cleanNumber = number.replace(/\D/g, '').replace(/^0/, '44');
        const jid = cleanNumber.includes('@s.whatsapp.net') ? cleanNumber : `${cleanNumber}@s.whatsapp.net`;

        await sock.sendMessage(jid, { text: message });
        console.log(`📤 Message Sent to ${cleanNumber}`);
        res.json({ ok: true });
    } catch (err) {
        console.error('❌ Send Error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ================================
// WHATSAPP CONNECTION
// ================================

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        auth: state,
        version,
        browser: ['Ubuntu', 'Chrome', '20.0.04'],
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
    });

    sock.ev.on('creds.update', saveCreds);

    // --- INBOUND: WHATSAPP -> RAILWAY -> SUPABASE ---
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        try {
            if (type !== 'notify') return;
            const msg = messages[0];
            if (!msg.message || msg.key.fromMe) return;

            // FIX: Prioritize real sender number over LID aliases (1469... issue)
            let sender = msg.key.remoteJid.split('@')[0];
            if (msg.key.participant) {
                sender = msg.key.participant.split('@')[0];
            }

            const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || 'Media Message';
            console.log(`📩 Incoming from ${sender}: ${text}`);

            // Forward to Supabase
            const response = await axios.post(LOVABLE_WEBHOOK_URL, {
                number: sender,
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

            console.log('✅ Webhook Delivered:', response.data.id || 'Success');
        } catch (err) {
            console.error('❌ Webhook Failed:', err.response?.data || err.message);
        }
    });

    // --- CONNECTION & PAIRING LOGIC ---
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'connecting') {
            console.log('Attempting to connect...');
            if (!sock.authState.creds.registered && !pairingCodeRequested) {
                pairingCodeRequested = true;
                
                // Clear any potential stale state before requesting
                setTimeout(async () => {
                    try {
                        console.log('--- GENERATING NEW PAIRING CODE ---');
                        // Use digits only version of number
                        const cleanPairNumber = MY_PHONE_NUMBER.replace(/\D/g, '');
                        const code = await sock.requestPairingCode(cleanPairNumber);
                        console.log(`\n🔗 YOUR ACTIVE PAIRING CODE: ${code}\n`);
                    } catch (e) { 
                        console.error('Pairing Request Failed:', e.message);
                        pairingCodeRequested = false; 
                    }
                }, 4000);
            }
        }

        if (connection === 'open') {
            console.log('🚀 WHATSAPP READY');
            pairingCodeRequested = false;
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            console.log(`Connection closed (Status: ${statusCode})`);
            pairingCodeRequested = false;
            
            if (statusCode !== DisconnectReason.loggedOut) {
                setTimeout(connectToWhatsApp, 5000);
            }
        }
    });
}

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server active on port ${PORT}`);
    connectToWhatsApp().catch(console.error);
});