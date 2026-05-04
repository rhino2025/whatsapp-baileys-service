async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        auth: state,
        version,
        browser: ["Ubuntu", "Chrome", "20.0.04"], // Required for pairing code to work
        printQRInTerminal: false // We are switching to pairing code
    });

    // --- ADD THIS SECTION ---
    if (!sock.authState.creds.registered) {
        // Replace this with your actual WhatsApp Business number (including country code)
        // Example: '447123456789'
        const phoneNumber = 'YOUR_PHONE_NUMBER_HERE'; 
        const code = await sock.requestPairingCode(phoneNumber);
        console.log(`\n=============================================`);
        console.log(`YOUR PAIRING CODE: ${code}`);
        console.log(`=============================================\n`);
    }
    // ------------------------

    sock.ev.on('creds.update', saveCreds);
    
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'open') console.log('CONNECTED TO WHATSAPP');
        // ... rest of your existing connection update logic
    });
}