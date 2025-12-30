import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({
    vercel_env: process.env.VERCEL_ENV ?? null,
    vercel_git_branch: process.env.VERCEL_GIT_COMMIT_REF ?? null,
    has_STRIPE_SECRET_KEY: Boolean(process.env.STRIPE_SECRET_KEY),
    has_STRIPE_WEBHOOK_SECRET: Boolean(process.env.STRIPE_WEBHOOK_SECRET),
    has_STRIPE_PRICE_ID_PRO: Boolean(process.env.STRIPE_PRICE_ID_PRO),
  });
}
