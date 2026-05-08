const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const express = require('express');
const pino = require('pino');

process.on('uncaughtException', (err) => {
    console.error('UNCAUGHT EXCEPTION:', err);
});

process.on('unhandledRejection', (err) => {
    console.error('UNHANDLED REJECTION:', err);
});

const app = express();

app.use(express.json());

const PORT = process.env.PORT || 3000;

// Digits only — no + or spaces
const MY_PHONE_NUMBER = '905431436966';

let pairingCodeRequested = false;

async function connectToWhatsApp() {

    console.log('=================================');
    console.log('Starting WhatsApp Service...');
    console.log('=================================');

    const { state, saveCreds } =
        await useMultiFileAuthState('auth_info_baileys');

    // Get latest supported WhatsApp version
    const { version } = await fetchLatestBaileysVersion();

    console.log('Using WA Version:', version);

    const sock = makeWASocket({
        auth: state,

        version,

        // Most stable browser fingerprint
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

    // Save session automatically
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {

        const {
            connection,
            lastDisconnect
        } = update;

        console.log('Connection Update:', connection);

        // Request pairing code once only
        if (
            connection === 'connecting' &&
            !sock.authState.creds.registered &&
            !pairingCodeRequested
        ) {
            try {

                pairingCodeRequested = true;

                console.log('\n=================================');
                console.log('REQUESTING PAIRING CODE...');
                console.log('=================================\n');

                // Give socket time to stabilize
                await new Promise(resolve =>
                    setTimeout(resolve, 5000)
                );

                const code =
                    await sock.requestPairingCode(
                        MY_PHONE_NUMBER
                    );

                console.log('\n=================================');
                console.log(`PAIRING CODE: ${code}`);
                console.log('=================================\n');

                console.log('Open WhatsApp on your phone:');
                console.log('Settings > Linked Devices');
                console.log('Link a Device');
                console.log('Link with phone number instead');
                console.log('Enter the code immediately.\n');

            } catch (err) {

                console.error('PAIRING ERROR:', err);

                pairingCodeRequested = false;
            }
        }

        // Successful connection
        if (connection === 'open') {

            console.log('\n=================================');
            console.log('WHATSAPP CONNECTED SUCCESSFULLY');
            console.log('=================================\n');
        }

        // Connection closed
        if (connection === 'close') {

            const statusCode =
                lastDisconnect?.error?.output?.statusCode;

            const shouldReconnect =
                statusCode !== DisconnectReason.loggedOut;

            console.log('\n=================================');
            console.log('CONNECTION CLOSED');
            console.log('Status Code:', statusCode);
            console.log('Reconnect:', shouldReconnect);
            console.log('=================================\n');

            // Reset pairing state
            pairingCodeRequested = false;

            if (shouldReconnect) {

                console.log('Reconnecting in 5 seconds...\n');

                setTimeout(() => {
                    connectToWhatsApp();
                }, 5000);
            }
        }
    });

    return sock;
}

// Health check endpoint
app.get('/', (req, res) => {
    res.send('WhatsApp Baileys Service Running');
});

// Start service
connectToWhatsApp()
    .then(() => {

        app.listen(PORT, () => {

            console.log(`Server running on port ${PORT}`);
        });

    })
    .catch((err) => {

        console.error('FAILED TO START:', err);
    });