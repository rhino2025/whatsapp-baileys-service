const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason 
} = require('@whiskeysockets/baileys');
const express = require('express');
const pino = require('pino');

// 1. Global Error Handling
process.on('uncaughtException', (err) => {
    console.error('!!! CRITICAL ERROR:', err.message);
});

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const MY_PHONE_NUMBER = '905431436966'; // Ensure this is your actual number

let sock = null;

// --- API ROUTES ---

app.get('/', (req, res) => res.send('WhatsApp Baileys Service Running'));

// This matches the path your Edge function is looking for
app.post('/api/send-message', async (req, res) => {
    const { number, message } = req.body;

    if (!sock || !sock.authState.creds.registered) {
        return res.status(503).json({ ok: false, error: 'WhatsApp not connected/paired yet' });
    }

    try {
        const jid = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`;
        await sock.sendMessage(jid, { text: message });
        res.json({ ok: true, status: 'sent', recipient: jid });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// --- WHATSAPP LOGIC ---

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    sock = makeWASocket({
        auth: state,
        version: [2, 3000, 1015901307],
        browser: ["Ubuntu", "Chrome", "20.0.04"],
        printQRInTerminal: false,
        logger: pino({ level: 'info' }),
    });

    // Pairing Code logic
    if (!sock.authState.creds.registered) {
        console.log(`>>> Requesting Pairing Code for: ${MY_PHONE_NUMBER}`);
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(MY_PHONE_NUMBER.replace(/\D/g, ''));
                console.log(`\n=============================================`);
                console.log(`   YOUR PAIRING CODE: ${code}`);
                console.log(`=============================================\n`);
            } catch (err) {
                console.error("Pairing Request Failed:", err.message);
            }
        }, 10000); // 10 second delay for stability
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            // Prevent loops if logged out or unauthorized
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut && statusCode !== 401;
            console.log('Connection closed. Reconnecting:', shouldReconnect);
            if (shouldReconnect) connectToWhatsApp();
        } else if (connection === 'open') {
            console.log('--- WHATSAPP CONNECTION ACTIVE ---');
        }
    });
}

// --- STARTUP SEQUENCE ---

// 1. Start API Server immediately so Railway 502s stop
app.listen(PORT, '0.0.0.0', () => {
    console.log(`>>> API Server listening on port ${PORT}`);
    
    // 2. Start WhatsApp connection in the background
    connectToWhatsApp().catch(err => console.error("Socket Init Error:", err));
});