import { Router } from 'express';
import express from 'express';
import { supabase, stripe } from '../lib/clients.js';
import { syncSubscriptionToProfile, setPaymentFailed } from '../services/billingSync.js';

const router = Router();

// Stripe calls this when a payment or subscription event happens.
// express.raw is required here (not express.json) — Stripe's signature
// check needs the exact raw request body, not a parsed/re-serialized one.
// Mounted after generalLimiter in server.js, but Stripe retries failed
// webhooks on its own schedule -- if you see missed events in Stripe's
// dashboard under load, exclude this route from the limiter too.
router.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Idempotency check: Stripe retries webhooks on any non-200 response
  // (and sometimes just due to network flakiness on their end), so the
  // same event.id can arrive more than once. Recording it here means a
  // retry is recognized and skipped instead of reapplied.
  const { error: dedupeError } = await supabase
    .from('stripe_webhook_events')
    .insert({ event_id: event.id });

  if (dedupeError) {
    // Unique violation (code 23505) means we've already processed this
    // exact event -- that's expected on a retry, not a real error.
    // Anything else is a genuine DB problem and should surface as one.
    if (dedupeError.code === '23505') {
      return res.json({ received: true, duplicate: true });
    }
    console.error('Could not record webhook event, processing anyway:', dedupeError.message);
    // Fall through rather than block on a logging failure -- worst
    // case here is a duplicate is processed, not that a real payment
    // event gets dropped.
  }

  // Wrapped in try/catch so a transient failure (e.g. Supabase being
  // briefly unreachable) surfaces as a 500. Stripe interprets that as
  // "retry me later" and will keep trying for up to three days --
  // silently swallowing an error here would leave profiles.plan stale
  // with no way to recover short of a manual fix.
  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      if (session.subscription) {
        const subscription = await stripe.subscriptions.retrieve(session.subscription);
        await syncSubscriptionToProfile(subscription);
      }
    }

    if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
      await syncSubscriptionToProfile(event.data.object);
    }

    if (event.type === 'invoice.payment_failed') {
      // Stripe's own retry schedule (Smart Retries) will keep trying
      // the card automatically, and a subsequent
      // customer.subscription.updated event will flip profiles.plan
      // to 'free' once the subscription actually lapses to
      // past_due/unpaid. payment_failed is set immediately though, so
      // the app can warn the user well before that happens -- waiting
      // for the plan to actually lapse would be too late to help them
      // avoid it.
      const invoice = event.data.object;
      console.warn(
        `Payment failed for customer ${invoice.customer}, invoice ${invoice.id}`
      );
      await setPaymentFailed(invoice.customer, true);
    }

    if (event.type === 'invoice.payment_succeeded') {
      // Clears the warning once a payment actually goes through --
      // covers both "fixed their card and Stripe's retry succeeded"
      // and the normal case of every renewal that just works.
      const invoice = event.data.object;
      await setPaymentFailed(invoice.customer, false);
    }

    res.json({ received: true });
  } catch (err) {
    console.error(`Webhook handler failed for event ${event.id} (${event.type}):`, err.message);
    res.status(500).json({ error: 'Webhook handler failed' });
  }
});

export default router;
