console.log(">>> ENGINE STARTING - " + new Date().toISOString());
async function connectToWhatsApp() {
    console.log("1. Initializing Auth State...");
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    console.log("2. Starting Socket...");
    const sock = makeWASocket({
        auth: state,
        // Using a hardcoded version to avoid the network hang
        version: [2, 3000, 1015901307], 
        browser: ["Ubuntu", "Chrome", "20.0.04"],
        printQRInTerminal: false,
        // Add these to help with connection stability
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 0,
    });

    if (!sock.authState.creds.registered) {
        const phoneNumber = '905431436966'; // DOUBLE CHECK THIS IS A STRING
        console.log(`3. Requesting Pairing Code for: ${phoneNumber}`);
        
        // Try requesting it immediately without the timeout first
        try {
            const code = await sock.requestPairingCode(phoneNumber);
            console.log(`\n=============================================`);
            console.log(`PAIRING CODE: ${code}`);
            console.log(`=============================================\n`);
        } catch (err) {
            console.log("Pairing Error:", err.message);
        }
    }

    sock.ev.on('creds.update', saveCreds);
    // ... rest of your code
}