// app/api/me/subscription/route.ts
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ACTIVE_STATUSES = new Set(['active', 'trialing']);

export async function GET() {
  const supabase = createClient();

  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();

  if (userErr || !user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // RLS: la policy doit autoriser SELECT sur sa propre row (user_id = auth.uid()).
  const { data, error } = await supabase
    .from('subscriptions')
    .select('status,current_period_end,price_id,plan_code')
    .eq('user_id', user.id)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: 'db_error' }, { status: 500 });
  }

  const status: string | null = data?.status ?? null;
  const active = status ? ACTIVE_STATUSES.has(status) : false;

  const current_period_end =
    data?.current_period_end ? new Date(data.current_period_end).toISOString() : null;

  // Compat: si price_id n’existe pas encore, on retombe sur plan_code (déjà dans ton schéma).
  const price_id: string | null = (data as any)?.price_id ?? data?.plan_code ?? null;

  return NextResponse.json({
    active,
    status,
    current_period_end,
    price_id,
  });
}
