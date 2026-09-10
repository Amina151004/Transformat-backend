import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

// ES modules don't have __dirname by default -- this reconstructs it
// from the current file's URL so sendFile can resolve paths reliably
// regardless of where the process is started from.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

router.get('/privacy', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'privacy-policy.html'));
});

router.get('/terms', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'terms-of-service.html'));
});

router.get('/reset-password', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, '..', 'public', 'reset-password.html'));
});

export default router;