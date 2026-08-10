import 'dotenv/config';
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
            console.log(`✓ Watching for typing from: ${TARGET}`);
        }
        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            console.log('Connection closed:', reason);
            if (reason !== DisconnectReason.loggedOut) {
                setTimeout(start, 5000);
            }
        }
    });

    // Catch ANY typing from ANYONE and send notification
    sock.ev.on('presence.update', async ({ id, presences }) => {
        const state = presences[id]?.lastKnownPresence;

        if (state === 'composing') {
            console.log(`\n🔔 TYPING DETECTED from: ${id}`);
            console.log(`   Target we're looking for: ${TARGET_JID}`);
            console.log(`   Match: ${id === TARGET_JID || id.includes(TARGET)}`);

            // Send notification for ANY typing event (for testing)
            try {
                const response = await axios.post(
                    `https://ntfy.sh/${NTFY_TOPIC}`,
                    `Someone typing: ${id}`,
                    { headers: { Title: 'WA Typing', Priority: 'high' } }
                );
                console.log(`   ✅ Notification sent: ${response.status}\n`);
            } catch (e) {
                console.error(`   ❌ Notification failed: ${e.message}\n`);
            }
        }
    });
}

start();
