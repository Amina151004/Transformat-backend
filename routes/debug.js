import { Router } from 'express';
import os from 'os';

const router = Router();

// This endpoint exposes internal server metrics (RAM usage, heap
// size), which is genuinely useful for watching Render's 512MB free
// tier -- but must never be reachable by anyone who just knows the
// URL. Protected by a shared secret rather than requireUser, since
// this is an operator/debugging tool, not something tied to a
// Supabase user account.
//
// Set DEBUG_KEY in Render's environment variables to any long random
// string, then check memory with:
//   curl -H "x-debug-key: <the value you set>" https://your-app.onrender.com/debug/mem
function requireDebugKey(req, res, next) {
  const providedKey = req.headers['x-debug-key'];
  if (!process.env.DEBUG_KEY || providedKey !== process.env.DEBUG_KEY) {
    // Same 404 whether the key is missing, wrong, or DEBUG_KEY isn't
    // configured at all -- a 401/403 would confirm to a prober that
    // this endpoint exists and is worth attacking further. A 404
    // makes it indistinguishable from a route that was never defined.
    return res.status(404).json({ error: 'Not found' });
  }
  next();
}

router.get('/debug/mem', requireDebugKey, (req, res) => {
  const used = process.memoryUsage();
  res.json({
    rss: `${Math.round(used.rss / 1024 / 1024)} MB`,
    heapUsed: `${Math.round(used.heapUsed / 1024 / 1024)} MB`,
    freeSystemMemMB: Math.round(os.freemem() / 1024 / 1024),
    totalSystemMemMB: Math.round(os.totalmem() / 1024 / 1024),
  });
});

export default router;