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
  const expiresAt = subscription.current_period_end
    ? new Date(subscription.current_period_end * 1000).toISOString()
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
