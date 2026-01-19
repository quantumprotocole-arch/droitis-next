// lib/courseProfiles.ts
import fs from "node:fs";
import path from "node:path";

type SynRow = { term: string; variants: string[] };
type TriggerRule = { if_any: string[]; then?: { boost_tags?: string[]; focus_section?: string } };

export type CourseProfile = {
  course_slug: string;
  course_title?: string;
  B?: { juridiction_principale?: "QC" | "CA-FED" | "OTHER" | "UNKNOWN" };
  D?: { plan_canon?: Array<{ title: string }> };
  J?: { synonymes?: SynRow[]; trigger_rules?: TriggerRule[] };
};

let _cache: Map<string, CourseProfile> | null = null;

export function getCourseProfile(course_slug: string | null | undefined): CourseProfile | null {
  const slug = String(course_slug ?? "").trim();
  if (!slug) return null;

  if (!_cache) {
    const p = path.join(process.cwd(), "course_profiles", "droitis_course_ingestion_pack_mvp.cleaned.json");
    if (!fs.existsSync(p)) {
      _cache = new Map();
      return null;
    }
    const raw = fs.readFileSync(p, "utf-8");
    const arr = JSON.parse(raw) as CourseProfile[];
    _cache = new Map(arr.map((c) => [String(c.course_slug).trim(), c]));
  }
  return _cache.get(slug) ?? null;
}

function includesAny(hay: string, needles: string[]) {
  const s = hay.toLowerCase();
  return needles.some((n) => n && s.includes(n.toLowerCase()));
}

export function expandQueryWithProfile(message: string, profile: CourseProfile | null) {
  if (!profile) return { expanded: message, matchedTags: [], focusSections: [] };

  const matchedTags: string[] = [];
  const focusSections: string[] = [];
  const parts: string[] = [];

  // Synonymes: si on détecte un terme/variant, on ajoute le terme canonique pour booster recall.
  const syns = profile.J?.synonymes ?? [];
  let synHits = 0;
  for (const s of syns) {
    if (synHits >= 6) break; // anti-bloat
    const term = (s.term ?? "").trim();
    const vars = Array.isArray(s.variants) ? s.variants : [];
    if (!term) continue;
    if (includesAny(message, [term, ...vars])) {
      parts.push(term);
      synHits++;
    }
  }

  // Trigger rules: ajoute tags/section comme keywords (sans “forcer” une réponse préfabriquée)
  const rules = profile.J?.trigger_rules ?? [];
  let trigHits = 0;
  for (const r of rules) {
    if (trigHits >= 4) break;
    const ifAny = (r.if_any ?? []).filter(Boolean);
    if (!ifAny.length) continue;
    if (includesAny(message, ifAny)) {
      const bt = r.then?.boost_tags ?? [];
      for (const t of bt) matchedTags.push(t);
      const fs = r.then?.focus_section;
      if (fs) focusSections.push(fs);
      trigHits++;
    }
  }

  const extra = [
    parts.length ? `Synonymes utiles: ${Array.from(new Set(parts)).join(", ")}` : null,
    matchedTags.length ? `Tags: ${Array.from(new Set(matchedTags)).join(", ")}` : null,
    focusSections.length ? `Section cible: ${Array.from(new Set(focusSections)).join(" | ")}` : null,
  ].filter(Boolean);

  const expanded = extra.length ? `${message}\n\n${extra.join("\n")}` : message;
  return { expanded, matchedTags: Array.from(new Set(matchedTags)), focusSections: Array.from(new Set(focusSections)) };
}

export function courseContext(profile: CourseProfile | null) {
  if (!profile) return "";
  const jur = profile.B?.juridiction_principale ?? "UNKNOWN";
  const plan = (profile.D?.plan_canon ?? []).map((s) => s.title).filter(Boolean).slice(0, 8);
  return [
    `COURSE_PROFILE: ${profile.course_slug}${profile.course_title ? ` — ${profile.course_title}` : ""}`,
    `Juridiction (profil): ${jur}`,
    plan.length ? `Plan canon (aperçu): ${plan.join(" | ")}` : null,
  ].filter(Boolean).join("\n");
}
