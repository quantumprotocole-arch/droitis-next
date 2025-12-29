// app/api/stripe/webhook/route.ts
import { NextResponse } from 'next/server'
import Stripe from 'stripe'
import { createClient as createSupabaseAdminClient } from '@supabase/supabase-js'
import { getStripe } from '@/lib/stripe'

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

function unixToIso(unixSeconds: number | null | undefined) {
  if (!unixSeconds) return null
  return new Date(unixSeconds * 1000).toISOString()
}

/**
 * Stripe (2025) : billing period au niveau subscription item :
 * items.data.current_period_end. :contentReference[oaicite:4]{index=4}
 * On prend le MIN pour rester cohérent avec “min item period end”.
 */
function getMinItemPeriodEnd(sub: Stripe.Subscription): number | null {
  const ends = (sub.items?.data ?? [])
    .map((it) => (typeof it.current_period_end === 'number' ? it.current_period_end : null))
    .filter((x): x is number => typeof x === 'number')

  if (ends.length === 0) return null
  return Math.min(...ends)
}

async function resolveUserIdFromCustomerId(
  admin: ReturnType<typeof getSupabaseAdmin>,
  customerId: string
) {
  const { data, error } = await admin
    .from('customers')
    .select('user_id')
    .eq('customer_id', customerId)
    .maybeSingle()

  if (error) throw error
  return (data?.user_id as string | null) ?? null
}

async function upsertCustomerMapping(
  admin: ReturnType<typeof getSupabaseAdmin>,
  userId: string,
  customerId: string
) {
  const { error } = await admin
    .from('customers')
    .upsert({ user_id: userId, customer_id: customerId }, { onConflict: 'user_id' })

  if (error) throw error
}

async function upsertSubscription(
  admin: ReturnType<typeof getSupabaseAdmin>,
  payload: {
    userId: string
    customerId: string | null
    stripeSubscriptionId: string | null
    status: string
    currentPeriodEndIso: string | null
    priceId: string | null
    cancelAtPeriodEnd: boolean | null
  }
) {
  const planCode = payload.priceId ?? 'unknown'

  const { error } = await admin
    .from('subscriptions')
    .upsert(
      {
        user_id: payload.userId,
        customer_id: payload.customerId,
        stripe_subscription_id: payload.stripeSubscriptionId,
        status: payload.status,
        current_period_end: payload.currentPeriodEndIso,
        price_id: payload.priceId,
        cancel_at_period_end: payload.cancelAtPeriodEnd ?? false,
        // compat schéma existant
        plan_code: planCode,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' }
    )

  if (error) throw error
}

export async function POST(req: Request) {
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET
  if (!endpointSecret) {
    return NextResponse.json({ error: 'Missing STRIPE_WEBHOOK_SECRET' }, { status: 500 })
  }

  const sig = req.headers.get('stripe-signature')
  if (!sig) {
    return NextResponse.json({ error: 'Missing Stripe-Signature header' }, { status: 400 })
  }

  // Stripe exige le RAW BODY pour la signature. :contentReference[oaicite:5]{index=5}
  const body = await req.text()

  let stripe: Stripe
  try {
    stripe = getStripe()
  } catch (e: any) {
    // Important: ne pas faire planter le build, et renvoyer un 500 propre au runtime.
    return NextResponse.json({ error: e?.message ?? 'Missing STRIPE_SECRET_KEY' }, { status: 500 })
  }

  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(body, sig, endpointSecret)
  } catch (err: any) {
    return NextResponse.json(
      { error: `Webhook signature verification failed: ${err?.message ?? 'unknown'}` },
      { status: 400 }
    )
  }

  const admin = getSupabaseAdmin()

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session

        const customerId = typeof session.customer === 'string' ? session.customer : null
        const stripeSubscriptionId = typeof session.subscription === 'string' ? session.subscription : null

        // mapping user_id: metadata.user_id puis client_reference_id
        const userId =
          session.metadata?.user_id ??
          (typeof session.client_reference_id === 'string' ? session.client_reference_id : null)

        if (!userId) throw new Error('Missing user_id in Checkout Session metadata/client_reference_id')

        if (customerId) {
          await upsertCustomerMapping(admin, userId, customerId)
        }

        // Hydrater la subscription (items + price + item period end)
        if (stripeSubscriptionId) {
          const hydrated = await stripe.subscriptions.retrieve(stripeSubscriptionId, {
            expand: ['items.data.price'],
          })

          const priceObj = hydrated.items?.data?.[0]?.price
          const priceId = priceObj && typeof priceObj !== 'string' ? priceObj.id : null

          const minEndUnix = getMinItemPeriodEnd(hydrated)
          const currentPeriodEndIso = unixToIso(minEndUnix)

          await upsertSubscription(admin, {
            userId,
            customerId: typeof hydrated.customer === 'string' ? hydrated.customer : customerId,
            stripeSubscriptionId: hydrated.id,
            status: hydrated.status,
            currentPeriodEndIso,
            priceId,
            cancelAtPeriodEnd: hydrated.cancel_at_period_end,
          })
        }

        break
      }

      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const subEvent = event.data.object as Stripe.Subscription

        const customerId = typeof subEvent.customer === 'string' ? subEvent.customer : null
        if (!customerId) throw new Error('Missing customer id on subscription event')

        // user_id: metadata puis fallback DB customers
        const userId = subEvent.metadata?.user_id ?? (await resolveUserIdFromCustomerId(admin, customerId))
        if (!userId) throw new Error('Unable to resolve user_id for customer')

        // Toujours hydrater: on veut items.data[].current_period_end + price
        const hydrated = await stripe.subscriptions.retrieve(subEvent.id, {
          expand: ['items.data.price'],
        })

        const priceObj = hydrated.items?.data?.[0]?.price
        const priceId = priceObj && typeof priceObj !== 'string' ? priceObj.id : null

        const minEndUnix = getMinItemPeriodEnd(hydrated)
        const currentPeriodEndIso = unixToIso(minEndUnix)

        await upsertSubscription(admin, {
          userId,
          customerId,
          stripeSubscriptionId: hydrated.id,
          status: hydrated.status,
          currentPeriodEndIso,
          priceId,
          cancelAtPeriodEnd: hydrated.cancel_at_period_end,
        })

        break
      }

      default:
        break
    }

    return NextResponse.json({ received: true })
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? 'webhook_handler_error' }, { status: 500 })
  }
}
