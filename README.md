# StreamNexus Portal Proxy

Smart proxy service for connecting to IPTV portals from Cloudflare Workers without getting blocked.

## Features

✅ **Rate Limiting**: Max 30 requests/minute globally, 1 request per 2 seconds per MAC
✅ **Smart Delays**: Adaptive delays (100ms-5000ms) based on 403 rate
✅ **403 Detection**: Automatically detects blocking and backs off
✅ **Auto-Throttling**: Increases delays when 403 rate is high
✅ **Request Queue**: Prevents hammering the portal
✅ **Monitoring**: Health check and stats endpoints
✅ **Free Hosting**: Runs on Fly.io free tier

## Why This Proxy?

IPTV portals block Cloudflare Workers IPs. This proxy:
- Uses different IPs (Fly.io) that aren't blocked
- Adds intelligent delays to look human
- Detects and adapts to blocking attempts
- Minimizes chance of future 403s

## Prerequisites

1. **Fly.io account**: Sign up at https://fly.io/app/sign-up (free)
2. **flyctl CLI**: Install from https://fly.io/docs/hands-on/install-flyctl/

## Quick Start

### 1. Install flyctl

**Windows (PowerShell):**
```powershell
iwr https://fly.io/install.ps1 -useb | iex
```

**Mac/Linux:**
```bash
curl -L https://fly.io/install.sh | sh
```

### 2. Login to Fly.io

```bash
flyctl auth login
```

### 3. Deploy the Proxy

From the `proxy` directory:

```bash
# Launch the app (first time only)
flyctl launch --no-deploy

# When prompted:
# - App name: streamnexus-proxy (or your choice)
# - Region: Choose closest to your users (e.g., ams for Europe)
# - Postgres/Redis: No
# - Deploy: No (we'll do it manually)

# Deploy
flyctl deploy
```

### 4. Get Your Proxy URL

```bash
flyctl info
```

Look for the hostname, something like: `streamnexus-proxy.fly.dev`

### 5. Configure Cloudflare Workers

Set the PROXY_URL secret:

```bash
cd .. # Back to main project directory
wrangler secret put PROXY_URL
# Enter: https://streamnexus-proxy.fly.dev
```

### 6. Test It

Add a MAC through your API:

```powershell
$apiKey = "YOUR_ADMIN_API_KEY"
$body = @{
  macAddress = "00:1A:79:XX:XX:XX"
  portalUrl = "http://nexusconnects.org/c/"
} | ConvertTo-Json

Invoke-WebRequest -Uri "https://api.streamnexus.cc.cd/admin/macs/add" -Method POST -Headers @{Authorization="Bearer $apiKey"; "Content-Type"="application/json"} -Body $body -UseBasicParsing
```

Should work now! 🎉

## Monitoring

### Health Check

```bash
curl https://streamnexus-proxy.fly.dev/health
```

Returns:
```json
{
  "status": "ok",
  "uptime": 1234,
  "stats": {
    "totalRequests": 100,
    "forbiddenCount": 2,
    "forbiddenRate": "2.0%",
    "currentDelay": "150ms",
    "backedOff": false
  }
}
```

### Detailed Stats

```bash
curl https://streamnexus-proxy.fly.dev/stats
```

### Live Logs

```bash
flyctl logs
```

## How It Prevents 403s

1. **Rate Limiting**: Never sends too many requests too fast
2. **Per-MAC Throttling**: 2 second minimum between requests for same MAC
3. **Smart Delays**: 
   - Starts at 100ms base delay
   - Increases to 5000ms if 403 rate > 30%
   - Adds random jitter (0-100ms) to look human
4. **Backoff**: After 3 consecutive 403s, waits 30 seconds before retrying
5. **Adaptive**: Automatically adjusts behavior based on portal responses

## Troubleshooting

### Proxy returns 503 "Service temporarily throttled"

The proxy detected too many 403s and is backing off. Wait 30 seconds and try again.

### Still getting 403s through proxy

1. Check proxy logs: `flyctl logs`
2. Check stats: `curl https://YOUR-PROXY.fly.dev/stats`
3. If 403 rate is high, the portal may be blocking Fly.io IPs too
4. Solution: Try different Fly.io region or use residential proxy service

### Slow response times

This is intentional! The proxy adds delays (100ms-5000ms) to avoid detection. If it's too slow:
1. Check stats to see current delay
2. If delay is high, it means portal was returning 403s recently
3. Wait for it to recover - delay will decrease as success rate improves

## Scaling

Free tier limits:
- 3 shared CPU VMs
- 256MB RAM each
- 160GB outbound transfer/month

For more traffic:
```bash
flyctl scale count 2 # Run 2 instances
flyctl scale memory 512 # Increase RAM to 512MB
```

## Costs

**Free tier should handle:**
- ~10,000 MAC operations per month
- Moderate user traffic
- Basic monitoring

**If you exceed free tier**, costs are ~$5-10/month for small scale.

## Advanced Configuration

### Change Region

```bash
flyctl regions list # See all regions
flyctl regions set ams fra # Set Amsterdam and Frankfurt
```

### Environment Variables

Edit `fly.toml` or use:
```bash
flyctl secrets set NODE_ENV=production
```

## Security

The proxy is open to anyone who knows the URL. To add authentication:

1. Add API key check in `index.js`:
```javascript
const API_KEY = process.env.PROXY_API_KEY;
if (req.headers['x-api-key'] !== API_KEY) {
  return res.status(401).json({ error: 'Unauthorized' });
}
```

2. Set secret:
```bash
flyctl secrets set PROXY_API_KEY=your-secret-key
```

3. Update Cloudflare Workers Stalker API to send the key

## Support

- Check logs: `flyctl logs`
- Check status: `flyctl status`
- SSH into VM: `flyctl ssh console`
- Restart: `flyctl apps restart`

## License

MIT
