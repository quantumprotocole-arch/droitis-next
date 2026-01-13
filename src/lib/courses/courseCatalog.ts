// src/lib/courses/courseCatalog.ts
import { COURSE_CATALOG_UNIVERSAL, MAPPING_OBSERVATIONS, QUESTIONS_FOR_ME } from "./courseCatalogData";

export type CourseCatalogEntry = {
  course_slug: string;
  display_name: string;
  alias_names: string[];
  one_liner: string;
  core_topics: string[];
  exam_focus: string[];
  institution_specific: boolean;
  institution_notes?: string;
};

export type CourseResolveResult =
  | { ok: true; course_slug: string; match: "slug" | "alias" | "fuzzy"; matched_on: string }
  | { ok: false; course_slug: null; match: null; matched_on: null; suggestions: CourseCatalogEntry[] };

export const COURSE_CATALOG: readonly CourseCatalogEntry[] = COURSE_CATALOG_UNIVERSAL as unknown as CourseCatalogEntry[];

export const COURSE_SLUGS = COURSE_CATALOG.map((c) => c.course_slug);

/**
 * Normalise une saisie libre (nom de cours tapé dans l’UI) pour matcher un alias:
 * - minuscules
 * - enlève accents
 * - enlève ponctuation
 * - compresse espaces
 */
export function normalizeCourseKey(input: string): string {
  return (input ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // accents
    .replace(/['’]/g, "") // apostrophes
    .replace(/[^a-z0-9]+/g, " ") // ponctuation -> espaces
    .trim()
    .replace(/\s+/g, " ");
}

// ------------------------------
// Indexes (slug + aliases)
// ------------------------------
const bySlug = new Map<string, CourseCatalogEntry>();
const aliasToSlug = new Map<string, string>();

for (const c of COURSE_CATALOG) {
  bySlug.set(c.course_slug, c);

  // ✅ slug direct
  aliasToSlug.set(normalizeCourseKey(c.course_slug), c.course_slug);

  // ✅ display_name comme alias
  aliasToSlug.set(normalizeCourseKey(c.display_name), c.course_slug);

  // ✅ alias_names
  for (const a of c.alias_names ?? []) {
    const k = normalizeCourseKey(a);
    if (!k) continue;
    // si collision: on garde le premier (stable)
    if (!aliasToSlug.has(k)) aliasToSlug.set(k, c.course_slug);
  }
}

export function getCourseBySlug(course_slug: string | null | undefined): CourseCatalogEntry | null {
  if (!course_slug) return null;
  return bySlug.get(course_slug) ?? null;
}

export function listCourses(): CourseCatalogEntry[] {
  return [...COURSE_CATALOG];
}

/**
 * Résout un input UI vers un course_slug:
 * - match exact slug
 * - match exact alias (normalisé)
 * - fuzzy “contains” (suggestions)
 */
export function resolveCourseSlug(input: string | null | undefined): CourseResolveResult {
  const raw = (input ?? "").trim();
  if (!raw) {
    return { ok: false, course_slug: null, match: null, matched_on: null, suggestions: [] };
  }

  // 1) slug exact
  if (bySlug.has(raw)) {
    return { ok: true, course_slug: raw, match: "slug", matched_on: raw };
  }

  const k = normalizeCourseKey(raw);

  // 2) alias exact (normalisé)
  const aliasHit = aliasToSlug.get(k);
  if (aliasHit) {
    return { ok: true, course_slug: aliasHit, match: "alias", matched_on: raw };
  }

  // 3) fuzzy (contains)
  // On renvoie des suggestions triées par "proximité"
  const scored: Array<{ c: CourseCatalogEntry; score: number }> = [];

  for (const c of COURSE_CATALOG) {
    const keys = [
      normalizeCourseKey(c.display_name),
      normalizeCourseKey(c.course_slug),
      ...(c.alias_names ?? []).map(normalizeCourseKey),
    ].filter(Boolean);

    let best = 0;
    for (const kk of keys) {
      if (kk === k) best = Math.max(best, 100);
      else if (kk.startsWith(k)) best = Math.max(best, 70);
      else if (kk.includes(k)) best = Math.max(best, 50);
      else {
        // mini-score token overlap
        const toks = new Set(k.split(" "));
        const kkToks = new Set(kk.split(" "));
        let overlap = 0;
        toks.forEach((t) => {
          if (t.length >= 3 && kkToks.has(t)) overlap++;
        });
        if (overlap >= 2) best = Math.max(best, 35);
        else if (overlap === 1) best = Math.max(best, 20);
      }
    }

    if (best > 0) scored.push({ c, score: best });
  }

  scored.sort((a, b) => b.score - a.score);

  if (scored.length) {
    const top = scored.slice(0, 8).map((x) => x.c);
    // si le meilleur score est vraiment bon, on “résout”
    if (scored[0].score >= 70) {
      return {
        ok: true,
        course_slug: scored[0].c.course_slug,
        match: "fuzzy",
        matched_on: raw,
      };
    }
    return {
      ok: false,
      course_slug: null,
      match: null,
      matched_on: null,
      suggestions: top,
    };
  }

  return { ok: false, course_slug: null, match: null, matched_on: null, suggestions: [] };
}

// ------------------------------
// Meta (optionnel, mais utile pour debug/admin UI)
// ------------------------------
export const COURSE_CATALOG_META = {
  mapping_observations: [...(MAPPING_OBSERVATIONS ?? [])],
  questions_for_me: [...(QUESTIONS_FOR_ME ?? [])],
} as const;
