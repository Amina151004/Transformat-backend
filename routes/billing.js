import { Router } from 'express';
import express from 'express';
import { supabase, stripe } from '../lib/clients.js';
import { requireUser } from '../middleware/requireUser.js';

const router = Router();

router.get('/checkout-success', (req, res) => {
  res.send(
    '<html><body style="font-family:sans-serif;text-align:center;padding-top:60px;">' +
    '<h2>Payment successful 🎉</h2><p>You can return to the app now.</p></body></html>'
  );
});

router.get('/checkout-cancel', (req, res) => {
  res.send(
    '<html><body style="font-family:sans-serif;text-align:center;padding-top:60px;">' +
    '<h2>Checkout canceled</h2><p>You can return to the app.</p></body></html>'
  );
});

// Creates a Stripe Checkout session for the logged-in user and returns its URL.
router.post('/create-checkout-session', express.json(), requireUser, async (req, res) => {
  try {
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('stripe_customer_id')
      .eq('id', req.userId)
      .single();

    if (profileError) throw profileError;

    let customerId = profile.stripe_customer_id;

    // First-time upgrader: create a Stripe customer and remember it.
    if (!customerId) {
      const customer = await stripe.customers.create({
        metadata: { supabase_user_id: req.userId },
      });
      customerId = customer.id;

      await supabase
        .from('profiles')
        .update({ stripe_customer_id: customerId })
        .eq('id', req.userId);
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url: 'https://transformat-backend.onrender.com/checkout-success',
      cancel_url: 'https://transformat-backend.onrender.com/checkout-cancel',
      metadata: { supabase_user_id: req.userId },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Checkout session creation failed:', err.message);
    res.status(500).json({ error: 'Could not start checkout' });
  }
});

// POST /cancel-subscription
// Sets the user's active subscription to cancel at the end of the
// current billing period, rather than cancelling immediately -- they
// keep Pro access through what they already paid for. The webhook
// handler already listens for 'customer.subscription.updated' and
// 'customer.subscription.deleted' and calls syncSubscriptionToProfile,
// so profiles.plan flips to 'free' on its own once the period
// actually ends. No extra sync logic is needed here.
router.post('/cancel-subscription', express.json(), requireUser, async (req, res) => {
  try {
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('stripe_customer_id')
      .eq('id', req.userId)
      .single();

    if (profileError) throw profileError;
    if (!profile?.stripe_customer_id) {
      return res.status(400).json({ error: 'No active subscription found' });
    }

    const subscriptions = await stripe.subscriptions.list({
      customer: profile.stripe_customer_id,
      status: 'active',
      limit: 1,
    });

    const subscription = subscriptions.data[0];
    if (!subscription) {
      return res.status(400).json({ error: 'No active subscription found' });
    }

    await stripe.subscriptions.update(subscription.id, {
      cancel_at_period_end: true,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('Subscription cancellation failed:', err.message);
    res.status(500).json({ error: 'Could not cancel subscription' });
  }
});

// POST /billing-portal
// Returns a URL to Stripe's hosted Billing Portal, where the user can
// update their card, view invoices, etc. This is the actual fix for a
// failed payment -- pairs with the payment_failed flag on profiles:
// the app shows a warning when it's true, and this is where the
// "Update payment method" button sends them.
router.post('/billing-portal', express.json(), requireUser, async (req, res) => {
  try {
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('stripe_customer_id')
      .eq('id', req.userId)
      .single();

    if (profileError) throw profileError;
    if (!profile?.stripe_customer_id) {
      return res.status(400).json({ error: 'No billing account found' });
    }

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: profile.stripe_customer_id,
      return_url: 'https://transformat-backend.onrender.com/checkout-success',
    });

    res.json({ url: portalSession.url });
  } catch (err) {
    console.error('Billing portal session creation failed:', err.message);
    res.status(500).json({ error: 'Could not open billing portal' });
  }
});

export default router;
