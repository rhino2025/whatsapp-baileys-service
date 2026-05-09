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

// --- SESSION CLEANUP (If requested via Railway Variable) ---
if (process.env.RESET_SESSION) {
    console.log('Reset trigger detected. Wiping local session...');
    if (fs.existsSync('./auth_info_baileys')) {
        fs.rmSync('./auth_info_baileys', { recursive: true, force: true });
    }
}

// --- OUTBOUND: LOVABLE -> RAILWAY (Dashboard to Guest) ---
app.post('/api/send-message', async (req, res) => {
    const clientKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
    
    if (clientKey !== API_KEY) {
        console.error('❌ Unauthorized send attempt');
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { number, message } = req.body;
    if (!number || !message) return res.status(400).json({ error: 'Missing data' });

    try {
        let jid;
        // If it's a 14-digit LID (starts with 1), use it directly
        if (number.startsWith('1') && number.length > 12) {
            jid = `${number}@s.whatsapp.net`;
        } else {
            // Standardize real phone numbers
            const cleanNumber = number.replace(/\D/g, '').replace(/^0/, '90');
            jid = `${cleanNumber}@s.whatsapp.net`;
        }

        await sock.sendMessage(jid, { text: message });
        console.log(`📤 Message Sent to ${jid}`);
        res.json({ ok: true });
    } catch (err) {
        console.error('❌ Outbound Error:', err.message);
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
    });

    sock.ev.on('creds.update', saveCreds);

    // --- INBOUND: WHATSAPP -> RAILWAY -> LOVABLE ---
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        try {
            if (type !== 'notify') return;
            const msg = messages[0];
            if (!msg.message || msg.key.fromMe) return;

            // 1. Get the Primary ID (often the 1469... LID)
            let senderId = msg.key.remoteJid.split('@')[0];
            let realPhone = null;

            // 2. Try to unmask the real phone number from JID variants
            if (msg.key.remoteJid.includes(':')) {
                // Extracts digits before the colon (e.g., 447847...:1@s.whatsapp.net)
                realPhone = msg.key.remoteJid.split(':')[0];
            }

            // 3. Fallback check on participant (for multi-device setups)
            if (msg.key.participant) {
                const part = msg.key.participant.split('@')[0];
                if (!part.startsWith('1')) realPhone = part;
            }

            // Use realPhone if found, otherwise use the senderId (LID)
            const finalDisplayNumber = realPhone || senderId;

            const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || 'Media/Unsupported';
            console.log(`📩 Incoming from ${finalDisplayNumber} (LID: ${senderId}): ${text}`);

            await axios.post(LOVABLE_WEBHOOK_URL, {
                number: finalDisplayNumber, // The dashboard will show this
                raw_lid: senderId,          // The dashboard will use this to reply
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
            console.error('❌ Inbound Webhook Error:', err.message);
        }
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'connecting' && !sock.authState.creds.registered && !pairingCodeRequested) {
            pairingCodeRequested = true;
            setTimeout(async () => {
                try {
                    const code = await sock.requestPairingCode(MY_PHONE_NUMBER.replace(/\D/g, ''));
                    console.log(`\n🔗 PAIRING CODE: ${code}\n`);
                } catch (e) { pairingCodeRequested = false; }
            }, 6000);
        }

        if (connection === 'open') {
            console.log('🚀 WHATSAPP READY');
            pairingCodeRequested = false;
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
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