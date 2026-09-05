import { Router } from 'express';
import os from 'os';

// Split from debug.js deliberately: /health has no rate limiter (see
// server.js -- it's mounted before generalLimiter) since uptime
// monitors and Render's own health checks can be frequent and should
// never get throttled.
const router = Router();

router.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

export default router;
