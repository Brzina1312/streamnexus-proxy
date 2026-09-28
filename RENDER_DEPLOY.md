# Render.com Deployment Guide

## Quick Deploy

### 1. Create GitHub Repository

1. Create a new repo on GitHub (e.g., `streamnexus-proxy`)
2. Push the proxy folder contents:

```bash
cd proxy
git init
git add .
git commit -m "Initial proxy setup"
git remote add origin https://github.com/YOUR_USERNAME/streamnexus-proxy.git
git push -u origin main
```

### 2. Deploy to Render

1. Go to https://render.com/ and sign up (no credit card needed)
2. Click **"New +"** → **"Web Service"**
3. Connect your GitHub account
4. Select the `streamnexus-proxy` repository
5. Configure:
   - **Name**: `streamnexus-proxy`
   - **Region**: Choose closest to your users (e.g., Frankfurt)
   - **Branch**: `main`
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: `Free`
6. Click **"Create Web Service"**

### 3. Get Your Proxy URL

Once deployed, Render will give you a URL like:
```
https://streamnexus-proxy.onrender.com
```

### 4. Configure Cloudflare Workers

```bash
cd ../  # Back to main project
wrangler secret put PROXY_URL
# Enter: https://streamnexus-proxy.onrender.com
```

### 5. Deploy Updated API Worker

The API worker now includes automatic keep-alive pinging every 10 minutes to prevent cold starts.

```bash
wrangler deploy
```

## Monitoring

**Check proxy health:**
```
https://streamnexus-proxy.onrender.com/health
```

**View Render logs:**
Dashboard → Your Service → Logs

**Check keep-alive status:**
You'll see pings in Render logs every 10 minutes: `✓ Keep-alive ping received`

## Cold Start Prevention

The Cloudflare Worker automatically pings your proxy every 10 minutes, keeping it warm and preventing the 15-minute sleep timeout.

## Troubleshooting

**Proxy still sleeping?**
- Check Cloudflare cron is running: `wrangler tail` during a scheduled time
- Verify PROXY_URL is set correctly: `wrangler secret list`
- Check Render logs for incoming pings

**Build fails?**
- Ensure `package.json` has correct `start` script
- Check Node version compatibility in Render settings

**403 errors?**
- Check proxy stats: `https://your-proxy.onrender.com/stats`
- High 403 rate means portal might be blocking Render IPs too
- Try different Render region
