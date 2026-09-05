import express from 'express';

import { cleanupStaleFiles } from './services/cleanup.js';
import { CLEANUP_INTERVAL_MS } from './config/constants.js';
import { generalLimiter } from './middleware/rateLimiters.js';

import healthRoutes from './routes/health.js';
import debugRoutes from './routes/debug.js';
import convertRoutes from './routes/convert.js';
import billingRoutes from './routes/billing.js';
import accountRoutes from './routes/account.js';
import webhookRoutes from './routes/webhooks.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Render sits behind a proxy (like most PaaS), so Express needs this to
// read the real client IP from X-Forwarded-For instead of seeing every
// request as coming from the proxy itself -- required for
// express-rate-limit to key by IP correctly.
app.set('trust proxy', 1);

// /health is mounted before generalLimiter deliberately -- uptime
// monitors and Render's own health checks can be frequent and should
// never get throttled.
app.use(healthRoutes);

app.use(generalLimiter);

// Everything mounted from here down inherits generalLimiter, since
// Express applies middleware in the order it's registered regardless
// of which file the route itself is defined in.
app.use(debugRoutes);
app.use(convertRoutes);
app.use(billingRoutes);
app.use(accountRoutes);
app.use(webhookRoutes);

app.listen(PORT, () => {
  console.log(`Converter backend running on http://localhost:${PORT}`);

  // Run once immediately on startup -- catches anything left behind
  // by a crash or redeploy before the first interval tick, then keep
  // sweeping periodically for the lifetime of the process.
  cleanupStaleFiles();
  setInterval(cleanupStaleFiles, CLEANUP_INTERVAL_MS);
});
