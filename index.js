import express from 'express';
import rateLimit from 'express-rate-limit';
import fetch from 'node-fetch';
import jwt from 'jsonwebtoken';
import http from 'http';
import https from 'https';

const app = express();
const PORT = process.env.PORT || 8080;

// HTTP Keep-Alive agents for connection reuse (reduces latency)
const httpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 1000,
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: 60000
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 1000,
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: 60000
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Trust proxy - Railway uses 1 proxy layer
app.set('trust proxy', 1);

// Global state for smart throttling
const requestStats = {
  totalRequests: 0,
  forbiddenCount: 0,
  lastForbidden: null,
  backoffUntil: null,
  delayMs: 100 // Start with 100ms base delay
};

// Per-MAC request tracking
const macRequestTimes = new Map();

// Helper: Detect video streaming requests (should skip delays)
function isVideoStreamRequest(url) {
  return url.includes('/play/live.php') || 
         url.includes('extension=ts') ||
         url.includes('extension=m3u8');
}

// Rate limiter: Max 30 requests per minute globally
const globalLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30,
  message: { error: 'Too many requests, please slow down' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Helper: Random delay between min and max ms
function randomDelay(min, max) {
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise(resolve => setTimeout(resolve, delay));
}

// Helper: Check if we should back off due to recent 403s
function shouldBackoff() {
  if (requestStats.backoffUntil && Date.now() < requestStats.backoffUntil) {
    return true;
  }
  return false;
}

// Helper: Adjust delay based on 403 rate
function adjustDelay() {
  const forbiddenRate = requestStats.totalRequests > 0 
    ? requestStats.forbiddenCount / requestStats.totalRequests 
    : 0;
  
  if (forbiddenRate > 0.3) {
    // More than 30% 403s - increase delay significantly
    requestStats.delayMs = Math.min(5000, requestStats.delayMs * 2);
    console.log(`⚠️  High 403 rate (${(forbiddenRate * 100).toFixed(1)}%) - increasing delay to ${requestStats.delayMs}ms`);
  } else if (forbiddenRate > 0.1) {
    // More than 10% 403s - increase delay moderately
    requestStats.delayMs = Math.min(2000, requestStats.delayMs * 1.5);
    console.log(`⚠️  Elevated 403 rate (${(forbiddenRate * 100).toFixed(1)}%) - increasing delay to ${requestStats.delayMs}ms`);
  } else if (forbiddenRate < 0.05 && requestStats.delayMs > 100) {
    // Less than 5% 403s and we have extra delay - reduce it
    requestStats.delayMs = Math.max(100, requestStats.delayMs * 0.9);
  }
}

// Helper: Per-MAC rate limiting (max 1 request per 2 seconds per MAC)
async function waitForMacRateLimit(macAddress) {
  if (!macAddress) return;
  
  const lastRequest = macRequestTimes.get(macAddress);
  if (lastRequest) {
    const timeSince = Date.now() - lastRequest;
    const minInterval = 2000; // 2 seconds between requests for same MAC
    
    if (timeSince < minInterval) {
      const waitTime = minInterval - timeSince;
      console.log(`⏳ MAC ${macAddress} - waiting ${waitTime}ms (rate limit)`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }
  
  macRequestTimes.set(macAddress, Date.now());
  
  // Cleanup old entries (older than 5 minutes)
  const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
  for (const [mac, time] of macRequestTimes.entries()) {
    if (time < fiveMinutesAgo) {
      macRequestTimes.delete(mac);
    }
  }
}

// Health check endpoint
app.get('/health', (req, res) => {
  const forbiddenRate = requestStats.totalRequests > 0 
    ? (requestStats.forbiddenCount / requestStats.totalRequests * 100).toFixed(1)
    : 0;
  
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    stats: {
      totalRequests: requestStats.totalRequests,
      forbiddenCount: requestStats.forbiddenCount,
      forbiddenRate: `${forbiddenRate}%`,
      currentDelay: `${requestStats.delayMs}ms`,
      backedOff: shouldBackoff(),
      backoffUntil: requestStats.backoffUntil ? new Date(requestStats.backoffUntil).toISOString() : null
    }
  });
});

// Stats endpoint
app.get('/stats', (req, res) => {
  const forbiddenRate = requestStats.totalRequests > 0 
    ? (requestStats.forbiddenCount / requestStats.totalRequests * 100).toFixed(1)
    : 0;
  
  res.json({
    stats: requestStats,
    forbiddenRate: `${forbiddenRate}%`,
    activeMacs: macRequestTimes.size,
    recommendations: {
      status: forbiddenRate > 10 ? 'warning' : 'healthy',
      message: forbiddenRate > 10 
        ? 'High 403 rate detected - consider reducing request frequency'
        : 'Operating normally'
    }
  });
});

// M3U Stream endpoint - validates token and streams from portal
app.get('/stream/:token', globalLimiter, async (req, res) => {
  try {
    const token = req.params.token;
    
    // Verify JWT token
    const JWT_SECRET = process.env.JWT_SECRET;
    if (!JWT_SECRET) {
      console.error('❌ JWT_SECRET not configured');
      return res.status(500).json({ error: 'Server configuration error' });
    }
    
    let tokenData;
    try {
      tokenData = jwt.verify(token, JWT_SECRET);
    } catch (error) {
      console.error('❌ Invalid token:', error.message);
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    
    const { channelCmd, userMac } = tokenData;
    
    if (!channelCmd || !userMac) {
      console.error('❌ Missing channelCmd or userMac in token');
      return res.status(400).json({ error: 'Invalid token data' });
    }
    
    // Extract portal URL from channelCmd (remove "ffmpeg " prefix if present)
    let portalUrl = channelCmd;
    if (portalUrl.startsWith('ffmpeg ')) {
      portalUrl = portalUrl.substring(7);
    }
    
    // Replace caching MAC with user's MAC
    const macPattern = /mac=([0-9A-Fa-f]{2}:[0-9A-Fa-f]{2}:[0-9A-Fa-f]{2}:[0-9A-Fa-f]{2}:[0-9A-Fa-f]{2}:[0-9A-Fa-f]{2})/;
    portalUrl = portalUrl.replace(macPattern, `mac=${userMac}`);
    
    console.log(`🎬 Streaming channel for MAC: ${userMac}`);
    
    // Per-MAC rate limiting
    const macAddress = portalUrl.match(/mac=([^&]+)/)?.[1];
    if (macAddress) {
      await waitForMacRateLimit(macAddress);
    }
    
    // Check if we're in backoff mode
    if (shouldBackoff()) {
      const waitTime = requestStats.backoffUntil - Date.now();
      console.log(`🛑 In backoff mode - ${waitTime}ms remaining`);
      return res.status(503).json({ 
        error: 'Service temporarily throttled',
        retryAfter: Math.ceil(waitTime / 1000)
      });
    }
    
    // Smart delay
    const baseDelay = requestStats.delayMs;
    const jitter = Math.floor(Math.random() * 100);
    const totalDelay = baseDelay + jitter;
    
    await new Promise(resolve => setTimeout(resolve, totalDelay));
    
    // Fetch from portal
    console.log(`🌐 Fetching stream from portal`);
    const startTime = Date.now();
    
    const response = await fetch(portalUrl, {
      method: 'GET',
      headers: {
        'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0',
        'Range': req.headers['range'] || ''
      },
      signal: AbortSignal.timeout(30000)
    });
    
    const duration = Date.now() - startTime;
    requestStats.totalRequests++;
    
    // Handle 403
    if (response.status === 403) {
      requestStats.forbiddenCount++;
      requestStats.lastForbidden = Date.now();
      console.error(`❌ 403 Forbidden from portal`);
      
      if (requestStats.forbiddenCount >= 3 && 
          requestStats.totalRequests - requestStats.forbiddenCount < 2) {
        requestStats.backoffUntil = Date.now() + 30000;
      }
      
      adjustDelay();
      return res.status(403).json({ error: 'Portal access denied' });
    }
    
    if (!response.ok) {
      console.error(`❌ Portal returned ${response.status}`);
      return res.status(response.status).json({ error: 'Portal request failed' });
    }
    
    console.log(`✅ Stream success (${duration}ms)`);
    
    // Reset backoff on success
    if (requestStats.backoffUntil) {
      requestStats.backoffUntil = null;
    }
    
    // Stream response back to player
    res.status(response.status);
    res.set('Content-Type', response.headers.get('content-type') || 'video/mp2t');
    res.set('Accept-Ranges', 'bytes');
    res.set('Cache-Control', 'no-cache');
    
    if (response.headers.get('content-length')) {
      res.set('Content-Length', response.headers.get('content-length'));
    }
    
    // Pipe the response body
    response.body.pipe(res);
    
  } catch (error) {
    console.error('❌ Stream error:', error.message);
    res.status(500).json({ 
      error: 'Stream failed',
      message: error.message 
    });
  }
});

// Main proxy endpoint
app.all('/proxy', globalLimiter, async (req, res) => {
  try {
    // Check if we're in backoff mode
    if (shouldBackoff()) {
      const waitTime = requestStats.backoffUntil - Date.now();
      console.log(`🛑 In backoff mode - ${waitTime}ms remaining`);
      return res.status(503).json({ 
        error: 'Service temporarily throttled due to portal rate limiting',
        retryAfter: Math.ceil(waitTime / 1000),
        message: 'Please retry in a few seconds'
      });
    }

    // Get target URL from header or body
    const targetUrl = req.headers['x-target-url'] || req.body?.url;
    if (!targetUrl) {
      return res.status(400).json({ 
        error: 'Missing target URL',
        usage: 'Set X-Target-URL header or send url in body'
      });
    }

    // Detect if this is a video streaming request
    const isVideoStream = isVideoStreamRequest(targetUrl);

    // Extract MAC address for per-MAC rate limiting
    const macAddress = req.headers['cookie']?.match(/mac=([^;]+)/)?.[1];
    
    // Per-MAC rate limiting (skip for video streams to avoid buffering)
    if (macAddress && !isVideoStream) {
      await waitForMacRateLimit(macAddress);
    }

    // Smart delay based on current 403 rate (skip for video streams to reduce latency)
    if (!isVideoStream) {
      const baseDelay = requestStats.delayMs;
      const jitter = Math.floor(Math.random() * 100); // Add 0-100ms random jitter
      const totalDelay = baseDelay + jitter;
      
      console.log(`⏱️  Adding ${totalDelay}ms delay (base: ${baseDelay}ms, jitter: ${jitter}ms)`);
      await new Promise(resolve => setTimeout(resolve, totalDelay));
    } else {
      console.log(`⚡ Video stream detected - skipping delays for optimal performance`);
    }

    // Forward headers (except host/connection)
    const forwardHeaders = { ...req.headers };
    delete forwardHeaders['host'];
    delete forwardHeaders['connection'];
    delete forwardHeaders['x-target-url'];
    delete forwardHeaders['content-length'];

    // Make request to portal
    console.log(`🌐 Proxying ${req.method} ${targetUrl}`);
    const startTime = Date.now();
    
    // Build fetch options
    const fetchOptions = {
      method: req.method,
      headers: forwardHeaders,
      body: req.method !== 'GET' && req.method !== 'HEAD' ? JSON.stringify(req.body) : undefined,
      agent: targetUrl.startsWith('https') ? httpsAgent : httpAgent
    };
    
    // Only add timeout for non-video requests (video streams need to stay open indefinitely)
    if (!isVideoStream) {
      fetchOptions.signal = AbortSignal.timeout(30000);
      console.log(`⏱️  30s timeout set for non-video request`);
    } else {
      console.log(`♾️  No timeout - video stream can run indefinitely`);
    }
    
    const response = await fetch(targetUrl, fetchOptions);

    const duration = Date.now() - startTime;
    requestStats.totalRequests++;

    // Log response status for debugging
    console.log(`📡 Response: ${response.status} ${response.statusText} (${duration}ms)`);

    // Check for 403 and handle it
    if (response.status === 403) {
      requestStats.forbiddenCount++;
      requestStats.lastForbidden = Date.now();
      
      console.error(`❌ 403 Forbidden received (${requestStats.forbiddenCount}/${requestStats.totalRequests})`);
      
      // If we get 3 403s in a row, trigger backoff
      if (requestStats.forbiddenCount >= 3 && 
          requestStats.totalRequests - requestStats.forbiddenCount < 2) {
        const backoffDuration = 30000; // 30 seconds
        requestStats.backoffUntil = Date.now() + backoffDuration;
        console.error(`🛑 Multiple 403s detected - backing off for ${backoffDuration}ms`);
      }
      
      adjustDelay();
    } else if (response.status === 200) {
      console.log(`✅ Success`);
      
      // Reset backoff on success
      if (requestStats.backoffUntil) {
        requestStats.backoffUntil = null;
        console.log(`✅ Backoff cleared after successful request`);
      }
    } else {
      console.warn(`⚠️  Non-200 status: ${response.status}`);
    }

    // Every 10 requests, adjust delay based on 403 rate
    if (requestStats.totalRequests % 10 === 0) {
      adjustDelay();
    }

    // Check content type to determine if we should buffer or stream
    const contentType = response.headers.get('content-type') || '';
    console.log(`📋 Content-Type: "${contentType}"`);
    
    const isStreamable = contentType.includes('video') || 
                         contentType.includes('mpegurl') || 
                         contentType.includes('octet-stream') ||
                         contentType.includes('mp2t');
    
    console.log(`🔍 Is streamable: ${isStreamable}`);

    if (isStreamable) {
      // Stream video content directly without buffering
      console.log(`🎥 Streaming ${contentType} response`);
      
      res.status(response.status);
      res.set('Content-Type', contentType);
      res.set('Accept-Ranges', 'bytes');
      res.set('Cache-Control', 'no-cache');
      
      if (response.headers.get('content-length')) {
        res.set('Content-Length', response.headers.get('content-length'));
      }
      
      // Pipe the response body with proper cleanup to prevent memory leaks
      response.body.pipe(res);
      
      // Handle stream errors
      response.body.on('error', (err) => {
        console.error('❌ Stream error:', err.message);
        if (!res.headersSent) {
          res.status(500).end();
        }
        // Ensure stream is destroyed
        if (!response.body.destroyed) {
          response.body.destroy();
        }
      });
      
      // Cleanup when client disconnects or stream finishes
      res.on('close', () => {
        if (!response.body.destroyed) {
          response.body.destroy();
        }
      });
      
      res.on('finish', () => {
        if (!response.body.destroyed) {
          response.body.destroy();
        }
      });
    } else {
      // Buffer text/JSON responses
      const body = await response.text();
      
      // Log response details for debugging
      if (response.status === 200) {
        console.log(`📝 Response preview: ${body.substring(0, 300)}${body.length > 300 ? '...' : ''}`);
      }
      
      // Try to parse and forward as JSON (most portal responses are JSON)
      try {
        const jsonData = JSON.parse(body);
        console.log(`📦 Response is JSON, forwarding with res.json()`);
        return res.status(response.status).json(jsonData);
      } catch (e) {
        console.log(`⚠️  Response is not JSON, forwarding as text`);
      }

      // If not JSON, forward as plain text
      res.status(response.status)
         .type(contentType || 'text/plain')
         .send(body);
    }

  } catch (error) {
    console.error('❌ Proxy error:', error.message);
    res.status(500).json({ 
      error: 'Proxy request failed',
      message: error.message 
    });
  }
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 StreamNexus Portal Proxy running on port ${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
  console.log(`📈 Statistics: http://localhost:${PORT}/stats`);
  console.log(`🔒 Features: Rate limiting, smart delays, 403 detection & backoff`);
});
