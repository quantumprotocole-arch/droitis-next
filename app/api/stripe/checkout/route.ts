// app/api/stripe/checkout/route.ts
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createClient as createSupabaseAdminClient } from '@supabase/supabase-js';
import { getStripe } from '@/lib/stripe';
import Stripe from 'stripe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) throw new Error('Missing SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL');
  if (!serviceKey) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY');

  return createSupabaseAdminClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// Permet de tester dans le navigateur sans déclencher un POST
export async function GET() {
  return NextResponse.json(
    {
      ok: false,
      message: 'Use POST (this endpoint creates a Stripe Checkout Session).',
      method: 'GET',
    },
    { status: 405 }
  );
}

export async function POST(req: Request) {
  try {
    // 1) user session (SSR)
    const supabase = createClient();
    const { data: { user }, error: userErr } = await supabase.auth.getUser();

    if (userErr || !user) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }

    // 2) env checks
    const priceId = process.env.STRIPE_PRICE_ID_PRO;
    if (!priceId) {
      return NextResponse.json({ error: 'Missing STRIPE_PRICE_ID_PRO' }, { status: 500 });
    }

    let stripe: Stripe;
    try {
      stripe = getStripe();
    } catch (e: any) {
      return NextResponse.json({ error: e?.message ?? 'Missing STRIPE_SECRET_KEY' }, { status: 500 });
    }

    let admin;
    try {
      admin = getSupabaseAdmin();
    } catch (e: any) {
      return NextResponse.json({ error: e?.message ?? 'Missing Supabase admin env' }, { status: 500 });
    }

    const origin = new URL(req.url).origin;

    // 3) find/create customer
    const { data: existing, error: existingErr } = await admin
      .from('customers')
      .select('customer_id')
      .eq('user_id', user.id)
      .maybeSingle();

    if (existingErr) {
      return NextResponse.json({ error: 'db_error', details: existingErr.message }, { status: 500 });
    }

    let customerId = existing?.customer_id ?? null;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email ?? undefined,
        metadata: { user_id: user.id },
      });
      customerId = customer.id;

      const { error: upErr } = await admin
        .from('customers')
        .upsert({ user_id: user.id, customer_id: customerId }, { onConflict: 'user_id' });

      if (upErr) {
        return NextResponse.json({ error: 'db_error', details: upErr.message }, { status: 500 });
      }
    }

    // 4) create checkout session (subscription)
    // Stripe API: Checkout Session create. :contentReference[oaicite:3]{index=3}
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${origin}/app?checkout=success`,
      cancel_url: `${origin}/app?checkout=cancel`,
      allow_promotion_codes: true,
      client_reference_id: user.id,
      metadata: { user_id: user.id },
      subscription_data: { metadata: { user_id: user.id } },
    });

    if (!session.url) {
      return NextResponse.json({ error: 'Missing session.url' }, { status: 500 });
    }

    return NextResponse.redirect(session.url, { status: 303 });
  } catch (err: any) {
    // Important: visible dans Vercel Functions Logs
    console.error('[stripe.checkout] unhandled', err);

    // Stripe errors: souvent "No such price" quand price/test-live mismatch
    const stripeMsg =
      err && typeof err === 'object' && 'message' in err ? String((err as any).message) : null;

    return NextResponse.json(
      {
        error: 'checkout_failed',
        details: stripeMsg ?? (err?.message ?? String(err)),
        hint: 'Check STRIPE_SECRET_KEY mode and STRIPE_PRICE_ID_PRO (test vs live), and SUPABASE_SERVICE_ROLE_KEY in Preview.',
      },
      { status: 500 }
    );
  }
}
