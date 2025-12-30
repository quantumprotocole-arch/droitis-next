import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function stripeMode() {
  const k = process.env.STRIPE_SECRET_KEY ?? '';
  if (k.startsWith('sk_test')) return 'test';
  if (k.startsWith('sk_live')) return 'live';
  return k ? 'unknown' : 'missing';
}

export async function GET() {
  return NextResponse.json({
    vercel_env: process.env.VERCEL_ENV ?? null,
    vercel_git_branch: process.env.VERCEL_GIT_COMMIT_REF ?? null,

    stripe_mode: stripeMode(),
    has_STRIPE_SECRET_KEY: Boolean(process.env.STRIPE_SECRET_KEY),
    has_STRIPE_WEBHOOK_SECRET: Boolean(process.env.STRIPE_WEBHOOK_SECRET),
    has_STRIPE_PRICE_ID_PRO: Boolean(process.env.STRIPE_PRICE_ID_PRO),

    // IMPORTANT pour checkout: le serveur utilise la service role pour upsert customers
    has_SUPABASE_SERVICE_ROLE_KEY: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    has_SUPABASE_URL: Boolean(process.env.SUPABASE_URL),
    has_NEXT_PUBLIC_SUPABASE_URL: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL),
  });
}
