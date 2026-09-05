import rateLimit from 'express-rate-limit';

// General baseline across the whole API -- catches abuse of the
// lighter-weight routes (checkout, account deletion, etc). Generous
// since it's just a backstop, not the primary defense.
export const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

// /convert specifically spins up LibreOffice or a Python subprocess --
// by far the most expensive thing this server does, and on Render's
// free 512MB instance a burst of these could OOM the whole process.
// This is deliberately stricter than increment_usage_if_allowed's
// monthly quota: that guards against long-term overuse, this guards
// against short bursts hammering the machine within seconds/minutes,
// which the monthly counter alone wouldn't catch in time. Keyed by IP
// since it runs before requireUser resolves a user id.
export const convertLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many conversion requests. Please wait a bit and try again.', code: 'RATE_LIMITED' },
});
