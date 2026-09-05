import { Router } from 'express';
import { supabase, stripe } from '../lib/clients.js';
import { requireUser } from '../middleware/requireUser.js';

const router = Router();

// DELETE /account
// Permanently deletes the caller's account. Best-effort cancels any
// active Stripe subscription first so they don't keep getting billed
// after their account is gone -- if that step fails, we log it and
// still proceed with deletion rather than trap the user who asked to
// leave, but you may want to alert yourself (e.g. via error logging)
// so you can refund/cancel manually if this ever fires.
router.delete('/account', requireUser, async (req, res) => {
  try {
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('stripe_customer_id')
      .eq('id', req.userId)
      .single();

    if (profileError) {
      console.error('Could not load profile before deletion:', profileError.message);
    }

    // Deleting a Stripe customer also cancels any subscriptions attached
    // to them, so this one call handles cleanup without needing to list
    // and cancel subscriptions individually.
    if (profile?.stripe_customer_id) {
      try {
        await stripe.customers.del(profile.stripe_customer_id);
      } catch (stripeErr) {
        console.error(
          `Stripe cleanup failed for user ${req.userId}, customer ${profile.stripe_customer_id}:`,
          stripeErr.message
        );
        // Continue anyway -- see comment above the route.
      }
    }

    // Deletes the auth.users row. If profiles/usage have a foreign key
    // to auth.users with ON DELETE CASCADE, their rows go with it.
    // Worth confirming that in Supabase -- if it's not set up, delete
    // from those tables explicitly here before this call.
    const { error: deleteError } = await supabase.auth.admin.deleteUser(req.userId);

    if (deleteError) {
      console.error('Account deletion failed:', deleteError.message);
      return res.status(500).json({ error: 'Could not delete account' });
    }

    return res.status(204).send();
  } catch (err) {
    console.error('Account deletion error:', err.message);
    return res.status(500).json({ error: 'Could not delete account' });
  }
});

export default router;
