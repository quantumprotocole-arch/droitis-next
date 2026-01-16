// src/lib/courses/courseCatalog.ts
import { COURSE_CATALOG_UNIVERSAL, MAPPING_OBSERVATIONS, QUESTIONS_FOR_ME, type CourseCatalogUniversalEntry } from "./courseCatalogData";

export type CourseCatalogEntry = {
  course_slug: string;
  display_name: string;
  alias_names: string[];
  one_liner: string;
  core_topics: string[];
  exam_focus: string[];
  accessibility: "all" | "institution_only";
  institution_note?: string;
};

export type CourseResolveResult =
  | { ok: true; course_slug: string; match: "slug" | "alias" | "fuzzy"; matched_on: string }
  | { ok: false; course_slug: null; match: null; matched_on: null; suggestions: string[] };

const COURSE_CATALOG: readonly CourseCatalogEntry[] = COURSE_CATALOG_UNIVERSAL as readonly CourseCatalogUniversalEntry[] as unknown as readonly CourseCatalogEntry[];

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

// ----------------------
// Indexes (slug + alias)
// ----------------------
const bySlug = new Map<string, CourseCatalogEntry>();
const aliasToSlug = new Map<string, string>();

for (const c of COURSE_CATALOG) {
  bySlug.set(c.course_slug, c);

  for (const a of c.alias_names ?? []) {
    const k = normalizeCourseKey(a);
    if (!k) continue;
    // si conflit: on garde le 1er (stable)
    if (!aliasToSlug.has(k)) aliasToSlug.set(k, c.course_slug);
  }
}

// ----------------------
// Public API
// ----------------------
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

  // 3) fuzzy: contient (slug ou display_name ou alias)
  const hay = k;
  const scored: { slug: string; score: number }[] = [];

  for (const c of COURSE_CATALOG) {
    const slugK = normalizeCourseKey(c.course_slug);
    const nameK = normalizeCourseKey(c.display_name);
    let score = 0;

    if (slugK.includes(hay)) score += 3;
    if (nameK.includes(hay)) score += 2;

    for (const a of c.alias_names ?? []) {
      const ak = normalizeCourseKey(a);
      if (ak.includes(hay)) score += 1;
    }

    if (score > 0) scored.push({ slug: c.course_slug, score });
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 5).map((x) => x.slug);

  if (top.length) {
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
