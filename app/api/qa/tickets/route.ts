import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const supabase = createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const status = url.searchParams.get("status") ?? "open";

  const { data, error: qErr } = await supabase
    .from("qa_tickets")
    .select("*")
    .eq("status", status)
    .order("created_at", { ascending: false })
    .limit(50);

  if (qErr) return NextResponse.json({ error: qErr.message }, { status: 500 });
  return NextResponse.json({ tickets: data ?? [] });
}

export async function POST(req: Request) {
  const supabase = createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));

  const payload = {
    created_by: user.id,
    log_id: body.log_id ? String(body.log_id) : null,
    issue_type: String(body.issue_type || "other"),
    status: String(body.status || "open"),
    course_slug: body.course_slug ? String(body.course_slug) : null,
    expected_domain: body.expected_domain ? String(body.expected_domain) : null,
    expected_jurisdiction: body.expected_jurisdiction ? String(body.expected_jurisdiction) : null,
    notes: body.notes ? String(body.notes) : null,
    fix_commit: body.fix_commit ? String(body.fix_commit) : null,
    metadata: typeof body.metadata === "object" && body.metadata ? body.metadata : {},
  };

  const { data, error: insErr } = await supabase
    .from("qa_tickets")
    .insert(payload)
    .select("*")
    .single();

  if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });
  return NextResponse.json({ ticket: data });
}
