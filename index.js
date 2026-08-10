import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import pino from 'pino';
import axios from 'axios';

const TARGET = process.env.TARGET || '919876543210';
const TARGET_JID = `${TARGET}@s.whatsapp.net`;
const NTFY_TOPIC = process.env.NTFY_TOPIC || 'wa_typing';

async function start() {
    const { state, saveCreds } = await useMultiFileAuthState('auth');

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
        if (connection === 'open') {
            console.log('✓ WhatsApp linked');
            await sock.presenceSubscribe(TARGET_JID);
            console.log(`✓ Monitoring ${TARGET}`);
        }
        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            console.log('Connection closed:', reason);
            if (reason !== DisconnectReason.loggedOut) {
                console.log('Reconnecting in 5s...');
                setTimeout(start, 5000);
            }
        }
    });

    sock.ev.on('presence.update', async ({ id, presences }) => {
        if (id === TARGET_JID && presences[id]?.lastKnownPresence === 'composing') {
            console.log(`[${new Date().toISOString()}] typing`);
            try {
                await axios.post(`https://ntfy.sh/${NTFY_TOPIC}`, 'typing now', {
                    headers: { Title: 'WA Alert', Priority: 'high' }
                });
            } catch (e) {
                console.error('Notification failed:', e.message);
            }
        }
    });
}

start();
