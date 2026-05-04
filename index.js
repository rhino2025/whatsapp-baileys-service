const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason 
} = require('@whiskeysockets/baileys');
const express = require('express');
const pino = require('pino');

// 1. Global Error Handling to prevent "Silent Crashes" on Railway
process.on('uncaughtException', (err) => {
    console.error('!!! CRITICAL ERROR:', err.message);
    console.error(err.stack);
});

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Update this with your WhatsApp Business Number (Digits only, no + or spaces)
const MY_PHONE_NUMBER = '905431436966'; 

async function connectToWhatsApp() {
    console.log(">>> SYSTEM BOOTING...");
    
    // 2. Initialize Auth State
    // Note: Railway must have permission to write to this folder
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    console.log("1. Starting Socket Configuration...");
    const sock = makeWASocket({
        auth: state,
        // Hardcoded version to prevent network-hangs during startup
        version: [2, 3000, 1015901307], 
        // Chrome browser identity is required for Pairing Code logic
        browser: ["Ubuntu", "Chrome", "20.0.04"],
        printQRInTerminal: false,
        logger: pino({ level: 'info' }),
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 0,
    });

    // 3. Requesting the Pairing Code
    if (!sock.authState.creds.registered) {
        console.log(`2. Requesting Pairing Code for: ${MY_PHONE_NUMBER}`);
        
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(MY_PHONE_NUMBER);
                console.log(`\n=============================================`);
                console.log(`   YOUR PAIRING CODE: ${code}`);
                console.log(`=============================================\n`);
            } catch (err) {
                console.error("3. Pairing Error:", err.message);
            }
        }, 5000); // 5-second buffer to allow socket initialization
    }

    // 4. Connection Listeners
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed. Reconnecting:', shouldReconnect);
            if (shouldReconnect) connectToWhatsApp();
        } else if (connection === 'open') {
            console.log('\n--- WHATSAPP CONNECTION ACTIVE ---');
        }
    });

    return sock;
}

// 5. Start Express and WhatsApp
app.get('/', (req, res) => res.send('WhatsApp Service is Running'));

connectToWhatsApp().then(() => {
    app.listen(PORT, () => {
        console.log(`>>> Service running on port ${PORT}`);
    });
}).catch(err => {
    console.error("!!! FAILED TO START SERVICE:", err);
});