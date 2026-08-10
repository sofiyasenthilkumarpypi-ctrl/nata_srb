# nata

WhatsApp typing notifier.

## Deploy to Railway (Free Tier)

### 1. Link WhatsApp locally first

```bash
npm install
node index.js
# Scan QR with WhatsApp → Settings → Linked Devices
# Wait for "✓ WhatsApp linked"
# Ctrl+C to stop
```

### 2. Push to GitHub

```bash
git init
git add .
git commit -m "Init"
git branch -M main
# Create repo on GitHub, then:
git remote add origin https://github.com/yourusername/nata.git
git push -u origin main
```

### 3. Deploy on Railway

1. Go to [railway.app](https://railway.app) → Login with GitHub
2. **New Project** → **Deploy from GitHub repo**
3. Select your `nata` repo
4. Railway auto-detects Node.js, starts deploying
5. Go to **Variables** tab:
   - `TARGET` = `918428422868`
   - `NTFY_TOPIC` = `sreenithi_typing_0x`
6. **Redeploy**

### 4. Upload auth session

Push the `auth/` folder:

```bash
git add auth/ -f
git commit -m "Add WhatsApp session"
git push
```

Railway auto-redeploys with your session.

### 5. Get notifications

1. Install [ntfy app](https://ntfy.sh)
2. Subscribe: `sreenithi_typing_0x`
3. Done

**Free tier:** 500 hours/month, persistent disk, never sleeps.
