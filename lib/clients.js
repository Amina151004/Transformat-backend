import { createClient } from '@supabase/supabase-js';
import ws from 'ws';
import Stripe from 'stripe';

// Service role client -- bypasses RLS entirely, used only server-side.
// Every route/service that needs Supabase imports this single
// instance rather than creating its own client.
export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { realtime: { transport: ws } }
);

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
