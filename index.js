const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const express = require('express');
const pino = require('pino');

// ================================
// GLOBAL ERROR HANDLING
// ================================

process.on('uncaughtException', (err) =>
    console.error('UNCAUGHT EXCEPTION:', err)
);

process.on('unhandledRejection', (err) =>
    console.error('UNHANDLED REJECTION:', err)
);

// ================================
// EXPRESS SETUP
// ================================

const app = express();

app.use(express.json());

const PORT = process.env.PORT || 3000;

const MY_PHONE_NUMBER = '905431436966';

// Security
const API_KEY = process.env.API_KEY;
const WHATSAPP_WEBHOOK_API_KEY =
    process.env.WHATSAPP_WEBHOOK_API_KEY;

// Lovable webhook URL
const LOVABLE_WEBHOOK_URL =
    'https://azzyfkdywswhfaqbguev.supabase.co/functions/v1/whatsapp-webhook';

let sock = null;
let pairingCodeRequested = false;

// ================================
// API ROUTES
// ================================

// Health check
app.get('/', (req, res) => {
    res.send('WhatsApp Baileys Service Running');
});

// Send message endpoint
app.post('/api/send-message', async (req, res) => {

    // API KEY PROTECTION
    if (req.headers['x-api-key'] !== API_KEY) {

        return res.status(401).json({
            ok: false,
            error: 'Unauthorized'
        });
    }

    const { number, message } = req.body;

    if (!number || !message) {

        return res.status(400).json({
            ok: false,
            error: 'number and message required'
        });
    }

    if (!sock || !sock.authState.creds.registered) {

        return res.status(503).json({
            ok: false,
            error: 'WhatsApp not connected yet'
        });
    }

    try {

        // Normalize number
        const cleanNumber =
            number
                .replace(/\D/g, '')
                .replace(/^0/, '90');

        const jid =
            cleanNumber.includes('@s.whatsapp.net')
                ? cleanNumber
                : `${cleanNumber}@s.whatsapp.net`;

        await sock.sendMessage(jid, {
            text: message
        });

        console.log(
            `OUTGOING MESSAGE → ${cleanNumber}: ${message}`
        );

        res.json({
            ok: true,
            status: 'sent',
            recipient: jid
        });

    } catch (err) {

        console.error('SEND ERROR:', err);

        res.status(500).json({
            ok: false,
            error: err.message
        });
    }
});

// ================================
// WHATSAPP CONNECTION
// ================================

async function connectToWhatsApp() {

    console.log('=================================');
    console.log('Starting WhatsApp Service...');
    console.log('=================================');

    const { state, saveCreds } =
        await useMultiFileAuthState(
            'auth_info_baileys'
        );

    const { version } =
        await fetchLatestBaileysVersion();

    console.log('Using WA Version:', version);

    sock = makeWASocket({

        auth: state,

        version,

        browser: ['Ubuntu', 'Chrome', '20.0.04'],

        logger: pino({
            level: 'silent'
        }),

        printQRInTerminal: false,

        connectTimeoutMs: 60000,

        defaultQueryTimeoutMs: 0,

        markOnlineOnConnect: false,

        syncFullHistory: false,

        generateHighQualityLinkPreview: false
    });

    // ================================
    // SAVE CREDS
    // ================================

    sock.ev.on('creds.update', saveCreds);

    // ================================
    // INCOMING MESSAGES
    // ================================

    sock.ev.on(
        'messages.upsert',
        async ({ messages, type }) => {

            try {

                if (type !== 'notify') return;

                const msg = messages[0];

                if (!msg.message) return;

                // Ignore own messages
                if (msg.key.fromMe) return;

                const remoteJid =
                    msg.key.remoteJid;

                // Ignore groups
                if (
                    remoteJid.includes('@g.us')
                ) return;

                // Extract number
                const number =
                    remoteJid.replace(
                        '@s.whatsapp.net',
                        ''
                    );

                // Extract text
                const message =
                    msg.message?.conversation ||
                    msg.message
                        ?.extendedTextMessage
                        ?.text ||
                    '';

                if (!message) return;

                console.log('\n============================');
                console.log('NEW WHATSAPP MESSAGE');
                console.log('FROM:', number);
                console.log('MESSAGE:', message);
                console.log('============================\n');

                // Forward to Lovable webhook
                const response = await fetch(
                    LOVABLE_WEBHOOK_URL,
                    {
                        method: 'POST',

                        headers: {
                            'Content-Type':
                                'application/json',

                            'x-api-key':
                                WHATSAPP_WEBHOOK_API_KEY
                        },

                        body: JSON.stringify({
                            number,
                            message,
                            timestamp: Date.now(),
                            direction: 'incoming'
                        })
                    }
                );

                const result =
                    await response.text();

                console.log(
                    'Webhook response:',
                    result
                );

            } catch (err) {

                console.error(
                    'WHATSAPP WEBHOOK ERROR:',
                    err
                );
            }
        }
    );

    // ================================
    // CONNECTION EVENTS
    // ================================

    sock.ev.on(
        'connection.update',
        async (update) => {

            const {
                connection,
                lastDisconnect
            } = update;

            console.log(
                'Connection Update:',
                connection
            );

            // Pairing logic
            if (
                connection === 'connecting' &&
                !sock.authState.creds.registered &&
                !pairingCodeRequested
            ) {
                try {

                    pairingCodeRequested = true;

                    console.log(
                        '\n>>> REQUESTING PAIRING CODE...'
                    );

                    await new Promise(resolve =>
                        setTimeout(resolve, 7000)
                    );

                    const code =
                        await sock.requestPairingCode(
                            MY_PHONE_NUMBER
                        );

                    console.log(
                        '\n================================='
                    );

                    console.log(
                        `PAIRING CODE: ${code}`
                    );

                    console.log(
                        '=================================\n'
                    );

                } catch (err) {

                    console.error(
                        'PAIRING ERROR:',
                        err
                    );

                    pairingCodeRequested = false;
                }
            }

            // Connected
            if (connection === 'open') {

                console.log(
                    '\n--- WHATSAPP CONNECTED ---\n'
                );

                pairingCodeRequested = false;
            }

            // Closed
            if (connection === 'close') {

                const statusCode =
                    lastDisconnect?.error
                        ?.output?.statusCode;

                const shouldReconnect =
                    statusCode !==
                    DisconnectReason.loggedOut;

                console.log(
                    '\nWHATSAPP CONNECTION CLOSED'
                );

                console.log(
                    'Status:',
                    statusCode
                );

                console.log(
                    'Reconnect:',
                    shouldReconnect
                );

                pairingCodeRequested = false;

                if (shouldReconnect) {

                    console.log(
                        'Reconnecting in 5 seconds...\n'
                    );

                    setTimeout(
                        connectToWhatsApp,
                        5000
                    );
                }
            }
        }
    );
}

// ================================
// START SERVER
// ================================

// Start API FIRST (important for Railway)
app.listen(PORT, '0.0.0.0', () => {

    console.log(
        `API Server running on port ${PORT}`
    );

    // Start WhatsApp background process
    connectToWhatsApp().catch(err =>
        console.error(
            'STARTUP ERROR:',
            err
        )
    );
});