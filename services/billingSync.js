import { supabase } from '../lib/clients.js';

// Keeps profiles.plan and profiles.pro_expires_at in sync with Stripe's
// view of the subscription, whatever triggered the event.
export async function syncSubscriptionToProfile(subscription) {
  const { data: profile } = await supabase
    .from('profiles')
    .select('id')
    .eq('stripe_customer_id', subscription.customer)
    .single();

  if (!profile) return;

  const isActive = ['active', 'trialing'].includes(subscription.status);

  // As of Stripe's Basil API version (2025-03-31), current_period_end
  // no longer lives on the subscription object itself -- it moved to
  // each subscription item. Falling back to the old top-level field
  // too in case this ever runs against an older API version.
  const periodEndSeconds =
    subscription.items?.data?.[0]?.current_period_end ??
    subscription.current_period_end;

  const expiresAt = periodEndSeconds
    ? new Date(periodEndSeconds * 1000).toISOString()
    : null;

  await supabase
    .from('profiles')
    .update({
      plan: isActive ? 'pro' : 'free',
      pro_expires_at: isActive ? expiresAt : null,
    })
    .eq('id', profile.id);
}

// Flips profiles.payment_failed to true/false based on invoice events,
// so the app can show (or clear) a "update your payment method"
// warning. Looked up by customer id, same pattern as
// syncSubscriptionToProfile.
export async function setPaymentFailed(customerId, failed) {
  const { data: profile } = await supabase
    .from('profiles')
    .select('id')
    .eq('stripe_customer_id', customerId)
    .single();

  if (!profile) return;

  await supabase
    .from('profiles')
    .update({ payment_failed: failed })
    .eq('id', profile.id);
}