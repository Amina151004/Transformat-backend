import { supabase } from '../lib/clients.js';

// Verifies the Supabase access token the Flutter app sends and attaches
// the user id to the request. Runs before /convert (and other
// user-scoped routes) do anything else.
export async function requireUser(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }
  const token = authHeader.slice(7);

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  req.userId = data.user.id;
  next();
}
