// app/api/stripe/checkout/route.ts
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createSupabaseAdminClient } from '@supabase/supabase-js'
import { getStripe } from '@/lib/stripe'
import Stripe from 'stripe'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url) throw new Error('Missing SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL')
  if (!serviceKey) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY')

  return createSupabaseAdminClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

export async function POST(req: Request) {
  // Auth user via SSR cookies; getUser recommandé côté serveur. :contentReference[oaicite:6]{index=6}
  const supabase = createClient()
  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser()

  if (userErr || !user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const priceId = process.env.STRIPE_PRICE_ID_PRO
  if (!priceId) {
    return NextResponse.json({ error: 'Missing STRIPE_PRICE_ID_PRO' }, { status: 500 })
  }

  let stripe: Stripe
  try {
    stripe = getStripe()
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'Missing STRIPE_SECRET_KEY' }, { status: 500 })
  }

  const origin = new URL(req.url).origin
  const admin = getSupabaseAdmin()

  // 1) retrouver customer Stripe (ou créer)
  const { data: existing, error: existingErr } = await admin
    .from('customers')
    .select('customer_id')
    .eq('user_id', user.id)
    .maybeSingle()

  if (existingErr) {
    return NextResponse.json({ error: 'db_error', details: existingErr.message }, { status: 500 })
  }

  let customerId = existing?.customer_id ?? null

  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email ?? undefined,
      metadata: { user_id: user.id },
    })

    customerId = customer.id

    const { error: upErr } = await admin
      .from('customers')
      .upsert({ user_id: user.id, customer_id: customerId }, { onConflict: 'user_id' })

    if (upErr) {
      return NextResponse.json({ error: 'db_error', details: upErr.message }, { status: 500 })
    }
  }

  // 2) créer Checkout Session subscription (server-side)
  // Route Handlers Next.js: app/api/**/route.ts :contentReference[oaicite:7]{index=7}
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${origin}/app?checkout=success`,
    cancel_url: `${origin}/app?checkout=cancel`,
    allow_promotion_codes: true,

    // mapping robuste user<->stripe pour webhook
    client_reference_id: user.id,
    metadata: { user_id: user.id },
    subscription_data: { metadata: { user_id: user.id } },
  })

  if (!session.url) {
    return NextResponse.json({ error: 'Missing session.url' }, { status: 500 })
  }

  // Redirect 303 vers Stripe Checkout
  return NextResponse.redirect(session.url, { status: 303 })
}
