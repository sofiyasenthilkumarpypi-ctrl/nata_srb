import 'dotenv/config';
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import pino from 'pino';
import axios from 'axios';
import { readFileSync, appendFileSync, writeFileSync, existsSync } from 'fs';

const NTFY_TOPIC = process.env.NTFY_TOPIC || 'wa_typing';
const CONTACT_MAP_FILE = 'contact-map.json';
const LOG_FILE = 'sreenithi-activity.log';
const STATS_FILE = 'sreenithi-stats.json';

// Load contact map
const contactMap = JSON.parse(readFileSync(CONTACT_MAP_FILE, 'utf8'));

const SREENITHI_LID = contactMap['918428422868'].lid;
const SREENITHI_JID = '918428422868@s.whatsapp.net';

// Tracking state
let rttHistory = [];
let probeStartTimes = new Map();
let sreemithiLastState = null;
let messageSentTimes = new Map();
let messageStateAtSend = new Map();
let currentSreemithiActivityState = 'UNKNOWN';
let typingStartTime = null;
let autoProbeInterval = null;
let continuousProbeInterval = null; // For continuous online/offline detection
let lastKnownRttState = null;
let lastProfilePicUrl = null;
let lastAboutStatus = null;

// Stats tracking
let stats = loadStats();

function loadStats() {
    if (existsSync(STATS_FILE)) {
        return JSON.parse(readFileSync(STATS_FILE, 'utf8'));
    }
    return {
        messagesReceived: 0,
        messagesSent: 0,
        typingEvents: 0,
        onlineEvents: 0,
        offlineEvents: 0,
        averageResponseTime: 0,
        responseTimes: [],
        dailyActivity: {},
        stateHistory: [],
        typingDurations: [],
        profilePicChanges: [],
        statusChanges: [],
        rttPatterns: {
            active: [],
            standby: [],
            offline: []
        }
    };
}

function saveStats() {
    writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
}

function log(message) {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${message}\n`;
    appendFileSync(LOG_FILE, logEntry);
    console.log(logEntry.trim());
}

function calculateState(rtt) {
    if (rtt > 5000) return { state: 'OFFLINE', emoji: '🔴', description: 'Device offline or unreachable' };
    if (rtt < 900) return { state: 'ACTIVE', emoji: '🟢', description: 'Screen on / Active usage' };
    return { state: 'STANDBY', emoji: '🟡', description: 'Screen off / Device locked' };
}

function analyzeResponsePattern(readTimeSeconds, stateAtSend) {
    let pattern = '';
    let emoji = '';

    if (stateAtSend === 'ACTIVE') {
        if (readTimeSeconds < 10) {
            pattern = 'INSTANT - Actively using phone, replied immediately';
            emoji = '⚡';
        } else if (readTimeSeconds < 60) {
            pattern = 'QUICK - On phone, read within a minute';
            emoji = '🟢';
        } else if (readTimeSeconds < 300) {
            pattern = 'DELAYED - Active but took 1-5min (distracted?)';
            emoji = '🟡';
        } else {
            pattern = 'VERY DELAYED - Active when sent but 5+ min (switched apps?)';
            emoji = '🔴';
        }
    } else if (stateAtSend === 'STANDBY') {
        if (readTimeSeconds < 30) {
            pattern = 'PICKED UP QUICKLY - Screen off but checked fast';
            emoji = '📱';
        } else if (readTimeSeconds < 300) {
            pattern = 'NORMAL - Phone locked, checked within 5min';
            emoji = '🟡';
        } else if (readTimeSeconds < 1800) {
            pattern = 'LONG DELAY - Locked 5-30min';
            emoji = '🔴';
        } else {
            pattern = 'VERY LONG - Locked 30+ min (away from phone)';
            emoji = '⛔';
        }
    } else if (stateAtSend === 'OFFLINE') {
        if (readTimeSeconds < 60) {
            pattern = 'CAME ONLINE QUICKLY';
            emoji = '🟢';
        } else {
            pattern = 'DELAYED AFTER RECONNECT';
            emoji = '🟡';
        }
    } else {
        if (readTimeSeconds < 30) pattern = 'QUICK READ', emoji = '⚡';
        else if (readTimeSeconds < 300) pattern = 'MODERATE DELAY', emoji = '🟡';
        else pattern = 'LONG DELAY', emoji = '🔴';
    }

    return { pattern, emoji };
}

function updateDailyActivity() {
    const today = new Date().toISOString().split('T')[0];
    if (!stats.dailyActivity[today]) {
        stats.dailyActivity[today] = {
            probes: 0,
            activeCount: 0,
            standbyCount: 0,
            offlineCount: 0,
            typingEvents: 0,
            messagesReceived: 0,
            messagesSent: 0,
            onlineEvents: 0,
            offlineEvents: 0
        };
    }
    return today;
}

async function sendRttProbe(sock) {
    try {
        const prefixes = ['3EB0', 'BAE5', 'F1D2', 'A9C4'];
        const randomPrefix = prefixes[Math.floor(Math.random() * prefixes.length)];
        const randomSuffix = Math.random().toString(36).substring(2, 10).toUpperCase();
        const randomMsgId = randomPrefix + randomSuffix;

        const deleteMessage = {
            delete: {
                remoteJid: SREENITHI_JID,
                fromMe: true,
                id: randomMsgId
            }
        };

        const startTime = Date.now();
        const result = await sock.sendMessage(SREENITHI_JID, deleteMessage);

        if (result?.key?.id) {
            probeStartTimes.set(result.key.id, startTime);
            log(`🔍 RTT probe sent (${result.key.id})`);

            setTimeout(() => {
                if (probeStartTimes.has(result.key.id)) {
                    probeStartTimes.delete(result.key.id);
                    const rtt = Date.now() - startTime;
                    const stateInfo = calculateState(rtt);

                    currentSreemithiActivityState = stateInfo.state;
                    recordStateHistory(stateInfo.state, rtt);

                    log(`${stateInfo.emoji} ${stateInfo.state} (RTT: ${rtt}ms - TIMEOUT)`);

                    axios.post(
                        `https://ntfy.sh/${NTFY_TOPIC}`,
                        `${stateInfo.emoji} ${stateInfo.state}\nRTT: ${rtt}ms (timeout)\n${stateInfo.description}`,
                        { headers: { Title: 'RTT Check', Priority: 'default' } }
                    ).catch(() => {});
                }
            }, 10000);
        }
    } catch (e) {
        log(`❌ RTT probe failed: ${e.message}`);
    }
}

function recordStateHistory(state, rtt) {
    const today = updateDailyActivity();

    stats.stateHistory.push({
        timestamp: new Date().toISOString(),
        state,
        rtt
    });

    if (stats.stateHistory.length > 5000) {
        stats.stateHistory = stats.stateHistory.slice(-5000);
    }

    stats.dailyActivity[today].probes++;
    if (state === 'ACTIVE') {
        stats.dailyActivity[today].activeCount++;
        stats.rttPatterns.active.push(rtt);
    } else if (state === 'STANDBY') {
        stats.dailyActivity[today].standbyCount++;
        stats.rttPatterns.standby.push(rtt);
    } else if (state === 'OFFLINE') {
        stats.dailyActivity[today].offlineCount++;
        stats.rttPatterns.offline.push(rtt);
    }

    // Detect state CHANGE (for online/offline notifications)
    if (lastKnownRttState !== null && lastKnownRttState !== state) {
        if (state === 'OFFLINE') {
            log(`🔴 RTT detected: She went OFFLINE (was ${lastKnownRttState})`);
            axios.post(
                `https://ntfy.sh/${NTFY_TOPIC}`,
                `🔴 Sreenithi went OFFLINE (via RTT)\nLast state: ${lastKnownRttState}`,
                { headers: { Title: 'Offline (RTT)', Priority: 'default', Tags: 'red_circle' } }
            ).catch(() => {});
        } else if (lastKnownRttState === 'OFFLINE') {
            log(`🟢 RTT detected: She came ONLINE (${state})`);
            axios.post(
                `https://ntfy.sh/${NTFY_TOPIC}`,
                `🟢 Sreenithi came ONLINE (${state} via RTT)`,
                { headers: { Title: 'Online (RTT)', Priority: 'high', Tags: 'green_circle' } }
            ).catch(() => {});
        } else if (state === 'ACTIVE' && lastKnownRttState === 'STANDBY') {
            log(`📱 RTT detected: Picked up phone (STANDBY → ACTIVE)`);
        } else if (state === 'STANDBY' && lastKnownRttState === 'ACTIVE') {
            log(`📵 RTT detected: Put down phone (ACTIVE → STANDBY)`);
        }
    }

    lastKnownRttState = state;

    // Keep last 1000 for each pattern
    Object.keys(stats.rttPatterns).forEach(key => {
        if (stats.rttPatterns[key].length > 1000) {
            stats.rttPatterns[key] = stats.rttPatterns[key].slice(-1000);
        }
    });

    saveStats();
}

function generateDailySummary() {
    const today = new Date().toISOString().split('T')[0];
    const todayStats = stats.dailyActivity[today] || {};

    const totalProbes = todayStats.probes || 0;
    const activePercent = totalProbes > 0 ? ((todayStats.activeCount / totalProbes) * 100).toFixed(1) : 0;
    const standbyPercent = totalProbes > 0 ? ((todayStats.standbyCount / totalProbes) * 100).toFixed(1) : 0;

    const avgResponseTime = stats.responseTimes.length > 0
        ? (stats.responseTimes.reduce((a, b) => a + b, 0) / stats.responseTimes.length / 1000).toFixed(1)
        : 'N/A';

    const avgTypingDuration = stats.typingDurations.length > 0
        ? (stats.typingDurations.reduce((a, b) => a + b, 0) / stats.typingDurations.length / 1000).toFixed(1)
        : 'N/A';

    return `📊 DAILY SUMMARY (${today})

📱 Activity:
  • Total probes: ${totalProbes}
  • 🟢 Active: ${todayStats.activeCount || 0} (${activePercent}%)
  • 🟡 Standby: ${todayStats.standbyCount || 0} (${standbyPercent}%)
  • 🔴 Offline: ${todayStats.offlineCount || 0}

💬 Messages:
  • Received: ${todayStats.messagesReceived || 0}
  • Sent: ${todayStats.messagesSent || 0}
  • Typing events: ${todayStats.typingEvents || 0}
  • Avg typing: ${avgTypingDuration}s

📈 Response Time:
  • Average: ${avgResponseTime}s
  • Total responses tracked: ${stats.responseTimes.length}

🔄 Online/Offline:
  • Came online: ${todayStats.onlineEvents || 0}x
  • Went offline: ${todayStats.offlineEvents || 0}x`;
}

async function checkProfilePicChange(sock) {
    try {
        const picUrl = await sock.profilePictureUrl(SREENITHI_JID, 'image');

        if (lastProfilePicUrl && picUrl && picUrl !== lastProfilePicUrl) {
            log(`🖼️ Profile picture CHANGED!`);
            stats.profilePicChanges.push({
                timestamp: new Date().toISOString(),
                oldUrl: lastProfilePicUrl,
                newUrl: picUrl
            });

            axios.post(
                `https://ntfy.sh/${NTFY_TOPIC}`,
                `🖼️ Sreenithi changed her profile picture!`,
                { headers: { Title: 'Profile Updated', Priority: 'high' } }
            ).catch(() => {});

            saveStats();
        }

        lastProfilePicUrl = picUrl;
    } catch (e) {}
}

async function checkStatusChange(sock) {
    try {
        const status = await sock.fetchStatus(SREENITHI_JID);
        const statusText = status?.status;

        if (lastAboutStatus && statusText && statusText !== lastAboutStatus) {
            log(`📝 Status/About CHANGED: "${statusText}"`);
            stats.statusChanges.push({
                timestamp: new Date().toISOString(),
                oldStatus: lastAboutStatus,
                newStatus: statusText
            });

            axios.post(
                `https://ntfy.sh/${NTFY_TOPIC}`,
                `📝 Sreenithi changed status/about:\n"${statusText}"`,
                { headers: { Title: 'Status Updated', Priority: 'default' } }
            ).catch(() => {});

            saveStats();
        }

        lastAboutStatus = statusText;
    } catch (e) {}
}

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
            log('🚀 Ultimate Sreenithi Tracker started');
            log(`📊 Total stats: ${stats.messagesReceived + stats.messagesSent} messages, ${stats.stateHistory.length} probes`);

            try {
                await sock.presenceSubscribe(SREENITHI_JID);
                log('✓ Subscribed to presence');
            } catch (e) {}

            // Check profile pic and status on startup
            await checkProfilePicChange(sock);
            await checkStatusChange(sock);

            startNtfyListener(sock);
        }
        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            if (reason !== DisconnectReason.loggedOut) {
                setTimeout(start, 5000);
            }
        }
    });

    // Detect when YOU send a message
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        for (const msg of messages) {
            const remoteJid = msg.key.remoteJid;
            const isFromMe = msg.key.fromMe;

            if (remoteJid === SREENITHI_JID) {
                if (isFromMe && type === 'notify') {
                    const messageText = msg.message?.conversation ||
                                      msg.message?.extendedTextMessage?.text ||
                                      '[Media/Other]';

                    const today = updateDailyActivity();
                    stats.dailyActivity[today].messagesSent++;
                    stats.messagesSent++;
                    saveStats();

                    log(`📤 YOU → Sreenithi: "${messageText.substring(0, 50)}"`);
                    log(`🔍 Auto-probing...`);

                    await sendRttProbe(sock);

                    axios.post(
                        `https://ntfy.sh/${NTFY_TOPIC}`,
                        `📤 Sent to Sreenithi\n"${messageText.substring(0, 50)}${messageText.length > 50 ? '...' : ''}"\n\n🔍 Checking state...`,
                        { headers: { Title: 'Message Sent', Priority: 'default' } }
                    ).catch(() => {});
                }

                // Track HER messages to you
                if (!isFromMe && type === 'notify') {
                    const messageText = msg.message?.conversation ||
                                      msg.message?.extendedTextMessage?.text ||
                                      '[Media/Other]';

                    const today = updateDailyActivity();
                    stats.dailyActivity[today].messagesReceived++;
                    stats.messagesReceived++;
                    saveStats();

                    log(`📥 Sreenithi → YOU: "${messageText.substring(0, 50)}"`);

                    axios.post(
                        `https://ntfy.sh/${NTFY_TOPIC}`,
                        `📥 New message from Sreenithi\n"${messageText.substring(0, 100)}${messageText.length > 100 ? '...' : ''}"`,
                        { headers: { Title: 'Message Received', Priority: 'high' } }
                    ).catch(() => {});
                }
            }
        }
    });

    // Message updates - RTT responses and read receipts
    sock.ev.on('messages.update', (updates) => {
        for (const update of updates) {
            const msgId = update.key.id;
            const remoteJid = update.key.remoteJid;
            const status = update.update.status;

            // RTT probe responses
            if (update.key.fromMe && status === 3) {
                const startTime = probeStartTimes.get(msgId);

                if (startTime) {
                    const rtt = Date.now() - startTime;
                    probeStartTimes.delete(msgId);

                    rttHistory.push(rtt);
                    if (rttHistory.length > 2000) rttHistory.shift();

                    const stateInfo = calculateState(rtt);
                    currentSreemithiActivityState = stateInfo.state;

                    recordStateHistory(stateInfo.state, rtt);

                    log(`${stateInfo.emoji} ${stateInfo.state} (RTT: ${rtt}ms)`);

                    axios.post(
                        `https://ntfy.sh/${NTFY_TOPIC}`,
                        `${stateInfo.emoji} ${stateInfo.state}\nRTT: ${rtt}ms\n${stateInfo.description}`,
                        { headers: { Title: 'RTT Result', Priority: 'default' } }
                    ).catch(() => {});
                }
            }

            // Blue tick tracking
            if (remoteJid === SREENITHI_JID && update.key.fromMe) {
                const sentTime = messageSentTimes.get(msgId);
                const stateAtSend = messageStateAtSend.get(msgId);

                if (status === 1) {
                    messageSentTimes.set(msgId, Date.now());
                    messageStateAtSend.set(msgId, currentSreemithiActivityState);

                    const stateEmoji = currentSreemithiActivityState === 'ACTIVE' ? '🟢' :
                                      currentSreemithiActivityState === 'STANDBY' ? '🟡' :
                                      currentSreemithiActivityState === 'OFFLINE' ? '🔴' : '⚪';

                    log(`📤 Message sent ${stateEmoji} (State: ${currentSreemithiActivityState})`);
                }
                else if (status === 2 && sentTime) {
                    const serverTime = Date.now() - sentTime;
                    log(`✓ Server ACK (${serverTime}ms)`);
                }
                else if (status === 3 && sentTime) {
                    const deliveryTime = Date.now() - sentTime;
                    log(`✓✓ Delivered (${deliveryTime}ms)`);
                }
                else if (status === 4 && sentTime) {
                    const readTime = Date.now() - sentTime;
                    const readSeconds = (readTime / 1000).toFixed(1);
                    const readMinutes = (readTime / 60000).toFixed(1);

                    stats.responseTimes.push(readTime);
                    if (stats.responseTimes.length > 500) {
                        stats.responseTimes = stats.responseTimes.slice(-500);
                    }
                    saveStats();

                    const analysis = analyzeResponsePattern(readTime / 1000, stateAtSend);

                    const timeDisplay = readTime < 60000 ? `${readSeconds}s` : `${readMinutes}min (${readSeconds}s)`;

                    const stateAtSendEmoji = stateAtSend === 'ACTIVE' ? '🟢' :
                                            stateAtSend === 'STANDBY' ? '🟡' :
                                            stateAtSend === 'OFFLINE' ? '🔴' : '⚪';

                    const currentStateEmoji = currentSreemithiActivityState === 'ACTIVE' ? '🟢' :
                                             currentSreemithiActivityState === 'STANDBY' ? '🟡' :
                                             currentSreemithiActivityState === 'OFFLINE' ? '🔴' : '⚪';

                    log(`✓✓ 🔵 READ! (${timeDisplay})`);
                    log(`📊 ${analysis.emoji} ${analysis.pattern}`);
                    log(`   ${stateAtSendEmoji} ${stateAtSend} → ${currentStateEmoji} ${currentSreemithiActivityState}`);

                    let pickupInfo = '';
                    if (stateAtSend === 'STANDBY' && currentSreemithiActivityState === 'ACTIVE') {
                        pickupInfo = '\n📱 PICKED UP PHONE to read!';
                    } else if (stateAtSend === 'OFFLINE' && currentSreemithiActivityState === 'ACTIVE') {
                        pickupInfo = '\n📱 CAME ONLINE!';
                    } else if (stateAtSend === 'ACTIVE' && currentSreemithiActivityState === 'ACTIVE') {
                        pickupInfo = '\n✨ Already active';
                    }

                    axios.post(
                        `https://ntfy.sh/${NTFY_TOPIC}`,
                        `${analysis.emoji} ${analysis.pattern}\n\n` +
                        `⏱️ ${timeDisplay}\n` +
                        `${stateAtSendEmoji} Sent: ${stateAtSend}\n` +
                        `${currentStateEmoji} Now: ${currentSreemithiActivityState}${pickupInfo}`,
                        { headers: { Title: 'Read Analysis', Priority: 'high', Tags: 'blue_circle' } }
                    ).catch(() => {});

                    messageSentTimes.delete(msgId);
                    messageStateAtSend.delete(msgId);
                }
            }
        }
    });

    // Presence tracking
    sock.ev.on('presence.update', async ({ id, presences }) => {
        const presence = presences[id]?.lastKnownPresence;

        if (id === SREENITHI_LID) {
            const isOnline = presence === 'available' || presence === 'composing';
            const isOffline = presence === 'unavailable';

            if (isOnline && sreemithiLastState !== 'online') {
                const today = updateDailyActivity();
                stats.dailyActivity[today].onlineEvents++;
                stats.onlineEvents++;
                saveStats();

                log('🟢 ONLINE');
                sreemithiLastState = 'online';

                axios.post(
                    `https://ntfy.sh/${NTFY_TOPIC}`,
                    'Sreenithi 🤍 came online',
                    { headers: { Title: 'Online', Priority: 'high', Tags: 'green_circle' } }
                ).catch(() => {});
            } else if (isOffline && sreemithiLastState !== 'offline') {
                const today = updateDailyActivity();
                stats.dailyActivity[today].offlineEvents++;
                stats.offlineEvents++;
                saveStats();

                log('🔴 OFFLINE');
                sreemithiLastState = 'offline';

                axios.post(
                    `https://ntfy.sh/${NTFY_TOPIC}`,
                    'Sreenithi 🤍 went offline',
                    { headers: { Title: 'Offline', Priority: 'default', Tags: 'red_circle' } }
                ).catch(() => {});
            }

            if (presence === 'composing') {
                const today = updateDailyActivity();
                stats.dailyActivity[today].typingEvents++;
                stats.typingEvents++;

                if (!typingStartTime) {
                    typingStartTime = Date.now();
                    log('💬 Started TYPING');

                    axios.post(
                        `https://ntfy.sh/${NTFY_TOPIC}`,
                        'Sreenithi 🤍 is typing...',
                        { headers: { Title: 'Typing', Priority: 'high' } }
                    ).catch(() => {});
                }
            } else if (typingStartTime && presence !== 'composing') {
                const typingDuration = Date.now() - typingStartTime;
                const durationSec = (typingDuration / 1000).toFixed(1);

                stats.typingDurations.push(typingDuration);
                if (stats.typingDurations.length > 200) {
                    stats.typingDurations = stats.typingDurations.slice(-200);
                }
                saveStats();

                log(`⏹️ Stopped typing (Duration: ${durationSec}s)`);

                let typingAnalysis = '';
                if (typingDuration < 3000) typingAnalysis = 'Very short - probably emoji/sticker';
                else if (typingDuration < 10000) typingAnalysis = 'Short message';
                else if (typingDuration < 30000) typingAnalysis = 'Medium message';
                else typingAnalysis = 'Long message or thinking/rewriting';

                axios.post(
                    `https://ntfy.sh/${NTFY_TOPIC}`,
                    `⏹️ Stopped typing\nDuration: ${durationSec}s\n${typingAnalysis}`,
                    { headers: { Title: 'Typing Stopped', Priority: 'default' } }
                ).catch(() => {});

                typingStartTime = null;
            }
        }

        // Other contacts typing
        const lidToContact = {};
        Object.entries(contactMap).forEach(([key, contact]) => {
            lidToContact[contact.lid] = contact.name;
        });

        if (presence === 'composing' && id !== SREENITHI_LID) {
            const contactName = lidToContact[id];

            if (contactName) {
                log(`💬 ${contactName} typing`);
                axios.post(
                    `https://ntfy.sh/${NTFY_TOPIC}`,
                    `${contactName} is typing`,
                    { headers: { Title: 'Typing', Priority: 'default' } }
                ).catch(() => {});
            } else {
                log(`💬 Someone typing (${id})`);
                axios.post(
                    `https://ntfy.sh/${NTFY_TOPIC}`,
                    'Someone is typing',
                    { headers: { Title: 'Typing', Priority: 'default' } }
                ).catch(() => {});
            }
        }
    });
}

// ntfy command listener - polling instead of SSE for Railway compatibility
async function startNtfyListener(sock) {
    log('👂 Listening for commands (polling mode)');

    let lastMessageId = null;

    async function pollCommands() {
        try {
            const response = await axios.get(`https://ntfy.sh/${NTFY_TOPIC}/json?poll=1`, {
                timeout: 10000
            });

            const message = response.data?.message?.toLowerCase().trim();
            const messageId = response.data?.id;

            if (message && messageId !== lastMessageId) {
                lastMessageId = messageId;
                log(`📥 Command: "${message}"`);

                if (message === 'check') {
                    log('🔍 Manual check');
                    await sendRttProbe(sock);
                }
                else if (message === 'auto') {
                    if (autoProbeInterval) {
                        log('⚠️ Auto-probe already running');
                    } else {
                        log('🔄 Starting auto-probe (every 3min)');
                        autoProbeInterval = setInterval(() => sendRttProbe(sock), 180000);
                        axios.post(`https://ntfy.sh/${NTFY_TOPIC}`, '🔄 Auto-probe ON (3min)',
                            { headers: { Title: 'Auto-Probe ON' } }).catch(() => {});
                    }
                }
                else if (message.startsWith('auto ')) {
                    const intervalStr = message.split(' ')[1];
                    let intervalMs = 180000;

                    if (intervalStr.endsWith('s')) intervalMs = parseInt(intervalStr) * 1000;
                    else if (intervalStr.endsWith('m')) intervalMs = parseInt(intervalStr) * 60000;

                    if (autoProbeInterval) clearInterval(autoProbeInterval);

                    log(`🔄 Starting auto-probe (every ${intervalStr})`);
                    autoProbeInterval = setInterval(() => sendRttProbe(sock), intervalMs);
                    axios.post(`https://ntfy.sh/${NTFY_TOPIC}`, `🔄 Auto-probe ON (${intervalStr})`,
                        { headers: { Title: 'Auto-Probe ON' } }).catch(() => {});
                }
                else if (message === 'continuous') {
                    if (continuousProbeInterval) {
                        log('⚠️ Continuous already running');
                    } else {
                        log('🔄 Starting CONTINUOUS (30s)');
                        continuousProbeInterval = setInterval(() => sendRttProbe(sock), 30000);
                        axios.post(`https://ntfy.sh/${NTFY_TOPIC}`, '🔄 CONTINUOUS ON (30s)',
                            { headers: { Title: 'Continuous ON' } }).catch(() => {});
                    }
                }
                else if (message.startsWith('continuous ')) {
                    const intervalStr = message.split(' ')[1];
                    let intervalMs = 30000;

                    if (intervalStr.endsWith('s')) intervalMs = parseInt(intervalStr) * 1000;
                    else if (intervalStr.endsWith('m')) intervalMs = parseInt(intervalStr) * 60000;

                    if (continuousProbeInterval) clearInterval(continuousProbeInterval);

                    log(`🔄 Starting CONTINUOUS (${intervalStr})`);
                    continuousProbeInterval = setInterval(() => sendRttProbe(sock), intervalMs);
                    axios.post(`https://ntfy.sh/${NTFY_TOPIC}`, `🔄 CONTINUOUS ON (${intervalStr})`,
                        { headers: { Title: 'Continuous ON' } }).catch(() => {});
                }
                else if (message === 'stop') {
                    let stopped = false;

                    if (autoProbeInterval) {
                        clearInterval(autoProbeInterval);
                        autoProbeInterval = null;
                        stopped = true;
                    }
                    if (continuousProbeInterval) {
                        clearInterval(continuousProbeInterval);
                        continuousProbeInterval = null;
                        stopped = true;
                    }

                    if (stopped) {
                        log('⏹️ Stopped');
                        axios.post(`https://ntfy.sh/${NTFY_TOPIC}`, '⏹️ Stopped',
                            { headers: { Title: 'Stopped' } }).catch(() => {});
                    } else {
                        log('⚠️ Nothing running');
                    }
                }
                else if (message === 'stats' || message === 'summary') {
                    const summary = generateDailySummary();
                    log('📊 Sending summary');
                    axios.post(`https://ntfy.sh/${NTFY_TOPIC}`, summary,
                        { headers: { Title: 'Daily Summary' } }).catch(() => {});
                }
                else if (message === 'profile') {
                    await checkProfilePicChange(sock);
                    await checkStatusChange(sock);
                    log('🔍 Checked profile');
                }
            }
        } catch (e) {
            // Silent fail - will retry next poll
        }

        setTimeout(pollCommands, 3000); // Poll every 3 seconds
    }

    pollCommands();
}

start();
