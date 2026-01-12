// app/api/courses/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type CourseRow = {
  course_slug: string;
  course_title: string;
  scope: "all" | "institution_specific";
  institution_note: string | null;
  tags: string[] | null;
  created_at: string;
};

type AliasRow = {
  course_slug: string;
  alias: string;
};

export async function GET() {
  const supabase = createClient();

  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();

  if (userErr || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: courses, error: cErr } = await supabase
    .from("course_catalog")
    .select("course_slug, course_title, scope, institution_note, tags, created_at")
    .order("course_title", { ascending: true });

  if (cErr) {
    return NextResponse.json({ error: "Failed to fetch courses", details: cErr.message }, { status: 500 });
  }

  const { data: aliases, error: aErr } = await supabase.from("course_aliases").select("course_slug, alias");

  if (aErr) {
    return NextResponse.json({ error: "Failed to fetch course aliases", details: aErr.message }, { status: 500 });
  }

  const aliasMap = new Map<string, string[]>();
  for (const a of (aliases ?? []) as AliasRow[]) {
    const arr = aliasMap.get(a.course_slug) ?? [];
    arr.push(a.alias);
    aliasMap.set(a.course_slug, arr);
  }

  const payload = ((courses ?? []) as CourseRow[]).map((c) => ({
    ...c,
    tags: c.tags ?? [],
    aliases: aliasMap.get(c.course_slug) ?? [],
  }));

  return NextResponse.json({ courses: payload });
}
