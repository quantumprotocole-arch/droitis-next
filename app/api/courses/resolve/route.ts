// app/api/courses/resolve/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ResolveRequest = { q?: string };

type CourseRow = {
  course_slug: string;
  course_title: string;
  scope: "all" | "institution_specific";
  institution_note: string | null;
  tags: string[] | null;
};

type AliasRow = {
  course_slug: string;
  alias: string;
};

export async function POST(req: Request) {
  const supabase = createClient();

  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();

  if (userErr || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as ResolveRequest;
  const q = typeof body.q === "string" ? body.q.trim() : "";

  if (!q) {
    return NextResponse.json({ error: "Missing q" }, { status: 400 });
  }
  if (q.length > 200) {
    return NextResponse.json({ error: "q too long" }, { status: 400 });
  }

  // 1) Match exact course_slug (on force lowercase, car les slugs sont généralement lowercase)
  const qSlug = q.toLowerCase();
  const { data: slugHit, error: slugErr } = await supabase
    .from("course_catalog")
    .select("course_slug, course_title, scope, institution_note, tags")
    .eq("course_slug", qSlug)
    .maybeSingle();

  if (slugErr) {
    return NextResponse.json({ error: "Resolve failed", details: slugErr.message }, { status: 500 });
  }

  if (slugHit) {
    return NextResponse.json({
      resolved: true,
      matched_by: "slug",
      course: slugHit as CourseRow,
    });
  }

  // 2) Match exact alias (case-insensitive)
  const { data: aliasExact, error: aExactErr } = await supabase
    .from("course_aliases")
    .select("course_slug, alias")
    .ilike("alias", q)
    .limit(25);

  if (aExactErr) {
    return NextResponse.json({ error: "Resolve failed", details: aExactErr.message }, { status: 500 });
  }

  const exactSlugs = Array.from(new Set((aliasExact ?? []).map((r: any) => r.course_slug)));
  if (exactSlugs.length === 1) {
    const { data: course, error: cErr } = await supabase
      .from("course_catalog")
      .select("course_slug, course_title, scope, institution_note, tags")
      .eq("course_slug", exactSlugs[0])
      .maybeSingle();

    if (cErr) {
      return NextResponse.json({ error: "Resolve failed", details: cErr.message }, { status: 500 });
    }

    if (course) {
      return NextResponse.json({
        resolved: true,
        matched_by: "alias_exact",
        course: course as CourseRow,
      });
    }
  }

  // 3) Match partiel alias (fallback)
  // (on évite les wildcards si l’utilisateur a mis % ou _)
  let aliasPartial: AliasRow[] = [];
  if (!q.includes("%") && !q.includes("_")) {
    const pattern = `%${q}%`;
    const { data: aPart, error: aPartErr } = await supabase
      .from("course_aliases")
      .select("course_slug, alias")
      .ilike("alias", pattern)
      .limit(25);

    if (aPartErr) {
      return NextResponse.json({ error: "Resolve failed", details: aPartErr.message }, { status: 500 });
    }
    aliasPartial = (aPart ?? []) as any;
  }

  const candidateSlugs = Array.from(new Set(aliasPartial.map((r) => r.course_slug)));

  if (candidateSlugs.length === 1) {
    const { data: course, error: cErr } = await supabase
      .from("course_catalog")
      .select("course_slug, course_title, scope, institution_note, tags")
      .eq("course_slug", candidateSlugs[0])
      .maybeSingle();

    if (cErr) {
      return NextResponse.json({ error: "Resolve failed", details: cErr.message }, { status: 500 });
    }

    if (course) {
      return NextResponse.json({
        resolved: true,
        matched_by: "alias_partial",
        course: course as CourseRow,
      });
    }
  }

  // Suggestions (0..10)
  const suggestionSlugs = candidateSlugs.slice(0, 10);
  let suggestions: CourseRow[] = [];

  if (suggestionSlugs.length > 0) {
    const { data: courseList, error: listErr } = await supabase
      .from("course_catalog")
      .select("course_slug, course_title, scope, institution_note, tags")
      .in("course_slug", suggestionSlugs);

    if (listErr) {
      return NextResponse.json({ error: "Resolve failed", details: listErr.message }, { status: 500 });
    }

    suggestions = (courseList ?? []) as any;
  }

  return NextResponse.json({
    resolved: false,
    matched_by: null,
    suggestions,
  });
}
