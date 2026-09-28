import express from 'express';
import rateLimit from 'express-rate-limit';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT || 8080;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

    // Extract MAC address for per-MAC rate limiting
    const macAddress = req.headers['cookie']?.match(/mac=([^;]+)/)?.[1];
    
    // Per-MAC rate limiting
    if (macAddress) {
      await waitForMacRateLimit(macAddress);
    }

    // Smart delay based on current 403 rate
    const baseDelay = requestStats.delayMs;
    const jitter = Math.floor(Math.random() * 100); // Add 0-100ms random jitter
    const totalDelay = baseDelay + jitter;
    
    console.log(`⏱️  Adding ${totalDelay}ms delay (base: ${baseDelay}ms, jitter: ${jitter}ms)`);
    await new Promise(resolve => setTimeout(resolve, totalDelay));

    // Forward headers (except host/connection)
    const forwardHeaders = { ...req.headers };
    delete forwardHeaders['host'];
    delete forwardHeaders['connection'];
    delete forwardHeaders['x-target-url'];
    delete forwardHeaders['content-length'];

    // Make request to portal
    console.log(`🌐 Proxying ${req.method} ${targetUrl}`);
    const startTime = Date.now();
    
    const response = await fetch(targetUrl, {
      method: req.method,
      headers: forwardHeaders,
      body: req.method !== 'GET' && req.method !== 'HEAD' ? JSON.stringify(req.body) : undefined,
      signal: AbortSignal.timeout(30000)
    });

    const duration = Date.now() - startTime;
    requestStats.totalRequests++;

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
      console.log(`✅ Success (${duration}ms)`);
      
      // Reset backoff on success
      if (requestStats.backoffUntil) {
        requestStats.backoffUntil = null;
        console.log(`✅ Backoff cleared after successful request`);
      }
    }

    // Every 10 requests, adjust delay based on 403 rate
    if (requestStats.totalRequests % 10 === 0) {
      adjustDelay();
    }

    // Forward response
    const body = await response.text();
    
    // Log response details for debugging
    if (response.status === 200) {
      console.log(`📝 Response preview: ${body.substring(0, 300)}${body.length > 300 ? '...' : ''}`);
      
      // Try to parse as JSON and show structure
      try {
        const jsonData = JSON.parse(body);
        console.log(`📦 Response structure:`, JSON.stringify(jsonData, null, 2).substring(0, 500));
      } catch (e) {
        console.log(`⚠️  Response is not JSON`);
      }
    }
    
    // Copy response headers
    response.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });

    // Explicitly set content-type to application/json for JSON responses
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      res.type('application/json');
    } else if (body.trim().startsWith('{') || body.trim().startsWith('[')) {
      // If response looks like JSON but content-type wasn't set
      res.type('application/json');
    }

    res.status(response.status).send(body);

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
