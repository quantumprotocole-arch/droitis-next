/* eslint-disable no-console */
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { createClient as createUserClient } from "@/lib/supabase/server";
import { senseRouter } from "@/lib/senseRouter";
import { getCourseProfile, expandQueryWithProfile, courseContext } from "@/lib/courseProfiles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ------------------------------
// Types
// ------------------------------
type Jurisdiction = "QC" | "CA-FED" | "OTHER" | "UNKNOWN";
type Domain = "Civil" | "Travail" | "Sante" | "Penal" | "Fiscal" | "Admin" | "Autre" | "Inconnu";

type EnrichedRow = {
  id: number;
  code_id: string | null;
  citation: string | null;
  title: string | null;
  text: string | null;
  jurisdiction_norm: string | null;
  code_id_struct: string | null;
  article_num: string | null;
  url_struct: string | null;
};

type HybridHit = EnrichedRow & {
  similarity?: number | null; // 0..1
  distance?: number | null;
  fts_rank?: number | null;
  score?: number | null;
  rrf_score?: number | null; // returned by RPC v2
  from_fts?: boolean | null; // returned by RPC v2
  bucket?: string | null;
};

type Source = {
  id: string | number;
  citation: string | null;
  title?: string | null;
  jur?: string | null;
  url?: string | null;
  snippet?: string | null;
};

type ChatRequest = {
  message?: string;
  profile?: string | null;
  top_k?: number | null;
  mode?: string | null;

  // Phase 4D (input contract)
  course_slug?: string | null;
  user_goal?: string | null;
  institution_name?: string | null;

  question?: string;
  messages?: Array<{ role: "user" | "assistant" | "system"; content: string }>;
};

type KernelHit = {
  id: string;
  course_slug: string;
  topic: string;
  content: string;
  similarity: number;
};

type DistinctionRow = {
  id: string;
  course_slug: string;
  concept_a: string;
  concept_b: string;
  rule_of_thumb: string;
  pitfalls: string[] | null;
  when_it_matters: string[] | null;
  priority: number;
};

// ------------------------------
// Env
// ------------------------------
const { OPENAI_API_KEY } = process.env;

// ------------------------------
// Helpers
// ------------------------------
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "Content-Type, Authorization",
};

function json(data: any, init?: number | ResponseInit) {
  return new Response(JSON.stringify(data, null, 2), {
    status: typeof init === "number" ? init : init?.status ?? 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
      ...(typeof init !== "number" ? init?.headers : undefined),
    },
  });
}


function stripSourcesSectionForUser(text: string): string {
  // Supprime sections "Sources" / "Sources citées" jusqu'à la fin (côté client en prod)
  return (text ?? "").replace(/\n\*\*Sources[\s\S]*$/i, "").trim();
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

async function safeJson(res: Response) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function normalizeJurisdiction(j: string | null | undefined): Jurisdiction | "OTHER" {
  const s = (j ?? "").toUpperCase();
  if (s === "QC") return "QC";
  if (s === "CA-FED" || s === "CA" || s.includes("CANADA")) return "CA-FED";
  if (s.includes("QUEBEC") || s.includes("QUÉBEC")) return "QC";
  return "OTHER";
}

function isStatementTimeout(errMsg: string) {
  return (
    errMsg.includes("57014") ||
    errMsg.toLowerCase().includes("statement timeout") ||
    errMsg.toLowerCase().includes("canceling statement")
  );
}

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function containsAny(hay: string, needles: string[]) {
  const s = hay.toLowerCase();
  for (let i = 0; i < needles.length; i++) {
    if (s.includes(needles[i])) return true;
  }
  return false;
}

function makeExcerpt(text: string, maxLen = 900): string {
  const t = (text || "").replace(/\s+/g, " ").trim();
  if (t.length <= maxLen) return t;
  return t.slice(0, maxLen) + "…";
}

function goalMode(user_goal: string | null): "exam" | "case" | "learn" {
  const g = (user_goal ?? "").toLowerCase();
  if (g.includes("examen") || g.includes("exam")) return "exam";
  if (g.includes("cas") || g.includes("pratique") || g.includes("case")) return "case";
  return "learn";
}

type InferredIntent = { goal_mode: "exam" | "case" | "learn"; wants_exam_tip: boolean };

function inferIntent(args: { message: string; user_goal: string | null }): InferredIntent {
  const fromGoal = args.user_goal ? goalMode(args.user_goal) : null;
  const t = (args.message ?? "").toLowerCase();
  const has = (...keys: string[]) => keys.some((k) => t.includes(k));

  const inferred: "exam" | "case" | "learn" = fromGoal
    ? fromGoal
    : has("cas pratique", "mise en situation", "hypothèse", "scenario", "scénario", "application", "ilac", "irac") ||
      (/\bcas\b/.test(t) && !has("dans le cas où je", "au cas où"))
    ? "case"
    : has("examen", "final", "intra", "midterm", "quiz", "qcm", "mcq", "fiche", "résumé", "resume", "plan", "mémo", "memo", "révision", "revision")
    ? "exam"
    : "learn";

  const wants_exam_tip =
    inferred === "exam" ||
    inferred === "case" ||
    has(
      "examen",
      "final",
      "intra",
      "midterm",
      "quiz",
      "qcm",
      "mcq",
      "fiche",
      "résumé",
      "resume",
      "plan",
      "mémo",
      "memo",
      "révision",
      "revision",
      "cas pratique",
      "mise en situation",
      "ilac",
      "irac"
    );

  return { goal_mode: inferred, wants_exam_tip };
}

function hasQcLegalSignals(q: string): boolean {
  const s = q.toLowerCase();
  const qcStrong = [
    "c.c.q",
    "ccq",
    "code civil du québec",
    "code de procédure civile",
    "code de procedure civile",
    "cpc",
    "c.n.e.s.s.t",
    "cnesst",
    "tribunal administratif du travail",
    "tat",
    "legisquebec",
    "légisquébec",
    "charte québécoise",
    "charte des droits et libertés de la personne",
    "loi du québec",
    "rlrq",
  ];
  for (let i = 0; i < qcStrong.length; i++) if (s.includes(qcStrong[i])) return true;
  return false;
}

function hasFedLegalSignals(q: string): boolean {
  const s = q.toLowerCase();
  const fedStrong = [
    "code canadien du travail",
    "canada labour code",
    "loi fédérale",
    "loi federale",
    "parlement du canada",
    "charte canadienne",
    "charte canadienne des droits et libertés",
    "criminal code",
    "code criminel",
    "l.c. 1985",
  ];
  for (let i = 0; i < fedStrong.length; i++) if (s.includes(fedStrong[i])) return true;
  return false;
}

function hasPenalSignals(q: string): boolean {
  const s = q.toLowerCase();
  const penal = [
    "police",
    "alcootest",
    "souffler",
    "dépistage",
    "depistage",
    "fouille",
    "perquisition",
    "mandat",
    "saisie",
    "preuve illégale",
    "preuve illegale",
    "exclusion",
    "admissibilité",
    "admissibilite",
    "déclaration",
    "declaration",
    "aveu",
    "arrestation",
    "détention",
    "detention",
    "accusation",
    "couronne",
    "procureur",
    "charte canadienne",
    "code criminel",
    "criminal code",
  ];
  for (let i = 0; i < penal.length; i++) if (s.includes(penal[i])) return true;
  return false;
}

function hasHealthSignals(q: string): boolean {
  const s = q.toLowerCase();
  const health = [
    "hôpital",
    "hopital",
    "urgence",
    "intuber",
    "réanimation",
    "reanimation",
    "refus de soins",
    "soins",
    "consentement",
    "inapte",
    "aptitude",
    "capacité",
    "capacite",
    "tuteur",
    "curateur",
    "mandat de protection",
    "directives",
    "dossier médical",
    "dossier medical",
    "cisss",
    "ciusss",
    "clinique",
  ];
  for (let i = 0; i < health.length; i++) if (s.includes(health[i])) return true;
  return false;
}

function hasWorkSignals(q: string): boolean {
  const s = q.toLowerCase();
  const workStrong = [
    "congédi",
    "congedi",
    "licenci",
    "mise à pied",
    "mise a pied",
    "renvoi",
    "cessation d'emploi",
    "cessation d’emploi",
    "fin d'emploi",
    "fin d’emploi",
    "harcèlement",
    "harcelement",
    "disciplin",
    "suspension",
    "grief",
    "syndic",
    "convention collective",
    "préavis",
    "preavis",
    "indemnité",
    "indemnite",
    "normes du travail",
    "employeur",
    "employé",
    "employe",
    "contrat de travail",
  ];
  return containsAny(s, workStrong);
}

const UNION_KEYWORDS = ["syndiqué", "syndique", "syndicat", "grief", "convention collective", "accréditation", "accreditation"];

function hasUnionSignals(q: string): boolean {
  const s = q.toLowerCase();
  const negUnionPatterns = [
    /\bpas\s+de\s+syndicat\b/,
    /\baucun\s+syndicat\b/,
    /\bsans\s+syndicat\b/,
    /\bnon\s+syndiqu[ée]\b/,
    /\bpas\s+syndiqu[ée]\b/,
  ];
  if (negUnionPatterns.some((re) => re.test(s))) return false;
  return containsAny(s, UNION_KEYWORDS);
}

const FED_WORK_SECTOR_KEYWORDS = [
  "banque",
  "banques",
  "authorized foreign bank",
  "banque étrangère",
  "banque etrangere",
  "télécom",
  "telecom",
  "télécommunications",
  "telecommunications",
  "radiodiffusion",
  "broadcasting",
  "radio",
  "télévision",
  "television",
  "câble",
  "cable",
  "aviation",
  "aéroport",
  "aeroport",
  "airline",
  "compagnie aérienne",
  "compagnie aerienne",
  "rail",
  "chemin de fer",
  "ferroviaire",
  "railway",
  "maritime",
  "navire",
  "shipping",
  "port",
  "ports",
  "pipeline",
  "oléoduc",
  "oleoduc",
  "gazoduc",
  "transport interprovincial",
  "interprovincial",
  "international",
  "camionnage",
  "trucking",
  "autobus",
  "bus",
  "poste canada",
  "canada post",
  "postal",
  "courrier",
  "messagerie",
  "courier",
  "uranium",
  "nucléaire",
  "nucleaire",
  "atomic",
  "nuclear",
];

const FED_PUBLIC_EMPLOYER_KEYWORDS = [
  "gouvernement du canada",
  "fonction publique fédérale",
  "fonction publique federale",
  "parlement",
  "house of commons",
  "senate",
  "forces armées",
  "forces armees",
  "armée canadienne",
  "military",
  "gendarmerie royale",
  "grc",
  "rcmp",
  "société d'état",
  "societe d'etat",
  "crown corporation",
];

const FED_ADMIN_AGENCY_KEYWORDS = [
  "ircc",
  "immigration, réfugiés",
  "immigration refugies",
  "asfc",
  "cbsa",
  "douanes",
  "customs",
  "arc",
  "cra",
  "agence du revenu du canada",
  "canada revenue agency",
  "crtc",
  "transport canada",
  "sécurité publique canada",
  "securite publique canada",
  "public safety canada",
  "office national de l'énergie",
  "cer",
  "régie canadienne de l'énergie",
  "regie canadienne de l'energie",
  "canada energy regulator",
  "tribunal fédéral",
  "tribunal federal",
  "cour fédérale",
  "cour federale",
];

const QC_PROV_PENAL_KEYWORDS = [
  "constat d'infraction",
  "ticket",
  "amende",
  "code de la sécurité routière",
  "code de la securite routiere",
  "csr",
  "saaq",
  "règlement municipal",
  "reglement municipal",
  "stationnement",
];

function hasFedWorkSectorSignals(q: string): { matched: boolean; keyword?: string } {
  const s = q.toLowerCase();
  for (const k of FED_WORK_SECTOR_KEYWORDS) {
    if (s.includes(k)) return { matched: true, keyword: k };
  }
  return { matched: false };
}
function hasFedPublicEmployerSignals(q: string): boolean {
  const s = q.toLowerCase();
  return containsAny(s, FED_PUBLIC_EMPLOYER_KEYWORDS);
}
function hasFedAdminAgencySignals(q: string): boolean {
  const s = q.toLowerCase();
  return containsAny(s, FED_ADMIN_AGENCY_KEYWORDS);
}
function hasQcProvPenalSignals(q: string): boolean {
  const s = q.toLowerCase();
  return containsAny(s, QC_PROV_PENAL_KEYWORDS);
}

function defaultJurisdictionByDomain(domain: Domain): Jurisdiction {
  if (domain === "Penal") return "CA-FED";
  if (domain === "Fiscal") return "UNKNOWN";
  return "QC";
}

type Gate = {
  selected: Jurisdiction;
  reason: string;
  lock: boolean;
  pitfall_keyword?: string | null;
  assumptions: {
    union_assumed: boolean;
    penal_provincial_assumed: boolean;
  };
};

function detectJurisdictionExpected(
  message: string,
  domain: Domain
): { selected: Jurisdiction; reason: string; lock: boolean; pitfall_keyword?: string | null } {
  if (hasQcLegalSignals(message)) return { selected: "QC", reason: "explicit_qc_signal", lock: true };
  if (hasFedLegalSignals(message)) return { selected: "CA-FED", reason: "explicit_fed_signal", lock: true };

  const s = message.toLowerCase();
  const otherSignals = ["ontario", "alberta", "colombie-britannique", "british columbia", "france", "europe", "usa", "états-unis", "etats-unis"];
  if (containsAny(s, otherSignals)) return { selected: "OTHER", reason: "explicit_other_geo", lock: true };

  if (domain === "Penal") {
    if (hasQcProvPenalSignals(message)) return { selected: "QC", reason: "penal_provincial_qc", lock: true };
    // ne verrouille CA-FED que si signal pénal FORT
    const penalFedStrong = /\b(code criminel|criminal code|procureur|dpcp|mise en accusation|acte criminel|sommaire)\b/i.test(message);
    if (penalFedStrong) return { selected: "CA-FED", reason: "penal_substantive_fed_strong", lock: true };

    return { selected: defaultJurisdictionByDomain(domain), reason: "penal_default_majority", lock: false };
  }

  if (domain === "Travail") {
    const fedSector = hasFedWorkSectorSignals(message);
    if (fedSector.matched) return { selected: "CA-FED", reason: "work_federal_sector_exception", lock: true, pitfall_keyword: fedSector.keyword ?? null };
    if (hasFedPublicEmployerSignals(message)) return { selected: "CA-FED", reason: "work_federal_public_employer", lock: true };
    return { selected: "QC", reason: "work_default_qc_majority", lock: false };
  }

  if (domain === "Admin") {
    if (hasFedAdminAgencySignals(message)) return { selected: "CA-FED", reason: "admin_federal_agency_exception", lock: true };
    return { selected: "QC", reason: "admin_default_qc_majority", lock: false };
  }

  if (domain === "Fiscal") {
    const hasQc = containsAny(s, ["revenu québec", "revenu quebec", "tvq", "t-0.1"]);
    const hasFed = containsAny(s, ["arc", "cra", "agence du revenu du canada", "tps", "gst", "hst"]);
    if (hasQc && hasFed) return { selected: "UNKNOWN", reason: "fiscal_mixed_signals", lock: false };
    if (hasQc) return { selected: "QC", reason: "fiscal_qc_signal", lock: true };
    if (hasFed) return { selected: "CA-FED", reason: "fiscal_fed_signal", lock: true };
    return { selected: "UNKNOWN", reason: "fiscal_mixed_default", lock: false };
  }

  if (domain === "Sante") return { selected: "QC", reason: "health_default_qc_majority", lock: false };
  if (domain === "Civil") return { selected: "QC", reason: "civil_default_qc_majority", lock: false };

  return { selected: defaultJurisdictionByDomain(domain), reason: "domain_default_majority", lock: false };
}

function jurisdictionGateNoBlock(message: string, domain: Domain): Gate {
  const base = detectJurisdictionExpected(message, domain);
  return {
    selected: base.selected,
    reason: base.reason,
    lock: base.lock,
    pitfall_keyword: base.pitfall_keyword ?? null,
    assumptions: {
      union_assumed: hasUnionSignals(message),
      penal_provincial_assumed: domain === "Penal" ? hasQcProvPenalSignals(message) : false,
    },
  };
}

// ------------------------------
// Domain detection (heuristique)
// ------------------------------
function detectDomain(message: string): Domain {
  const s = message.toLowerCase();

    // Penal seulement sur signaux forts (évite faux positifs)
  const penalStrong = /\b(code criminel|criminal code|dpcp|accusation|infraction|mandat|perquisition|arrestation|mise en accusation|mens rea|actus reus)\b/i.test(message);
  if (penalStrong || hasQcProvPenalSignals(message)) return "Penal";

  if (hasHealthSignals(message)) return "Sante";

  const fiscal = [
    "revenu québec",
    "revenu quebec",
    "agence du revenu",
    "cotisation",
    "objection",
    "appel fiscal",
    "tps",
    "tvq",
    "gst",
    "hst",
    "impôt",
    "impot",
    "taxe",
    "déduction",
    "deduction",
    "déclar",
    "declar",
    "revenu",
    "revenus",
    "factur",
    "facturation",
  ];

  if (
    s.includes("travailleur autonome") ||
    (s.includes("autonome") && containsAny(s, ["revenu", "revenus", "déclar", "declar", "taxe", "tps", "tvq", "impôt", "impot", "factur"]))
  ) {
    return "Fiscal";
  }
  if (containsAny(s, fiscal)) return "Fiscal";

  if (hasWorkSignals(message)) return "Travail";

  const admin = ["taq", "cai", "commission d'accès", "commission d’acces", "contrôle judiciaire", "controle judiciaire", "tribunal administratif", "permis", "zonage"];
  if (containsAny(s, admin)) return "Admin";

  const civil = ["responsabilité", "responsabilite", "faute", "préjudice", "prejudice", "dommage", "contrat", "obligation", "bail", "vice caché", "vice cache", "prescription"];
  if (containsAny(s, civil)) return "Civil";

  return "Inconnu";
}

function domainByCourseSlug(course_slug: string | null): Domain | null {
  const s = (course_slug ?? "").toLowerCase().trim();
  if (!s) return null;

  const p: any = getCourseProfile(s);
  const domains: string[] = Array.isArray(p?.B?.domaines) ? p.B.domaines : [];
  const tags = domains.map((x) => String(x).toLowerCase());

  const has = (...keys: string[]) => keys.some((k) => tags.some((t) => t.includes(k)));

  if (has("pénal", "penal", "criminel", "crime", "procédure pénale")) return "Penal";
  if (has("travail", "emploi", "syndicat", "relations de travail")) return "Travail";
  if (has("fiscal", "tax", "impôt", "impot")) return "Fiscal";
  if (has("administratif", "contentieux administratif", "taq", "cai")) return "Admin";
  if (has("santé", "sante", "médical", "medical", "bioéthique")) return "Sante";

  if (has("obligation", "contrat", "responsabilité", "responsabilite", "biens", "prescription", "assurance", "consommation")) {
    return "Civil";
  }

  return null;
}

// ------------------------------
// Keyword extraction + expansion
// ------------------------------
const STOPWORDS_FR = new Set([
  "alors",
  "aucun",
  "avec",
  "dans",
  "donc",
  "elle",
  "elles",
  "entre",
  "être",
  "mais",
  "même",
  "pour",
  "sans",
  "sont",
  "tout",
  "toute",
  "tous",
  "le",
  "la",
  "les",
  "un",
  "une",
  "des",
  "de",
  "du",
  "au",
  "aux",
  "et",
  "ou",
  "sur",
  "par",
  "que",
  "qui",
  "quoi",
  "dont",
  "est",
  "etre",
  "a",
  "à",
  "en",
  "se",
  "sa",
  "son",
  "ses",
  "ce",
  "cet",
  "cette",
  "ces",
]);

function extractKeywords(q: string, max = 10): string[] {
  const cleaned = q
    .toLowerCase()
    .replace(/[^a-z0-9à-öø-ÿ\s.-]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  const parts = cleaned.split(" ");
  const uniq: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const t = parts[i].trim();
    if (!t || t.length < 4) continue;
    if (STOPWORDS_FR.has(t)) continue;
    if (uniq.indexOf(t) !== -1) continue;
    uniq.push(t);
    if (uniq.length >= max) break;
  }
  return uniq;
}

function detectArticleMention(q: string): { mentioned: boolean; nums: string[] } {
  const s = q.toLowerCase();
  const nums: string[] = [];
  const re = /\b(?:art\.?|article)\s+([0-9]{1,5})\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) nums.push(m[1]);
  return { mentioned: nums.length > 0, nums };
}

function expandQuery(message: string, baseKeywords: string[], expected: Jurisdiction, unionAssumed: boolean) {
  const s = message.toLowerCase();
  const kw = [...baseKeywords];

  const add = (t: string) => {
    const x = t.toLowerCase().trim();
    if (!x || x.length < 3) return;
    if (STOPWORDS_FR.has(x)) return;
    if (kw.indexOf(x) === -1) kw.push(x);
  };

  const pinnedArticleNums: string[] = [];
  const has = (needle: string) => s.includes(needle);

  if (
    has("responsabilité civile") ||
    (has("responsabilite") && has("civile")) ||
    has("faute") ||
    has("préjudice") ||
    has("prejudice") ||
    has("dommage") ||
    has("causal")
  ) {
    add("faute");
    add("préjudice");
    add("prejudice");
    add("dommage");
    add("causalité");
    add("causalite");
    add("lien");
    add("réparation");
    add("reparation");
    if (expected === "QC" || expected === "UNKNOWN") pinnedArticleNums.push("1457", "1458", "1459");
  }

  if (has("contrat") || has("contractuel") || has("inexécution") || has("inexecution") || has("obligation")) {
    add("contrat");
    add("obligation");
    add("inexécution");
    add("inexecution");
    add("dommages");
    add("réparation");
    add("reparation");
  }

  if (hasWorkSignals(message)) {
    add("congédiement");
    add("licenciement");
    add("renvoi");
    add("motif");
    add("cause");
    add("probation");
    add("préavis");
    add("preavis");
    add("recours");

    if (unionAssumed) {
      add("syndicat");
      add("grief");
      add("convention collective");
    } else {
      add("non syndiqué");
      add("non syndique");
      add("plainte");
      add("normes du travail");
      add("commission des normes");
      add("cnesst");
    }
  }

  if (hasPenalSignals(message) || hasQcProvPenalSignals(message)) {
    add("constat");
    add("infraction");
    add("procédure");
    add("procedure");
    add("défendeur");
    add("defendeur");
    add("preuve");
    add("audience");
  }

  if (hasHealthSignals(message)) {
    add("consentement");
    add("soins");
    add("urgence");
    add("inapte");
    add("capacité");
    add("capacite");
    add("dossier");
  }

  return { keywords: kw.slice(0, 14), pinnedArticleNums };
}

// ------------------------------
// Dedup
// ------------------------------
function dedupKey(r: EnrichedRow): string {
  if (r.code_id_struct && r.article_num) return `${r.code_id_struct}::${r.article_num}`;
  if (r.citation) return `CIT::${r.citation}`;
  return `ID::${r.id}`;
}

// ------------------------------
// Ranking / scoring
// ------------------------------
function scoreHit(args: {
  row: EnrichedRow;
  expected: Jurisdiction;
  keywords: string[];
  article: { mentioned: boolean; nums: string[] };
  similarity?: number | null;
}): { hit_quality_score: number; article_conf: number; overlap: number } {
  const { row, expected, keywords, article, similarity } = args;

  let score = 0;

  const jur = normalizeJurisdiction(row.jurisdiction_norm);
  const jurMatch = expected === "UNKNOWN" ? true : jur === expected;

  if (expected === "UNKNOWN") score += 0.3;
  else if (jurMatch) score += 1.0;
  else score -= 0.8;

  const citRaw = row.citation ?? "";
  const cit = citRaw.toLowerCase();
  if (/^art\./i.test(citRaw)) score += 0.15;
  if (cit.startsWith("livre ") || cit.startsWith("book ")) score -= 0.25;

  let articleConf = 0.5;
  if (article.mentioned) {
    articleConf = 0.2;
    if (row.article_num && article.nums.indexOf(row.article_num) !== -1) {
      score += 0.8;
      articleConf = 1.0;
    }
  }

  const hay = `${row.citation ?? ""} ${row.title ?? ""} ${row.text ?? ""}`.toLowerCase();
  let overlap = 0;
  for (let i = 0; i < keywords.length; i++) if (hay.includes(keywords[i])) overlap++;

  if (overlap >= 1) score += 0.2;
  if (overlap >= 2) score += 0.4;
  if (overlap >= 3) score += 0.6;

  if (typeof similarity === "number") {
    if (similarity >= 0.78) score += 0.4;
    else if (similarity >= 0.72) score += 0.2;
  }

  return { hit_quality_score: score, article_conf: articleConf, overlap };
}

function selectJurisdictionFromSources(sources: Source[], fallback: Jurisdiction): Jurisdiction {
  const counts: Record<Jurisdiction, number> = { QC: 0, "CA-FED": 0, OTHER: 0, UNKNOWN: 0 };
  for (let i = 0; i < sources.length; i++) {
    const j = normalizeJurisdiction(sources[i].jur ?? "");
    if (j === "OTHER") counts.OTHER += 1;
    else counts[j] += 1;
  }

  const candidates: Jurisdiction[] = ["QC", "CA-FED", "OTHER"];
  let best: Jurisdiction = "UNKNOWN";
  let bestN = 0;

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const n = counts[c];
    if (n > bestN) {
      bestN = n;
      best = c;
    }
  }

  if (bestN > 0) return best;
  return fallback;
}

// ------------------------------
// Coverage signals
// ------------------------------
function isCharterSource(r: EnrichedRow): boolean {
  const hay = `${r.citation ?? ""} ${r.title ?? ""} ${r.text ?? ""}`.toLowerCase();
  return containsAny(hay, ["charte canadienne", "canadian charter", "charter of rights", "charte des droits et libertés"]);
}
function isCriminalCodeSource(r: EnrichedRow): boolean {
  const hay = `${r.citation ?? ""} ${r.title ?? ""} ${r.text ?? ""}`.toLowerCase();
  return containsAny(hay, ["code criminel", "criminal code", "c.cr", "c-46", "l.r.c. 1985", "r.s.c. 1985"]);
}
function isCanadaLabourCodeSource(r: EnrichedRow): boolean {
  const hay = `${r.citation ?? ""} ${r.title ?? ""} ${r.text ?? ""}`.toLowerCase();
  return containsAny(hay, ["code canadien du travail", "canada labour code", "l-2", "l.c. 1985"]);
}
function isCivilCodeQcSource(r: EnrichedRow): boolean {
  const hay = `${r.citation ?? ""} ${r.title ?? ""} ${r.text ?? ""}`.toLowerCase();
  return containsAny(hay, ["c.c.q", "ccq", "code civil du québec", "code civil du quebec", "rlrq c-ccq"]);
}
function isHealthLawQcSource(r: EnrichedRow): boolean {
  const hay = `${r.citation ?? ""} ${r.title ?? ""} ${r.text ?? ""}`.toLowerCase();
  return containsAny(hay, [
    "lssss",
    "loi sur les services de santé",
    "loi sur les services de sante",
    "loi sur les renseignements personnels",
    "a-2.1",
    "commission d'accès",
    "commission d’acces",
    "cai",
  ]);
}
function hasEvidenceExclusionSignals(message: string): boolean {
  const s = message.toLowerCase();
  return containsAny(s, ["exclusion", "preuve illégale", "preuve illegale", "admissibilité", "admissibilite", "atteinte", "violation"]);
}

// ------------------------------
// Jurisdiction scope & filtering
// ------------------------------
function allowRowByScope(args: {
  row: EnrichedRow;
  domain: Domain;
  jurisdiction_expected: Jurisdiction;
  jurisdiction_selected: Jurisdiction;
  gate: Gate;
}): boolean {
  const { row, domain, jurisdiction_selected, gate } = args;

  const rowJur0 = normalizeJurisdiction(row.jurisdiction_norm);
  const rowJur: Jurisdiction = rowJur0 === "OTHER" ? "OTHER" : rowJur0;

  if (jurisdiction_selected === "UNKNOWN") {
    if (rowJur === "OTHER" && gate.selected !== "OTHER") return false;
    return true;
  }

  if (domain === "Fiscal") {
    if (rowJur === "QC" || rowJur === "CA-FED") return true;
    return false;
  }

  if (domain === "Penal" && jurisdiction_selected === "QC") {
    if (rowJur === "QC") return true;
    if (rowJur === "CA-FED" && isCharterSource(row)) return true;
    return false;
  }

  return rowJur === jurisdiction_selected;
}

// ------------------------------
// Coverage computation (with lock awareness)
// ------------------------------
function computeCoverage(args: {
  domain: Domain;
  message: string;
  finalRows: EnrichedRow[];
  jurisdiction_selected: Jurisdiction;
  gate: Gate;
}): { coverage_ok: boolean; missing_coverage: string[]; ingest_needed: string[] } {
  const { domain, message, finalRows, jurisdiction_selected, gate } = args;

  const missing: string[] = [];
  const ingest: string[] = [];

  if (finalRows.length === 0) {
    const lockNote = gate.lock
      ? "Juridiction verrouillée par exception/signaux; aucune source de cette juridiction n’est disponible."
      : "Aucune source pertinente dans le corpus.";
    return {
      coverage_ok: false,
      missing_coverage: [lockNote],
      ingest_needed: ["Ajouter les textes (loi + juridiction) pertinents à la question."],
    };
  }

  let ok = true;

  if (domain === "Penal") {
    const hasCharter = finalRows.some(isCharterSource);
    const hasCrCode = finalRows.some(isCriminalCodeSource);
    const hasEv = hasEvidenceExclusionSignals(message);

    if (jurisdiction_selected === "CA-FED") {
      ok = hasCrCode && (hasCharter || hasEv);
      if (!hasCrCode) {
        missing.push("Code criminel (disposition pertinente) non trouvé dans les extraits.");
        ingest.push("Ajouter au corpus les dispositions pertinentes du Code criminel (Canada) selon la question (fouille/détention/preuve, etc.).");
      }
      if (!hasCharter) {
        missing.push("Charte canadienne (droit invoqué) non trouvée dans les extraits.");
        ingest.push("Ajouter au corpus les extraits pertinents de la Charte canadienne (droits/réparations) liés à la question.");
      }
    } else {
      ok = finalRows.length >= 1;
    }
  }

  if (domain === "Travail") {
    const work = hasWorkSignals(message);
    const hasCLC = finalRows.some(isCanadaLabourCodeSource);
    if (work && jurisdiction_selected === "CA-FED") {
      ok = hasCLC;
      if (!hasCLC) {
        missing.push("Régime fédéral du travail : extraits pertinents absents (ex. congédiement/recours/délais).");
        ingest.push("Ajouter au corpus le Code canadien du travail (parties pertinentes selon la question).");
      }
    }
  }

  if (domain === "Sante") {
    const hasCCQ = finalRows.some(isCivilCodeQcSource);
    const hasHealth = finalRows.some(isHealthLawQcSource);
    ok = hasCCQ || hasHealth;
    if (!hasCCQ && !hasHealth) {
      missing.push("Base légale santé QC (CCQ ou loi santé/accès pertinente) non trouvée dans les extraits.");
      ingest.push("Ajouter au corpus les articles CCQ pertinents (consentement/aptitude/soins) et/ou la loi québécoise applicable selon la question.");
    }
  }

  const art = detectArticleMention(message);
  if (art.mentioned) {
    const wanted = art.nums;
    const hasAny = finalRows.some((r) => (r.article_num ? wanted.includes(r.article_num) : false));
    if (!hasAny) {
      missing.push(`Article(s) mentionné(s) (${wanted.join(", ")}) non trouvé(s) dans les extraits.`);
      ingest.push(`Ajouter au corpus les articles exacts demandés (${wanted.join(", ")}) (loi + juridiction) ou un extrait officiel les contenant.`);
      ok = domain === "Penal" || domain === "Travail" || domain === "Sante" ? ok : false;
    }
  }

  return { coverage_ok: ok, missing_coverage: missing, ingest_needed: ingest };
}

function computeRelevanceOk(args: { candidates: Array<{ row: EnrichedRow; composite: number; overlap: number }> }): boolean {
  const { candidates } = args;
  if (!candidates.length) return false;

  const best = candidates[0];
  if (best.composite >= 1.2) return true;

  for (let i = 0; i < Math.min(candidates.length, 10); i++) {
    if (candidates[i].overlap >= 2) return true;
  }
  return false;
}

function computeRagQuality(args: {
  jurisdiction_expected: Jurisdiction;
  jurisdiction_selected: Jurisdiction;
  sources: Source[];
  relevance_ok: boolean;
  coverage_ok: boolean;
  domain: Domain;
}): 0 | 1 | 2 | 3 {
  const { jurisdiction_expected, jurisdiction_selected, sources, relevance_ok, coverage_ok, domain } = args;

  const n = sources.length;
  if (n === 0) return 0;

  const fiscalMixed = domain === "Fiscal" && jurisdiction_selected === "UNKNOWN";

  let match = 0;
  if (jurisdiction_expected !== "UNKNOWN" && !fiscalMixed) {
    for (let i = 0; i < sources.length; i++) {
      const j0 = normalizeJurisdiction(sources[i].jur ?? "");
      const norm: Jurisdiction = j0 === "OTHER" ? "OTHER" : j0;
      if (norm === jurisdiction_expected) match++;
    }
  } else {
    match = n >= 1 ? 1 : 0;
  }

  let base: 0 | 1 | 2 = 1;
  if (n >= 2 && (jurisdiction_expected === "UNKNOWN" || match >= 1)) base = 2;
  if (jurisdiction_expected !== "UNKNOWN" && !fiscalMixed && match === 0) base = 1;

  if (base === 2 && relevance_ok && coverage_ok) return 3;
  if (base === 2) return 2;
  return 1;
}

// ------------------------------
// Always-answer fallback (no block)
// ------------------------------
function buildAlwaysAnswerFallback(args: {
  message: string;
  domain: Domain;
  gate: Gate;
  hybridError?: string | null;
  missing_coverage?: string[];
  ingest_needed?: string[];
}): string {
  const { message, domain, gate } = args;

  const unionTxt = gate.assumptions.union_assumed
    ? "on dirait que la situation implique un contexte syndiqué"
    : "à défaut d’indice, je suppose un contexte non syndiqué (à ajuster si besoin)";

  const missing =
    (args.missing_coverage ?? []).length > 0
      ? (args.missing_coverage ?? []).map((x) => `- ${x}`).join("\n")
      : "- Aucune source pertinente n’a été retrouvée dans le corpus.";

  const ingest =
    (args.ingest_needed ?? []).length > 0
      ? (args.ingest_needed ?? []).map((x) => `- ${x}`).join("\n")
      : "- (rien de spécifique détecté)";

  return [
    `Je peux t’aider, mais je n’ai pas retrouvé d’extraits fiables dans le corpus pour appuyer des citations.`,
    domain === "Travail" ? `\n*(Contexte de travail: ${unionTxt}.)*\n` : "",
    `\nVoici une façon sûre d’aborder ta question **sans inventer** :`,
    `- Clarifier le fait central (qui, quoi, quand, où, préjudice/dommage, lien, etc.).`,
    `- Identifier le régime juridique applicable (QC vs fédéral / civil vs pénal / etc.).`,
    `- Appliquer une grille d’analyse (ILAC/IRAC) en laissant les références d’articles en attente tant que le corpus n’est pas disponible.`,
    `\n**Ce que j’ai compris de ta question**\n${message}`,
    `\n**Ce qu’il faut vérifier/ingérer pour citer correctement**\n${missing}`,
    `\n**À ingérer en priorité (si tu veux des articles/citations précises)**\n${ingest}`,
    `\nSi tu me dis : (1) la juridiction visée, (2) le contexte factuel minimal, et (3) le texte/loi que ton cours utilise, je peux reformuler un plan de réponse et les points à rechercher.`,
  ]
    .filter(Boolean)
    .join("\n");
}

// ------------------------------
async function createEmbedding(input: string) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY manquant");
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "text-embedding-3-small", input }),
  });
  if (!res.ok) {
    const err = await safeJson(res);
    throw new Error(`OpenAI embeddings error: ${res.status} ${res.statusText} — ${JSON.stringify(err)}`);
  }
  const data = (await res.json()) as { data: { embedding: number[] }[] };
  return data.data?.[0]?.embedding as number[] | undefined;
}

async function createChatCompletion(messages: Array<{ role: "system" | "user" | "assistant"; content: string }>) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY manquant");
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.15,
      messages,
    }),
  });
  if (!res.ok) {
    const err = await safeJson(res);
    throw new Error(`OpenAI chat error: ${res.status} ${res.statusText} — ${JSON.stringify(err)}`);
  }
  const data = (await res.json()) as any;
  return {
    content: (data.choices?.[0]?.message?.content as string | undefined) ?? "",
    usage: data.usage ?? null,
  };
}

function safeJsonParse<T>(text: string): T | null {
  try {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

// ------------------------------
// Supabase RPC (RLS)
// ------------------------------
async function callRpc<T>(
  supabase: ReturnType<typeof createClient>,
  rpcName: string,
  params: any
): Promise<T[]> {
  const { data, error } = await supabase.rpc(rpcName as any, params);
  if (error) throw new Error(`RPC ${rpcName} failed: ${error.message}`);
  return ((data ?? []) as unknown) as T[];
}

async function hybridSearchRPC(
  supabase: ReturnType<typeof createClient>,
  args: {
    query_text: string;
    query_embedding: number[];
    match_count: number;
    filter_jurisdiction_norm: string | null;
    filter_bucket: string | null;
  }
): Promise<HybridHit[]> {
  const payload = {
    query_text: args.query_text,
    query_embedding: args.query_embedding,
    match_count: args.match_count,
    filter_jurisdiction_norm: args.filter_jurisdiction_norm,
    filter_bucket: args.filter_bucket,
  };

  try {
    return await callRpc<HybridHit>(supabase, "search_legal_vectors_hybrid_v2", payload);
  } catch {
    return await callRpc<HybridHit>(supabase, "search_legal_vectors_hybrid_v1", payload);
  }
}

/** Wrapper anti-timeout. */
async function hybridSearchWithRetry(
  supabase: ReturnType<typeof createClient>,
  args: {
    query_text: string;
    query_embedding: number[];
    domain: Domain;
    gate: Gate;
    jurisdiction_expected: Jurisdiction;
    goal_mode: "exam" | "case" | "learn";
  }
): Promise<{ hits: HybridHit[]; hybridError: string | null }> {
  const { query_text, query_embedding, domain, gate, jurisdiction_expected, goal_mode } = args;

  const basePool = goal_mode === "learn" ? 120 : 180;

  const narrowedJur: string | null =
    domain === "Fiscal"
      ? null
      : gate.lock
      ? jurisdiction_expected === "UNKNOWN"
        ? null
        : jurisdiction_expected
      : jurisdiction_expected !== "UNKNOWN"
      ? jurisdiction_expected
      : null;

  const attempts: Array<{ match_count: number; filter_jurisdiction_norm: string | null }> = [
    { match_count: basePool, filter_jurisdiction_norm: null },
    { match_count: 90, filter_jurisdiction_norm: narrowedJur },
    { match_count: 45, filter_jurisdiction_norm: narrowedJur },
  ];

  let lastErr: string | null = null;

  for (let i = 0; i < attempts.length; i++) {
    const a = attempts[i];
    try {
      const hits = await hybridSearchRPC(supabase, {
        query_text,
        query_embedding,
        match_count: a.match_count,
        filter_jurisdiction_norm: a.filter_jurisdiction_norm,
        filter_bucket: null, // IMPORTANT : ne pas confondre bucket et juridiction
      });

      return { hits, hybridError: null };
    } catch (e: any) {
      lastErr = e?.message ?? String(e);
      if (!isStatementTimeout(lastErr)) break;
    }
  }

  return { hits: [], hybridError: lastErr };
}

// ------------------------------
// Locks / overrides
// ------------------------------
function hasStrongFedOverride(message: string): boolean {
  return (
    hasFedLegalSignals(message) ||
    hasFedAdminAgencySignals(message) ||
    hasFedPublicEmployerSignals(message) ||
    hasFedWorkSectorSignals(message).matched ||
    /\b(code criminel|criminal code|irpa|immigration and refugee protection)\b/i.test(message)
  );
}
function hasStrongPenalOverride(message: string): boolean {
  return /\b(code criminel|criminal code|mens rea|actus reus|accusation|infraction|procureur|dpcp)\b/i.test(message);
}
function courseJurisdictionLock(profileObj: any): Jurisdiction | null {
  const j = String(profileObj?.B?.juridiction_principale ?? "").toUpperCase().trim();
  if (j === "QC") return "QC";
  if (j === "CA-FED" || j === "FED") return "CA-FED";
  if (j === "OTHER") return "OTHER";
  return null;
}
// ------------------------------
// CodeId normalization helpers
// ------------------------------
function normCodeIdStrict(codeId: string | null | undefined): string {
  // strict: conserve ponctuation, mais normalise casse/espaces
  return String(codeId ?? "").trim().toLowerCase();
}

function normCodeIdLoose(codeId: string | null | undefined): string {
  // loose: enlève ponctuation (CCQ == C.c.Q.)
  return String(codeId ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}



// ------------------------------
// Mapping helpers (course laws) — RLS safe
// ------------------------------
async function getCourseCanonicalCodes(
  supabase: ReturnType<typeof createClient>,
  course_slug: string
): Promise<string[]> {
  const { data, error } = await supabase
    .from("course_law_requirements")
    .select("canonical_code_id")
    .eq("course_slug", course_slug);

  if (error) throw new Error(`getCourseCanonicalCodes failed: ${error.message}`);

  const uniq = new Set<string>();
  for (const r of data ?? []) {
    const v = (r as any).canonical_code_id;
    if (typeof v === "string" && v.trim()) uniq.add(v.trim());
  }
  return Array.from(uniq);
}
type CodeIdSets = { strict: Set<string>; loose: Set<string> };

async function expandAliases(
  supabase: ReturnType<typeof createClient>,
  canonicalCodes: string[]
): Promise<CodeIdSets> {
  const strict = new Set<string>();
  const loose = new Set<string>();

  const addBoth = (v: string | null | undefined) => {
    const raw = String(v ?? "").trim();
    if (!raw) return;
    strict.add(normCodeIdStrict(raw));
    loose.add(normCodeIdLoose(raw));
  };

  // inclure les codes fournis (canon) en strict+loose
  for (const c of canonicalCodes ?? []) addBoth(c);

  if (!canonicalCodes?.length) return { strict, loose };

  const { data, error } = await supabase
    .from("code_aliases")
    .select("canonical_code,aliases")
    .in("canonical_code", canonicalCodes);

  if (error || !data) return { strict, loose };

  for (const row of data as any[]) {
    addBoth(row?.canonical_code);
    const aliases = row?.aliases;
    if (Array.isArray(aliases)) {
      for (const a of aliases) addBoth(a);
    }
  }

  return { strict, loose };
}


async function getIngestNeededForCourse(supabase: ReturnType<typeof createClient>, course_slug: string): Promise<string[]> {
  const { data, error } = await supabase.from("course_law_requirements").select("law_key,canonical_code_id,status").eq("course_slug", course_slug);
  if (error) return [];

  const needed = new Set<string>();
  for (const r of data ?? []) {
    const status = String((r as any).status ?? "").toLowerCase().trim();
    if (status && status !== "ingested") {
      const c = (r as any).canonical_code_id;
      const k = (r as any).law_key;
      const v =
        typeof c === "string" && c.trim() ? c.trim() : typeof k === "string" && k.trim() ? k.trim() : null;
      if (v) needed.add(v);
    }
  }
  return Array.from(needed).slice(0, 24);
}

async function fetchTopDistinctions(
  supabase: ReturnType<typeof createClient>,
  course_slug: string,
  limit = 8
): Promise<DistinctionRow[]> {
  const { data, error } = await supabase
    .from("concept_distinctions")
    .select("id,course_slug,concept_a,concept_b,rule_of_thumb,pitfalls,when_it_matters,priority")
    .eq("course_slug", course_slug)
    .order("priority", { ascending: false })
    .limit(limit);

  if (error) return [];
  return (data ?? []) as any;
}
// ------------------------------
// Allowlist v2: validation par "signature" (numéro + code loose)
// ------------------------------
function extractArticleSignaturesFromSources(
  sources: Array<{ citation?: string | null; title?: string | null }>
): Set<string> {
  const sigs = new Set<string>();

  const toLooseCode = (s: string) =>
    s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");

  for (const src of sources ?? []) {
    const c = String(src?.citation ?? "").toLowerCase();

    // capture: "art. 1457 C.c.Q." / "article 58 L.P.C." / "s. 17 RSC 1985..."
    const m = c.match(/\b(?:art\.?|article|s\.|section)\s*([0-9]{1,5}(?:\.[0-9]+)?)\b/g);
    if (!m) continue;

    // essaie d'inférer un "code" depuis la citation (tout ce qui suit le numéro)
    // ex: "art. 1457 c.c.q." => codePart ~ "c.c.q."
    for (const hit of m) {
      const num = hit.match(/([0-9]{1,5}(?:\.[0-9]+)?)/)?.[1];
      if (!num) continue;

      // code part: prend ce qui suit le numéro dans la citation globale
      const idx = c.indexOf(num);
      const tail = idx >= 0 ? c.slice(idx + num.length) : "";
      const codeGuess = toLooseCode(tail).slice(0, 24); // borné

      // deux signatures: "num|codeGuess" + "num|*" (fallback)
      sigs.add(`${num}|${codeGuess}`);
      sigs.add(`${num}|*`);
    }
  }

  return sigs;
}

function extractUserRequestedArticleRefs(text: string): Array<{ num: string; codeLoose: string | "*" }> {
  const s = text.toLowerCase();

  // capture "article 1457", "art. 1457", etc.
  const re = /\b(?:art\.?|article)\s*([0-9]{1,5}(?:\.[0-9]+)?)\b([^\n\r]{0,40})?/g;
  const refs: Array<{ num: string; codeLoose: string | "*" }> = [];
  let m: RegExpExecArray | null;

  const toLoose = (x: string) => x.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");

  while ((m = re.exec(s)) !== null) {
    const num = m[1];
    const tail = m[2] ?? "";
    const codeLoose = toLoose(tail).slice(0, 24);
    refs.push({ num, codeLoose: codeLoose || "*" });
  }

  return refs;
}

// ------------------------------
// Prompt + output checks
// ------------------------------
const SYSTEM_PROMPT = `
Tu es **Droitis**, tuteur IA juridique pour le **Québec** et le **Canada fédéral**.
Ta mission: produire une réponse **utile, rigoureuse, pédagogique, et contrôlée** (zéro invention), en appliquant une **méthode de raisonnement juridique explicite** (qualification → règles → application → conclusion), tout en restant conversationnel.

========================
1) PRINCIPES NON NÉGOCIABLES (anti-hallucination)
========================
- Interdiction absolue d’**inventer** : loi, article, jurisprudence, doctrine, citation, URL, date, numéro de dossier, seuil, délai, exception, test, nuance.
- Tu ne peux **appuyer** (citer/attribuer) QUE ce qui est fourni dans les **sources** et la **liste autorisée** (allowlist).  
- Si une info n’est pas dans les sources: tu le dis clairement et tu proposes quoi **ajouter/ingérer** (texte/loi/jurisprudence précise).
- Si la question est ambiguë, tu dois **désambiguïser** AVANT d’appliquer une règle: soit en posant 1 question courte, soit (si mode “no-block”) en annonçant une hypothèse **minimale**.

========================
2) BIJURIDISME / JURIDICTION / CONFLITS DE RÉGIMES
========================
- Le Canada est **bijuridique**: droit civil (Québec) et common law (autres provinces). En matière de propriété et droits civils, le droit fédéral s’interprète en reconnaissant l’autorité égale des deux traditions (lecture bijuridique).  
- Donc:
  (A) Si la juridiction = QC → raisonne d’abord en **droit civil québécois** (Code civil, lois QC, concepts civilistes).
  (B) Si la juridiction = CA-FED → raisonne en droit fédéral, tout en respectant le **cadre bijuridique** lorsqu’un concept de droit privé est en jeu (propriété/droits civils).
  (C) Si la juridiction est verrouillée (lock=true) → tu n’as PAS le droit d’appliquer un autre régime “par défaut”.

- Tu dois annoncer la juridiction applicable **en une courte phrase** au début de la réponse (style naturel), sans afficher de debug.

========================
3) MÉTHODE DE RAISONNEMENT JURIDIQUE (discipline)
========================
Tu dois suivre une logique de type “penser comme juriste”:
(1) **Qualification**: reformule les faits juridiquement (ex: responsabilité, contrat, emploi, pénal, fiscal, administratif, santé, etc.).  
(2) **Question juridique**: formule l’issue centrale (“est-ce que…?”) + 1 sous-question max si nécessaire.  
(3) **Règle(s)**: énonce uniquement les règles **supportées** par les sources (ou dis “non disponible dans le corpus”).  
(4) **Application / Subsomption**: applique la règle aux faits: élément par élément (conditions → faits → conclusion intermédiaire).  
(5) **Conclusion opérationnelle**: résultat + incertitudes + ce qui ferait basculer l’analyse.

IMPORTANT:
- Tu dois éviter les “grands principes vagues”. Chaque étape doit relier **un élément juridique** à **un fait** (même hypothétique).
- Si les faits manquent, tu le dis et tu proposes une hypothèse minimale (no-block) OU 1 question ciblée.

========================
4) INTERPRÉTATION (quand un terme/règle est ambigu)
========================
Quand une source est ambiguë ou qu’un terme peut avoir plusieurs sens:
- Priorise une lecture **textuelle + contextuelle + téléologique** (but de la règle), mais uniquement si tes sources permettent d’identifier ce contexte.
- Si ce contexte n’est pas dans les sources: tu n’inventes pas; tu expliques l’ambiguïté et ce qu’il faudrait ingérer.

========================
5) POLYSÉMIE / AMBIGUÏTÉS TERMINOLOGIQUES (obligatoire)
========================
Beaucoup de mots juridiques sont polysémiques (ex: “responsabilité”, “faute”, “droit”, “dommages”, “préjudice”, “sanction”, “nullité”, “résiliation”, “validité”, “opposabilité”, etc.).
Règle:
- Dès que tu détectes un terme pouvant changer le régime (civil vs pénal; QC vs fédéral; contrat vs extracontractuel; syndiqué vs non; public vs privé), tu dois:
  1) proposer 2–3 sens possibles,
  2) indiquer l’impact sur le raisonnement,
  3) choisir 1 sens sur la base du contexte fourni (ou poser 1 question si impossible).
  4) Si le cours choisi est un cours pouvant aidé à la déduction du sens au terme polysémique, choisi ce sens.

========================
6) RÈGLES “NO-BLOCK” / HYPOTHÈSES PAR DÉFAUT
========================
Si l’utilisateur n’a pas donné l’info essentielle, tu peux faire 1 hypothèse MINIMALE, annoncée explicitement dans l’application.
Hypothèses autorisées (si non mentionné):
1) Travail: NON syndiqué.
2) Faits: version la plus simple (chronologie courte, 1 acteur principal).
3) Si la juridiction n’est pas verrouillée: utiliser la juridiction majoritaire du domaine.
Mais: si lock=true → aucune hypothèse ne peut changer le régime.

========================
7) FORMAT DE RÉPONSE (visible, style Droitis)
========================
En production, la réponse doit être:
- conversationnelle, claire, humaine, pas robotique;
- 1–2 sous-titres max, paragraphes courts;
- analytique, précise, complète et juridiquement juste au niveau du vocabulaire
- pas de “blocs debug”, pas de jargon interne.

Structure minimale obligatoire dans answer_markdown:
- **Idée centrale** (paraphrase simple de la règle supportée)
- **Ce qu’il faut prouver** (checklist 3–6 puces)
- **Mini-exemple guidé** (faits → application → conclusion)
- **Pièges fréquents** (2–4 puces)

Si l’utilisateur vise un article précis ET qu’au moins 1 source existe:
- tu dois expliquer l’article concrètement (paraphrase) + éléments + mini-exemple.
- Interdit de répondre en 1 phrase.

========================
8) SOURCES / CITATIONS (contrôle strict)
========================
- Tu ne cites que via **source_ids_used**, sous-ensemble exact de la liste Allowed source_ids.
- Tu ne dois jamais mentionner un article/arrêt “de mémoire”.
- Si tu dois évoquer une règle sans source: tu dis “non disponible dans le corpus actuel” et tu listes ingest_needed.

========================
9) ADAPTATION AU BUT (user_goal)
========================
- comprendre: explication + analogie + mini-exemple + mini-quiz (1 question).
- examen: checklist + pièges + “si tu vois X → fais Y” (2–4 règles actionnables).
- reformuler: reformulation + correction des ambiguïtés + version finale courte.

Ajoute 3 followups max (“Si tu veux, je peux…”).
`.trim();

type ModelJson = {
  type: "answer" | "clarify" | "refuse";
  jurisdiction: Jurisdiction;
  domain?: Domain;
  ilac?: { probleme: string; regle: string; application: string; conclusion: string };

  // Phase 4D conversationnelle
  answer_markdown?: string;
  followups?: string[];
  quiz?: { question: string; expected_points?: string[] };

  clarification_question?: string;
  refusal_reason?: string;
  partial?: boolean;
  missing_coverage?: string[];
  ingest_needed?: string[];
  source_ids_used?: Array<string | number>;
  warning?: string;
};

function enforceAllowedSourceIds(parsed: ModelJson, allowed: string[]): { ok: boolean; bad: string[]; kept: string[] } {
  const used = (parsed.source_ids_used ?? []).map((x) => String(x));
  const bad: string[] = [];
  const kept: string[] = [];
  for (let i = 0; i < used.length; i++) {
    const id = used[i];
    if (allowed.indexOf(id) === -1) bad.push(id);
    else kept.push(id);
  }
  return { ok: bad.length === 0, bad, kept };
}

function buildAllowedCitationText(sources: Source[]): string {
  const uniq = new Set<string>();
  const add = (s: string) => {
    const v = (s ?? "").trim().toLowerCase();
    if (v) uniq.add(v);
  };

  for (let i = 0; i < sources.length; i++) {
    const c = (sources[i].citation ?? "").trim();
    if (!c) continue;

    add(c);

    const m = c.match(/\b(?:art\.?|article)\s*([0-9]{1,5})\b/i);
    if (m?.[1]) {
      const n = m[1];
      add(`art. ${n}`);
      add(`art ${n}`);
      add(`article ${n}`);
    }
  }

  return Array.from(uniq).join(" | ");
}

function redactUnsupportedRefs(
  text: string,
  allowedCitationsLower: string
): { text: string; redactions: string[] } {
  let out = text ?? "";
  const redactions: string[] = [];

  // 1) Construit un set des numéros d’articles réellement présents dans les citations autorisées
  //    → évite le faux négatif "article 1457" vs "art. 1457 C.c.Q."
  const allowedArticleNums = new Set<string>();
  {
    const re = /\b(?:art\.?|article|s\.|section)\s*([0-9]{1,5}(?:\.[0-9]+)?)\b/gi;
    let m: RegExpExecArray | null;
    const s = allowedCitationsLower ?? "";
    while ((m = re.exec(s)) !== null) {
      if (m[1]) allowedArticleNums.add(m[1]);
    }
  }

  // 2) Redaction des références d’articles
  const artRe = /\b(?:art\.?|article)\s*([0-9]{1,5}(?:\.[0-9]+)?)\b/gi;
  out = out.replace(artRe, (m, num) => {
    const ml = String(m).toLowerCase();
    // a) match exact si la citation contient littéralement "article 1457"
    if ((allowedCitationsLower ?? "").includes(ml)) return m;
    // b) match robuste si le NUMÉRO existe quelque part dans les citations (ex: "art. 1457 C.c.Q.")
    if (num && allowedArticleNums.has(String(num))) return m;

    redactions.push(m);
    return "article [non supporté par le corpus]";
  });

  // 3) Redaction des références jurisprudentielles (inchangé)
  const caseRe = /\b(19\d{2}|20\d{2})\s*(CSC|SCC|QCCA|QCCS|QCCQ|BCCA|ONCA|FCA|CAF)\s*([0-9]{1,6})\b/gi;
  out = out.replace(caseRe, (m) => {
    const ml = m.toLowerCase();
    if ((allowedCitationsLower ?? "").includes(ml)) return m;
    redactions.push(m);
    return "[référence non supportée par le corpus]";
  });

  return { text: out, redactions };
}


function buildServerIlacFallback(args: {
  message: string;
  domain: Domain;
  jurisdiction: Jurisdiction;
  gate: Gate;
  cov: { missing_coverage: string[]; ingest_needed: string[] };
}): NonNullable<ModelJson["ilac"]> {
  const { message, domain, jurisdiction, gate } = args;

  const unionTxt = gate.assumptions.union_assumed ? "syndiqué (signal détecté)" : "non syndiqué (hypothèse par défaut, aucun signal)";
  const assumptions = domain === "Travail" ? `Hypothèse travail: ${unionTxt}.` : "Hypothèses: faits non précisés → hypothèses communes appliquées.";

  return {
    probleme: message,
    regle:
      "Je me limite strictement aux extraits disponibles dans le corpus. " +
      "Si le corpus ne contient pas les textes applicables à la juridiction retenue, l’information juridique de fond n’est pas disponible ici.",
    application:
      `${assumptions} ` +
      "Comme les extraits nécessaires au régime applicable ne sont pas présents (ou insuffisants), je ne peux pas appliquer une règle de fond sans risquer d’inventer ou d’importer un mauvais régime.",
    conclusion: `Pour aller plus loin avec des citations précises, il faudra ingérer les textes du régime ${jurisdiction} pertinents (voir ingest_needed).`,
  };
}

// ------------------------------
// Render answer (FIX: function closed properly)
// ------------------------------
function renderAnswer(args: {
  parsed: ModelJson;
  sources: Source[];
  distinctions: DistinctionRow[];
  serverWarning?: string;
  examTip?: string | null;
  mode: "prod" | "dev";
}): string {
  const { parsed, sources, serverWarning, examTip, mode } = args;

  


  // DEV: on peut afficher blocks missing/ingest
  const missingBlock =
    Array.isArray(parsed.missing_coverage) && parsed.missing_coverage.length
      ? `**Couverture manquante**\n\n${parsed.missing_coverage.map((x) => `- ${x}`).join("\n")}`
      : "";

  const ingestBlock =
    Array.isArray(parsed.ingest_needed) && parsed.ingest_needed.length
      ? `**À ingérer pour répondre avec certitude**\n${parsed.ingest_needed.map((x) => `- ${x}`).join("\n")}`
      : "";

  if (parsed.type === "refuse") {
    return [
      parsed.refusal_reason ?? "Je ne peux pas répondre de façon fiable avec le corpus actuel.",
      "",
      missingBlock,
      ingestBlock ||
        "**Information non disponible dans le corpus actuel. Pour répondre avec certitude, il faut ingérer :**\n- (préciser la loi / l’article / la juridiction à ingérer).",
    ]
      .filter((x): x is string => Boolean(x && x.trim()))
      .join("\n");
  }

  const ilac = parsed.ilac;
  if (!ilac) {
    return [
      serverWarning || parsed.warning ? `⚠️ ${serverWarning || parsed.warning}` : "",
      missingBlock,
      ingestBlock,
      "\n*(Structure ILAC indisponible dans la réponse modèle.)*",
      examTip ? `\n**Conseil examen**\n${examTip}\n` : "",
    ]
      .filter((x): x is string => Boolean(x && x.trim()))
      .join("\n");
  }

  const usedIds = (parsed.source_ids_used ?? []).map((x) => String(x));
  const citedLines = usedIds
    .map((id) => {
      const s = sources.find((x) => String(x.id) === id);
      if (!s) return null;
      const jur = s.jur ?? "";
      const cit = s.citation ?? "(citation indisponible)";
      const url = s.url ?? "";
      const tail = [id ? `id:${id}` : null, url ? url : null].filter(Boolean).join(" — ");
      return `- ${cit}${jur ? ` — (${jur})` : ""}${tail ? " — " + tail : ""}`;
    })
    .filter(Boolean)
    .join("\n");

  const warn = serverWarning || parsed.warning ? `\n\n⚠️ ${serverWarning || parsed.warning}\n` : "";

  return [
    warn,
    `**Problème**\n${ilac.probleme}`,
    `\n**Règle**\n${ilac.regle}`,
    `\n**Application**\n${ilac.application}`,
    `\n**Conclusion**\n${ilac.conclusion}`,
    missingBlock,
    ingestBlock,
    `\n**Sources citées (allowlist uniquement)**\n${citedLines || "- (aucune)"}\n`,
    examTip ? `\n**Conseil examen**\n${examTip}\n` : "",
  ]
    .filter((x): x is string => Boolean(x && x.trim()))
    .join("\n");
}

// ------------------------------
// Wrong-regime detector
// ------------------------------
const QC_LABOUR_FORBIDDEN_IF_FED = ["cnesst", "tribunal administratif du travail", "tat", "normes du travail", "commission des normes", "rlrq", "loi sur les normes", "lnt"];
const FED_LABOUR_FORBIDDEN_IF_QC = ["code canadien du travail", "canada labour code", "l.c. 1985", "l-2"];

function hasForbiddenRegimeLeak(args: { text: string; domain: Domain; jurisdiction: Jurisdiction }): boolean {
  const t = (args.text ?? "").toLowerCase();
  if (args.domain !== "Travail") return false;
  if (args.jurisdiction === "CA-FED") return containsAny(t, QC_LABOUR_FORBIDDEN_IF_FED);
  if (args.jurisdiction === "QC") return containsAny(t, FED_LABOUR_FORBIDDEN_IF_QC);
  return false;
}

// ------------------------------
// Source picking improvement
// ------------------------------
function bestFallbackSourceIds(args: { sources: Source[]; domain: Domain; jurisdiction: Jurisdiction }): Array<string | number> {
  const { sources, domain, jurisdiction } = args;
  if (!sources.length) return [];

  const score = (s: Source) => {
    const jur0 = normalizeJurisdiction(s.jur ?? "");
    const jur: Jurisdiction = jur0 === "OTHER" ? "OTHER" : jur0;

    let sc = 0;
    if (jurisdiction !== "UNKNOWN" && jur === jurisdiction) sc += 2;

    const cit = (s.citation ?? "").toLowerCase();
    if (domain === "Penal" && cit.includes("procédure pénale")) sc += 1;
    if (domain === "Fiscal" && (cit.includes("impôt") || cit.includes("impot") || cit.includes("tax"))) sc += 1;

    if (/^art\./i.test((s.citation ?? "").trim())) sc += 0.5;

    return sc;
  };

  const ranked = [...sources].sort((a, b) => score(b) - score(a));
  return ranked.slice(0, Math.min(2, ranked.length)).map((x) => x.id);
}

// ------------------------------
// Explicit-article detection (SINGLE definition)
// ------------------------------
function detectExplicitArticleRef(message: string): { code_id: string; article: string } | null {
  const re = /(art(?:icle)?\.?\s*)?(\d{1,6}(?:\.\d+)*)\s*(c\.?c\.?q|ccq|c\.c\.q|l\.?p\.?c|lpc)/i;
  const m = message.match(re);
  if (!m) return null;

  const article = m[2];
  const raw = (m[3] ?? "").toLowerCase();
  const code_id = raw.includes("lpc") ? "L.P.C." : "C.c.Q.";
  return { code_id, article };
}

// ------------------------------
// Ensure minimum length (SINGLE definition)
// ------------------------------
function ensureMinLength(answer: string, args: { message: string; gmode?: string }) {
  const gmode = args.gmode ?? "comprendre";
  const min = gmode === "comprendre" ? 1200 : gmode === "examen" ? 900 : 700;

  const base = (answer ?? "").trim();
  if (base.length >= min) return base;

  return [
    base,
    "",
    "### Idée centrale (en mots simples)",
    "- Reformule l’article comme une règle pratique : **qui doit faire quoi, et dans quelles conditions**.",
    "",
    "### Ce qu’il faut prouver (checklist)",
    "- **Fait déclencheur** : quel comportement ou omission est reproché ?",
    "- **Faute / manquement** : en quoi le comportement s’écarte-t-il de ce qu’on attend ?",
    "- **Dommage** : quel préjudice concret est invoqué ?",
    "- **Lien causal** : pourquoi ce dommage découle-t-il de ce comportement ?",
    "",
    "### Mini-exemple guidé",
    "1) Décris une situation simple (2–3 phrases).",
    "2) Applique la checklist ci-dessus point par point.",
    "3) Conclus: responsabilité probable ou non, et pourquoi.",
    "",
    "### Pièges fréquents",
    "- Confondre **dommage** (conséquence) et **faute** (comportement).",
    "- Oublier le **lien causal** (même s’il y a faute + dommage).",
    "- Rester vague: il faut des faits concrets pour appliquer la règle.",
    "",
    "### Pour aller plus loin (3 questions)",
    "- Quels faits précis pourrais-tu me donner (chronologie, acteurs, dommages) pour appliquer l’article à TON cas ?",
    "- Est-ce une situation plutôt **contractuelle** ou **extra-contractuelle** (ou mixte) ?",
    "- Quel type de dommage (matériel, corporel, moral) est allégué et comment il est démontré ?",
  ].join("\n");
}

// ------------------------------
// buildUserPayloadText (keep, but safe)
// ------------------------------
function buildUserPayloadText(userPayload: string): string;
function buildUserPayloadText(userPayload: unknown[]): string;
function buildUserPayloadText(userPayload: unknown[] | string): string {
  if (typeof userPayload === "string") return userPayload;
  if (!Array.isArray(userPayload)) return "";
  return userPayload.reduce<string>((acc, v) => {
    const s = typeof v === "string" ? v.trim() : "";
    return s ? (acc ? acc + "\n" + s : s) : acc;
  }, "");
}
async function directArticleLookup(args: {
  supabase: ReturnType<typeof createClient>;
  articleNum: string;
  codeCandidates: string[]; // canon (mapping) ou vide
  jurisdictionNorm: string | null; // ex "QC" ou null
}): Promise<HybridHit[]> {
  const { supabase, articleNum, codeCandidates, jurisdictionNorm } = args;


// 1) Expand canon -> aliases (strict + loose)
const allowed =
  codeCandidates?.length > 0
    ? await expandAliases(supabase, codeCandidates)
    : { strict: new Set<string>(), loose: new Set<string>() };


  // 2) On tente 2 passes:
  //    - pass A: match strict (code_id exact-ish)
  //    - pass B: match loose (en enlevant ponctuation côté client)
type LegalVectorRow = {
  id: number;
  code_id: string | null;
  citation: string | null;
  title: string | null;
  text: string | null;
  jurisdiction: string | null;
  jurisdiction_bucket: string | null;
};

// 2) Fetch candidates by citation match (fast path)
const { data, error } = await supabase
  .from("legal_vectors")
  .select("id,code_id,citation,title,text,jurisdiction,jurisdiction_bucket")
  .ilike("citation", `%${articleNum}%`)
  .limit(20);

if (error || !data) return [];

const rows = (data as LegalVectorRow[]).filter((r) => {
  // Jurisdiction filter
  if (jurisdictionNorm && String(r.jurisdiction ?? "").toUpperCase() !== jurisdictionNorm.toUpperCase()) {
    return false;
  }

  // If no code constraints, accept (article+juri already filtered)
  if (allowed.strict.size === 0 && allowed.loose.size === 0) return true;

  const codeId = String(r.code_id ?? "");
  const codeStrict = normCodeIdStrict(codeId);
  const codeLoose = normCodeIdLoose(codeId);

  // O(1) strict/loose match
  return allowed.strict.has(codeStrict) || allowed.loose.has(codeLoose);
});


  // 3) Mapper vers HybridHit complet (champs requis)
  return rows.map((r) => ({
    id: String(r.id),
    code_id: String(r.code_id ?? ""),
    citation: String(r.citation ?? ""),
    title: String(r.title ?? ""),
    text: String(r.text ?? ""),
    jurisdiction: String(r.jurisdiction ?? ""),
    jurisdiction_bucket: String(r.jurisdiction_bucket ?? ""),

    // Champs exigés par EnrichedRow/HybridHit (complétés ici)
    jurisdiction_norm: String(r.jurisdiction ?? "").toUpperCase(),
    code_id_struct: null,
    article_num: String(articleNum),
    url_struct: null,

    // Ranks (direct lookup = priorité)
    fts_rank: 999,
    semantic_rank: 999,
    similarity: 1,
  })) as any;
}

// ------------------------------
// POST
// ------------------------------
export async function POST(req: Request): Promise<Response> {
  const supabaseAuth = createClient();
  const supabaseAdmin = createServiceClient();
  const supabaseUser = createUserClient(); // si tu en as besoin ailleurs

  const {
    data: { user },
  } = await supabaseAuth.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: CORS_HEADERS });
  }

  const startedAt = Date.now();
  
  // ✅ CRITIQUE: variables “parsedObj / followups” déclarées 1 fois, haut niveau (plus d’erreur “used before declared”)
  let parsedObj: ModelJson = { type: "answer", jurisdiction: "UNKNOWN" };
  let followups: string[] = [];

  try {
    if (!OPENAI_API_KEY) return json({ error: "OPENAI_API_KEY manquant" }, 500);
    const body = (await req.json().catch(() => ({}))) as ChatRequest;

    // ------------------------------
    // Message extraction
    // ------------------------------
    let message =
      (typeof body.message === "string" && body.message.trim()) ||
      (typeof body.question === "string" && body.question.trim()) ||
      "";

    if (!message && Array.isArray(body.messages)) {
      for (let i = body.messages.length - 1; i >= 0; i--) {
        const m = body.messages[i];
        if (m && m.role === "user" && typeof m.content === "string" && m.content.trim()) {
          message = m.content.trim();
          break;
        }
      }
    }

    if (!message) {
      return json(
        {
          error: "Missing question",
          details: "Le body JSON doit contenir soit { message }, soit { question }, soit { messages:[...] }.",
        },
        { status: 400 }
      );
    }
const artMatch = message.match(/\b(?:art\.?|article)\s*([0-9]{1,5})\b/i);
const articleNum = artMatch?.[1] ?? null;

    const course_slug =
      typeof body.course_slug === "string" && body.course_slug.trim() ? body.course_slug.trim() : "general";
    const user_goal = typeof body.user_goal === "string" && body.user_goal.trim() ? body.user_goal.trim() : null;
    const institution_name =
      typeof body.institution_name === "string" && body.institution_name.trim() ? body.institution_name.trim() : null;

    const risk_flags: Record<string, any> = {};
    if (!course_slug) risk_flags.missing_course_slug = true;

    const profile = body.profile ?? null;
    const top_k = clamp(body.top_k ?? 7, 5, 8);
    const mode = (body.mode ?? "prod").toLowerCase();

    const intent = inferIntent({ message, user_goal });
    const gmode = intent.goal_mode;
    const wants_exam_tip = intent.wants_exam_tip;

    // ------------------------------
    // Course profile + initial expanded query
    // ------------------------------
    const profileObj = getCourseProfile(course_slug) ?? getCourseProfile("general");
    const { expanded: expandedQuery } = expandQueryWithProfile(message, profileObj);
    let expanded = expandedQuery;

    // ------------------------------
    // Domain/Jurisdiction FIRST (FIX: needed before senseRouter microRetrieve uses gate/jurisdiction_expected)
    // ------------------------------
    let domain_detected = detectDomain(message);

    const forcedDomain = domainByCourseSlug(course_slug);
    const lockedJur = courseJurisdictionLock(profileObj);

    if (
      course_slug !== "general" &&
      lockedJur === "QC" &&
      forcedDomain === "Civil" &&
      !hasStrongFedOverride(message) &&
      !hasStrongPenalOverride(message)
    ) {
      domain_detected = "Civil";
    } else if (forcedDomain && domain_detected === "Inconnu") {
      domain_detected = forcedDomain;
    }

    let gate = jurisdictionGateNoBlock(message, domain_detected);
    if (course_slug !== "general" && lockedJur === "QC" && !gate.lock && !hasStrongFedOverride(message)) {
      gate = { ...gate, selected: "QC", lock: true, reason: "course_lock_qc" };
    }

    const jurisdiction_expected = gate.selected;

    // ------------------------------
    // Supabase mini-GET helper (used by senseRouter)
    // ------------------------------
    const supaGet = async <T,>(path: string): Promise<T> => {
      if (path.startsWith("/rest/v1/legal_senses")) {
        const qs = path.split("?")[1] ?? "";
        const params = new URLSearchParams(qs);
        const termEq = params.get("term");
        const term = termEq?.startsWith("eq.") ? decodeURIComponent(termEq.slice(3)) : null;
        const sel = params.get("select") ?? "id,term,domain,jurisdiction_hint,description,canonical_query,course_slugs";

        let q = supabaseAuth.from("legal_senses").select(sel);
        if (term) q = q.eq("term", term);
        const { data, error } = await q;
        if (error) throw new Error(`legal_senses select failed: ${error.message}`);
        return (data ?? []) as any;
      }

      if (path.startsWith("/rest/v1/legal_sense_triggers")) {
        const qs = path.split("?")[1] ?? "";
        const params = new URLSearchParams(qs);
        const senseIn = params.get("sense_id") ?? "";
        const sel = params.get("select") ?? "sense_id,type,pattern,weight";
        const m = senseIn.match(/^in\.\((.*)\)$/);
        const rawList = m?.[1] ?? "";
        const ids = rawList
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean)
          .map((x) => x.replace(/^"|"$/g, ""));

        const { data, error } = await supabaseAuth.from("legal_sense_triggers").select(sel).in("sense_id", ids as any);
        if (error) throw new Error(`legal_sense_triggers select failed: ${error.message}`);
        return (data ?? []) as any;
      }

      throw new Error(`Unsupported supaGet path: ${path}`);
    };

    // ------------------------------
    // Embedding (needed by router microRetrieve)
    // ------------------------------
    const queryEmbedding0 = await createEmbedding(expanded);
    if (!queryEmbedding0) return json({ error: "Échec embedding" }, 500);

    // ------------------------------
    // Sense-Aware Router (polysémie → override expanded)
    // ------------------------------
    try {
      const sense = await senseRouter({
        message,
        course_slug,
        expandedQuery: expanded,
        goal_mode: gmode,
        supaGet,
        createEmbedding,
        microRetrieve: async (query_text, query_embedding) => {
          const r = await hybridSearchWithRetry(supabaseAuth, {
            query_text,
            query_embedding,
            domain: "Inconnu",
            gate,
            jurisdiction_expected,
            goal_mode: "learn",
          });
          return { hits: r.hits ?? [] };
        },
      });

      if (sense?.should_clarify && sense.clarify_question) {
        return json(
          {
            answer: sense.clarify_question,
            sources: [],
            ...(mode !== "prod" ? { usage: { type: "clarify", sense_debug: sense.debug } } : {}),
          },
          200
        );
      }

      if (sense?.expandedQuery_override) expanded = sense.expandedQuery_override;
    } catch (e: any) {
      if (mode !== "prod") console.warn("senseRouter error:", e?.message ?? e);
    }

    // ------------------------------
    // Recompute embedding after router override (important)
    // ------------------------------
    const queryEmbedding = expanded === expandedQuery ? queryEmbedding0 : await createEmbedding(expanded);
    if (!queryEmbedding) return json({ error: "Échec embedding" }, 500);

    // ------------------------------
    // Course kernels retrieval (internal guides, NOT sources)
    // ------------------------------
    let kernelHits: KernelHit[] = [];
    let kernelsWarning: string | null = null;

    const allowKernels = (gmode === "exam" || gmode === "case") && !!course_slug;

    try {
      if (allowKernels && course_slug) {
        kernelHits = await callRpc<KernelHit>(supabaseAuth, "search_course_kernels", {
          query_embedding: queryEmbedding,
          p_course_slug: course_slug,
          match_count: 6,
        });
      }
    } catch (e: any) {
      kernelsWarning = e?.message ? String(e.message) : String(e);
    }

    const kernelContext =
      kernelHits.length > 0
        ? kernelHits
            .map((k, i) => `KERNEL ${i + 1} (topic=${k.topic}; sim=${Number(k.similarity ?? 0).toFixed(3)}):\n${k.content}`)
            .join("\n---\n")
        : "(aucun kernel)";

    const baseKeywords = extractKeywords(expanded, 10);
    const { keywords } = expandQuery(expanded, baseKeywords, jurisdiction_expected, gate.assumptions.union_assumed);
    const article = detectArticleMention(message);

    // ------------------------------
    // Hybrid search (retry)
    // ------------------------------
    let hybridHits: HybridHit[] = [];
    let hybridError: string | null = null;

    {
      const r = await hybridSearchWithRetry(supabaseAuth, {
        query_text: expanded,
        query_embedding: queryEmbedding,
        domain: domain_detected,
        gate,
        jurisdiction_expected,
        goal_mode: gmode,
      });

      hybridHits = r.hits;
      hybridError = r.hybridError;
      if (hybridError) console.warn("hybridSearchWithRetry failed:", hybridError);
    }

    // ------------------------------
// Direct article lookup (priority if user explicitly asks an article number)
// ------------------------------
// ------------------------------
// Direct article lookup (priority if user explicitly asks an article number)
// ------------------------------
if (articleNum) {
  try {
    let codeCandidates: string[] = [];
    if (course_slug && course_slug !== "general") {
      const canon = await getCourseCanonicalCodes(supabaseAuth, course_slug);
      codeCandidates = canon;
    }

    // ✅ 1) Déclare directHits UNE fois, en let
    let directHits = await directArticleLookup({
      supabase: supabaseAuth,
      articleNum,
      codeCandidates,
      jurisdictionNorm: jurisdiction_expected === "UNKNOWN" ? null : jurisdiction_expected,
    });

    // ✅ 2) Fallback: si mapping trop strict, relance sans contraintes
    if (!directHits.length && (codeCandidates?.length ?? 0) > 0) {
      directHits = await directArticleLookup({
        supabase: supabaseAuth,
        articleNum,
        codeCandidates: [],
        jurisdictionNorm: jurisdiction_expected === "UNKNOWN" ? null : jurisdiction_expected,
      });
    }

    // ✅ 3) Merge si hits
    if (directHits.length) {
      hybridHits = [...directHits, ...(hybridHits ?? [])];
    }
  } catch (e: any) {
    console.warn("directArticleLookup error:", e?.message ?? e);
  }
}


    // ------------------------------
    // Strict article lock: if explicit “1457 CCQ/LPC”, avoid “noise” sources
    // ------------------------------
    const explicitRef = detectExplicitArticleRef(message);
    const hasExplicitRef =
      /(art(?:icle)?\.?\s*)?\d{1,6}(?:\.\d+)*\s*(c\.?c\.?q|ccq|c\.c\.q|l\.?p\.?c|lpc)/i.test(message);

    // Note: directArticleLookup kept out here (you had it in your file, but it’s long).
    // If you need it, re-plug it exactly as before.
    // For now: only apply the “noise kill switch” when explicit ref + nothing relevant in hybridHits.
    if (hasExplicitRef && explicitRef && hybridHits.length === 0) {
      hybridHits = [];
    }

    // ------------------------------
    // Course law mapping: restrict sources to required codes (STRICT)
    // ------------------------------
    let _allowedCodeIds: { strict: Set<string>; loose: Set<string> } | null = null;
    let _ingestNeeded: string[] = [];
    try {
      if (course_slug && course_slug !== "general") {
  const canon = await getCourseCanonicalCodes(supabaseAuth, course_slug);
  _allowedCodeIds = await expandAliases(supabaseAuth, canon);
  _ingestNeeded = await getIngestNeededForCourse(supabaseAuth, course_slug);
}
    } catch (e: any) {
      console.warn("course mapping fetch failed:", e?.message ?? e);
    }

    if (_allowedCodeIds && (_allowedCodeIds.strict.size || _allowedCodeIds.loose.size)) {
    hybridHits = (hybridHits ?? []).filter((h) => {
    const vStrict = normCodeIdStrict(h.code_id);
    const vLoose = normCodeIdLoose(h.code_id);
    return _allowedCodeIds!.strict.has(vStrict) || _allowedCodeIds!.loose.has(vLoose);
  });
}

    // ------------------------------
    // Distinctions (internal)
    // ------------------------------
    let distinctions: DistinctionRow[] = [];
    try {
      if (course_slug) distinctions = await fetchTopDistinctions(supabaseAuth, course_slug, 8);
    } catch (e: any) {
      console.warn("distinctions fetch failed:", e?.message ?? e);
    }

    const minPriority = gmode === "learn" ? 90 : 0;
    distinctions = distinctions.filter((d) => (d.priority ?? 0) >= minPriority).slice(0, 6);

    const distinctionsContext =
      distinctions.length
        ? distinctions
            .map((d, i) => {
              const pits = (d.pitfalls ?? []).slice(0, 4).map((x) => `- ${x}`).join("\n");
              const when = (d.when_it_matters ?? []).slice(0, 3).map((x) => `- ${x}`).join("\n");
              return `DISTINCTION ${i + 1}: ${d.concept_a} vs ${d.concept_b} (priority=${d.priority})
Rule: ${d.rule_of_thumb}
When it matters:
${when || "- (none)"}
Pitfalls:
${pits || "- (none)"}`;
            })
            .join("\n---\n")
        : "(aucune distinction)";

    // ------------------------------
    // Pass ordering
    // ------------------------------
    let PASS_ORDER: Jurisdiction[] = ["QC", "CA-FED", "OTHER"];
    if (jurisdiction_expected === "CA-FED") PASS_ORDER = ["CA-FED", "QC", "OTHER"];
    else if (jurisdiction_expected === "OTHER") PASS_ORDER = ["OTHER", "QC", "CA-FED"];
    else if (jurisdiction_expected === "UNKNOWN") PASS_ORDER = ["QC", "CA-FED", "OTHER"];

    const debugPasses: any[] = [];

    type Cand = { row: EnrichedRow; composite: number; overlap: number; passJur: Jurisdiction };

    const seen = new Set<string>();
    const candidates: Cand[] = [];

    const compositeFor = (h: HybridHit): { composite: number; overlap: number } => {
      const sim =
        typeof h.similarity === "number"
          ? h.similarity
          : typeof h.distance === "number"
          ? Math.max(0, 1 - h.distance)
          : null;

      const sc = scoreHit({ row: h, expected: jurisdiction_expected, keywords, article, similarity: sim });

      const rpcScore = typeof h.rrf_score === "number" ? h.rrf_score : typeof h.score === "number" ? h.score : 0;
      const ftsBonus =
        h.from_fts === true ? 0.08 : typeof h.fts_rank === "number" ? Math.min(0.08, Math.max(0, h.fts_rank) * 0.02) : 0;

      const composite = rpcScore * 0.9 + sc.hit_quality_score * 0.25 + (sim ?? 0) * 0.08 + ftsBonus;
      return { composite, overlap: sc.overlap };
    };

    const goodThreshold = 1.25;
    const minGoodHits = 3;

    for (let p = 0; p < PASS_ORDER.length; p++) {
      const passJur = PASS_ORDER[p];
      const local: Cand[] = [];

      for (let i = 0; i < hybridHits.length; i++) {
        const h = hybridHits[i];
        const jur0 = normalizeJurisdiction(h.jurisdiction_norm);
        const norm: Jurisdiction = jur0 === "OTHER" ? "OTHER" : jur0;
        if (norm !== passJur) continue;

        const key = dedupKey(h);
        if (seen.has(key)) continue;

        const { composite, overlap } = compositeFor(h);
        local.push({ row: h, composite, overlap, passJur });
      }

      local.sort((a, b) => b.composite - a.composite);

      const take = passJur === "QC" ? 90 : passJur === "CA-FED" ? 80 : 60;
      let good = 0;

      for (let i = 0; i < local.length && i < take; i++) {
        const it = local[i];
        const k = dedupKey(it.row);
        if (seen.has(k)) continue;
        seen.add(k);
        candidates.push(it);
        if (it.composite >= goodThreshold) good++;
      }

      debugPasses.push({
        passJurisdiction: passJur,
        passCandidates: local.length,
        taken: Math.min(local.length, take),
        goodHits: good,
        hybridHitsTotal: hybridHits.length,
        hybridError,
      });

      if (gate.lock && passJur === jurisdiction_expected && good >= minGoodHits && domain_detected !== "Fiscal" && domain_detected !== "Penal") break;
    }

    const global = [...candidates].sort((a, b) => b.composite - a.composite);

    // ------------------------------
    // First pass selection (raw)
    // ------------------------------
    const rawRows: EnrichedRow[] = [];
    const pickedRaw = new Set<string>();

    for (let i = 0; i < global.length && rawRows.length < Math.max(top_k * 6, 40); i++) {
      const r = global[i].row;
      const k = dedupKey(r);
      if (pickedRaw.has(k)) continue;
      pickedRaw.add(k);
      rawRows.push(r);
    }

    const rawSources: Source[] = rawRows.slice(0, Math.min(rawRows.length, 20)).map((r) => ({
      id: r.id,
      citation: r.citation,
      jur: r.jurisdiction_norm,
      title: r.title,
      url: r.url_struct,
      snippet: null,
    }));

    let jurisdiction_selected_raw = selectJurisdictionFromSources(rawSources, jurisdiction_expected);
    let jurisdiction_selected: Jurisdiction = gate.lock ? jurisdiction_expected : jurisdiction_selected_raw;

    if (domain_detected === "Fiscal") {
      const hasQC = rawSources.some((s) => normalizeJurisdiction(s.jur ?? "") === "QC");
      const hasCA = rawSources.some((s) => normalizeJurisdiction(s.jur ?? "") === "CA-FED");
      if (hasQC && hasCA) jurisdiction_selected = "UNKNOWN";
      else if (!gate.lock && jurisdiction_expected !== "UNKNOWN") jurisdiction_selected = jurisdiction_selected_raw;
      else if (jurisdiction_selected === "UNKNOWN") jurisdiction_selected = "UNKNOWN";
    }

    const scopedRows = rawRows.filter((r) =>
      allowRowByScope({
        row: r,
        domain: domain_detected,
        jurisdiction_expected,
        jurisdiction_selected,
        gate,
      })
    );

    const finalRows: EnrichedRow[] = [];
    const picked = new Set<string>();

    const need = {
      charter: domain_detected === "Penal" && jurisdiction_selected !== "QC",
      crcode: domain_detected === "Penal" && jurisdiction_selected !== "QC",
      clc: domain_detected === "Travail" && jurisdiction_selected === "CA-FED",
    };

    const addsNeed = (r: EnrichedRow) => {
      if (need.charter && isCharterSource(r)) return true;
      if (need.crcode && isCriminalCodeSource(r)) return true;
      if (need.clc && isCanadaLabourCodeSource(r)) return true;
      return false;
    };

    for (let i = 0; i < scopedRows.length && finalRows.length < top_k; i++) {
      const r = scopedRows[i];
      const k = dedupKey(r);
      if (picked.has(k)) continue;
      if (!addsNeed(r)) continue;

      picked.add(k);
      finalRows.push(r);

      if (need.charter && isCharterSource(r)) need.charter = false;
      if (need.crcode && isCriminalCodeSource(r)) need.crcode = false;
      if (need.clc && isCanadaLabourCodeSource(r)) need.clc = false;
    }

    for (let i = 0; i < scopedRows.length && finalRows.length < top_k; i++) {
      const r = scopedRows[i];
      const k = dedupKey(r);
      if (picked.has(k)) continue;
      picked.add(k);
      finalRows.push(r);
    }

    const sources: Source[] = finalRows.map((r) => ({
      id: r.id,
      citation: r.citation,
      title: r.title,
      jur: r.jurisdiction_norm,
      url: r.url_struct,
      snippet: makeExcerpt(`${r.title ?? ""}\n${r.text ?? ""}`, 900),
    }));

    // ------------------------------
    // Relevance / coverage / quality
    // ------------------------------
    const relevance_ok = computeRelevanceOk({
      candidates: global.slice(0, 12).map((x) => ({ row: x.row, composite: x.composite, overlap: x.overlap })),
    });

    const cov = computeCoverage({ domain: domain_detected, message, finalRows, jurisdiction_selected, gate });

    if (Array.isArray(_ingestNeeded) && _ingestNeeded.length) {
      cov.ingest_needed = _ingestNeeded.slice(0, 24);
    }

    const coverage_ok = cov.coverage_ok;

    const rag_quality = computeRagQuality({
      jurisdiction_expected,
      jurisdiction_selected,
      sources,
      relevance_ok,
      coverage_ok,
      domain: domain_detected,
    });

    // ------------------------------
    // No-source / low-relevance => ALWAYS ANSWER (NO parsed usage here)
    // ------------------------------
    if (sources.length === 0 || !relevance_ok) {
      const answer = buildAlwaysAnswerFallback({
        message,
        domain: domain_detected,
        gate,
        hybridError,
        missing_coverage: cov.missing_coverage,
        ingest_needed: cov.ingest_needed,
      });

      try {
        const { error: logError } = await supabaseAuth.from("logs").insert({
          question: message,
          profile_slug: profile ?? null,
          course_slug,
          user_goal,
          institution_name,
          risk_flags,
          top_ids: [],
          response: {
            answer,
            sources: [],
            qa: {
              domain_detected,
              jurisdiction_expected,
              jurisdiction_selected,
              jurisdiction_lock: gate.lock,
              pitfall_keyword: gate.pitfall_keyword ?? null,
              rag_quality: 0,
              relevance_ok: false,
              coverage_ok: false,
              missing_coverage: cov.missing_coverage ?? ["Aucune source pertinente."],
              article_confidence: 0,
              refused_reason: null,
              hybrid_error: hybridError,
            },
          },
          usage: {
            mode,
            top_k,
            latency_ms: Date.now() - startedAt,
            type: "answer",
            goal_mode: gmode,
            kernels_count: kernelHits.length,
            distinctions_count: distinctions.length,
            debugPasses,
          },
        });

        if (logError) console.warn("log insert failed:", logError);
      } catch (e) {
        console.warn("log insert failed:", e);
      }

      return json({
        answer,
        sources: [],
        followups: [
          "Si tu veux, je peux reformuler ta question en version “examen” (checklist + pièges).",
          "Si tu veux, donne-moi un mini-scénario (2–3 phrases) et je l’applique sans inventer d’articles.",
          "Si tu veux, je te dis exactement quoi ingérer pour obtenir une réponse avec citations.",
        ].slice(0, 3),
        ...(mode !== "prod"
          ? {
              usage: {
                type: "answer",
                goal_mode: gmode,
                domain_detected,
                jurisdiction_expected,
                jurisdiction_selected,
                jurisdiction_lock: gate.lock,
                rag_quality,
                relevance_ok,
                coverage_ok,
                hybrid_error: hybridError,
                kernels_count: kernelHits.length,
                distinctions_count: distinctions.length,
              },
            }
          : {}),
      });
    }

    // ------------------------------
    // Warning policy (graduée)
    // ------------------------------
    const serverWarning =
      rag_quality === 3
        ? undefined
        : rag_quality === 2
        ? "Contexte : je réponds prudemment selon les extraits disponibles."
        : "Contexte : je réponds prudemment; certaines citations précises pourraient nécessiter plus de sources.";

    // ------------------------------
    // Build allowlists
    // ------------------------------
    const allowed_source_ids: string[] = sources.map((s) => String(s.id));
    const allowed_citations = Array.from(new Set(sources.map((s) => (s.citation ?? "").trim()).filter(Boolean)));
    const allowedCitationsLower = buildAllowedCitationText(sources);

    const context =
      sources
        .map((s) => `SOURCE id=${s.id}\nCitation: ${s.citation}\nJuridiction: ${s.jur}\nURL: ${s.url ?? ""}\nExtrait:\n${s.snippet ?? ""}`)
        .join("\n---\n") || "(aucun extrait)";

    const cp = courseContext(profileObj);
    const explicitArticleAsked =
      /(art(?:icle)?\.?\s*)?\d{1,6}(?:\.\d+)*\s*(c\.?c\.?q|ccq|c\.c\.q|l\.?p\.?c|lpc)/i.test(message);

    // ------------------------------
    // Model payload
    // ------------------------------
    const userPayload = [
      `Question: ${message}`,
      `Course: ${course_slug}`,
      cp ? `Course context:\n${cp}` : "",
      `Domaine détecté: ${domain_detected}`,
      `Juridiction attendue (heuristique): ${jurisdiction_expected}`,
      `Juridiction sélectionnée (système): ${jurisdiction_selected}`,
      `Juridiction verrouillée (lock): ${gate.lock}`,
      explicitArticleAsked
        ? "- IMPORTANT: l’utilisateur a cité un article précis. Ta réponse doit expliquer l’article en profondeur (paraphrase, éléments à prouver, mini-exemple, erreurs fréquentes, 3 followups)."
        : "",
      kernelsWarning ? `KERNELS_WARNING: ${kernelsWarning}` : "",
      "Course kernels (guides pédagogiques internes; NON des sources de droit; NE PAS les citer):",
      kernelContext,
      "",
      "Concept distinctions (guides internes; NON des sources; NE PAS citer):",
      distinctionsContext,
      "",
      gate.pitfall_keyword ? `Exception/piège détecté: ${gate.pitfall_keyword}` : "",
      `Hypothèse syndicat: union_assumed=${gate.assumptions.union_assumed}`,
      `Signaux QA: relevance_ok=${relevance_ok} ; coverage_ok=${coverage_ok} ; rag_quality=${rag_quality}`,
      hybridError ? `HYBRID_RPC_WARNING: ${hybridError}` : "",
      cov.missing_coverage?.length ? `missing_coverage (pré-calculé):\n- ${cov.missing_coverage.join("\n- ")}` : "missing_coverage (pré-calculé): (aucun)",
      cov.ingest_needed?.length ? `ingest_needed (pré-calculé):\n- ${cov.ingest_needed.join("\n- ")}` : "ingest_needed (pré-calculé): (aucun)",
      "",
      "Contexte (extraits):",
      context,
      "",
      "Allowed citations (tu ne peux mentionner QUE celles-ci, mot pour mot):",
      allowed_citations.length ? allowed_citations.map((c) => `- ${c}`).join("\n") : "(vide)",
      "",
      "Allowed source_ids (tu ne peux utiliser QUE ces IDs):",
      allowed_source_ids.length ? allowed_source_ids.map((id) => `- ${id}`).join("\n") : "(vide)",
      "",
      "INSTRUCTIONS DE SORTIE (JSON strict, uniquement):",
      `{
  "type": "answer" | "clarify" | "refuse",
  "jurisdiction": "QC" | "CA-FED" | "OTHER" | "UNKNOWN",
  "domain": "Civil" | "Travail" | "Sante" | "Penal" | "Fiscal" | "Admin" | "Autre" | "Inconnu",
  "answer_markdown": "...",
  "followups": ["..."],
  "quiz": { "question": "...", "expected_points": ["..."] },
  "ilac": { "probleme": "...", "regle": "...", "application": "...", "conclusion": "..." },
  "source_ids_used": ["..."],
  "partial": false,
  "missing_coverage": ["..."],
  "ingest_needed": ["..."],
  "warning": "...",
  "refusal_reason": "...",
  "clarification_question": "..."
}
RÈGLES:
- source_ids_used doit être un sous-ensemble exact de Allowed source_ids.
- Évite 'clarify' et 'refuse' : si possible, réponds 'answer' + partial=true.`,
    ]
      .filter(Boolean)
      .join("\n\n");

    // ------------------------------
    // Call model
    // ------------------------------
    const runModel = async (extraNudge?: string) => {
      const msgs: Array<{ role: "system" | "user" | "assistant"; content: string }> = [{ role: "system", content: SYSTEM_PROMPT }];
      if (extraNudge) msgs.push({ role: "system", content: extraNudge });
      msgs.push({ role: "user", content: userPayload });
      return await createChatCompletion(msgs);
    };

    const completion1 = await runModel();
    const parsed1 = safeJsonParse<ModelJson>(completion1.content);

    const completion2 =
      parsed1 && (parsed1.type === "refuse" || parsed1.type === "clarify") && sources.length > 0 && relevance_ok
        ? await runModel("IMPORTANT: No-block. Réponds en 'answer' + partial=true si possible, uniquement avec l’allowlist.")
        : null;

    const parsed2 = completion2 ? safeJsonParse<ModelJson>(completion2.content) : null;

    // ✅ Un seul “point d’entrée” vers parsedObj (plus jamais “parsed” dans un autre scope)
    parsedObj = (parsed2 ?? parsed1) ?? { type: "answer", jurisdiction: jurisdiction_selected, domain: domain_detected, partial: true };

    // ------------------------------
    // Server-side normalization (ultimate guardrails)
    // ------------------------------
    parsedObj.domain = domain_detected;
    parsedObj.jurisdiction = jurisdiction_selected;

    if (parsedObj.type === "clarify") {
      parsedObj.type = "answer";
      parsedObj.partial = true;
      parsedObj.warning = (parsedObj.warning ? parsedObj.warning + " " : "") + "No-block: clarification remplacée par hypothèses par défaut.";
    }
    if (parsedObj.type === "refuse") {
      parsedObj.type = "answer";
      parsedObj.partial = true;
      parsedObj.warning = (parsedObj.warning ? parsedObj.warning + " " : "") + "No-block: refus converti en réponse utile.";
    }

    if (!parsedObj.missing_coverage || parsedObj.missing_coverage.length === 0) parsedObj.missing_coverage = cov.missing_coverage ?? [];
    if (!parsedObj.ingest_needed || parsedObj.ingest_needed.length === 0) parsedObj.ingest_needed = cov.ingest_needed ?? [];

    const allow = enforceAllowedSourceIds(parsedObj, allowed_source_ids);
    if (!allow.ok) {
      parsedObj.source_ids_used = allow.kept;
      parsedObj.partial = true;
      parsedObj.warning = (parsedObj.warning ? parsedObj.warning + " " : "") + "Certaines sources hors allowlist ont été retirées.";
    }

    if (!parsedObj.source_ids_used || parsedObj.source_ids_used.length === 0) {
      parsedObj.source_ids_used = bestFallbackSourceIds({ sources, domain: domain_detected, jurisdiction: jurisdiction_selected });
      parsedObj.partial = true;
      parsedObj.warning = (parsedObj.warning ? parsedObj.warning + " " : "") + "Aucune source sélectionnée par le modèle; sélection serveur appliquée.";
    }

    if (!parsedObj.ilac) {
      parsedObj.ilac = buildServerIlacFallback({
        message,
        domain: domain_detected,
        jurisdiction: jurisdiction_selected,
        gate,
        cov: { missing_coverage: parsedObj.missing_coverage ?? [], ingest_needed: parsedObj.ingest_needed ?? [] },
      });
      parsedObj.partial = true;
      parsedObj.warning = (parsedObj.warning ? parsedObj.warning + " " : "") + "ILAC manquant; ILAC serveur appliqué.";
    }

    // redactions anti-hallucination
// redactions anti-hallucination
let redactions: string[] = [];
{
  const p1 = redactUnsupportedRefs(parsedObj.ilac.probleme ?? "", allowedCitationsLower);
  const p2 = redactUnsupportedRefs(parsedObj.ilac.regle ?? "", allowedCitationsLower);
  const p3 = redactUnsupportedRefs(parsedObj.ilac.application ?? "", allowedCitationsLower);
  const p4 = redactUnsupportedRefs(parsedObj.ilac.conclusion ?? "", allowedCitationsLower);

  parsedObj.ilac.probleme = p1.text;
  parsedObj.ilac.regle = p2.text;
  parsedObj.ilac.application = p3.text;
  parsedObj.ilac.conclusion = p4.text;

  redactions = [...p1.redactions, ...p2.redactions, ...p3.redactions, ...p4.redactions];

      if (redactions.length) {
        parsedObj.partial = true;
        parsedObj.missing_coverage = Array.from(
          new Set([...(parsedObj.missing_coverage ?? []), ...redactions.map((x) => `Référence non supportée par l’allowlist: ${x}`)])
        );
        parsedObj.ingest_needed = Array.from(
          new Set([...(parsedObj.ingest_needed ?? []), "Ajouter au corpus la source officielle correspondant aux références manquantes, ou retirer la demande de citation précise."])
        );
        parsedObj.warning = (parsedObj.warning ? parsedObj.warning + " " : "") + "Certaines références non supportées ont été redigées (anti-hallucination).";
      }
    }

// ------------------------------
// Post-processing (anti-hallucination + wrong-regime leak + render)
// ------------------------------

// 1) Si redactions => enrichit missing/ingest + warning
if (redactions.length) {
  parsedObj.partial = true;

  parsedObj.missing_coverage = Array.from(
    new Set([
      ...(parsedObj.missing_coverage ?? []),
      ...redactions.map((x) => `Référence non supportée par l’allowlist: ${x}`),
    ])
  );

  parsedObj.ingest_needed = Array.from(
    new Set([
      ...(parsedObj.ingest_needed ?? []),
      "Ajouter au corpus la source officielle correspondant aux références manquantes, ou retirer la demande de citation précise.",
    ])
  );

  parsedObj.warning =
    (parsedObj.warning ? parsedObj.warning + " " : "") +
    "Certaines références non supportées ont été redigées (anti-hallucination).";
}

// 2) Wrong regime leak (Travail QC vs Fédéral)
const leak =
  hasForbiddenRegimeLeak({
    text: parsedObj.ilac?.probleme ?? "",
    domain: domain_detected,
    jurisdiction: jurisdiction_selected,
  }) ||
  hasForbiddenRegimeLeak({
    text: parsedObj.ilac?.regle ?? "",
    domain: domain_detected,
    jurisdiction: jurisdiction_selected,
  }) ||
  hasForbiddenRegimeLeak({
    text: parsedObj.ilac?.application ?? "",
    domain: domain_detected,
    jurisdiction: jurisdiction_selected,
  }) ||
  hasForbiddenRegimeLeak({
    text: parsedObj.ilac?.conclusion ?? "",
    domain: domain_detected,
    jurisdiction: jurisdiction_selected,
  });

if (leak) {
  parsedObj.partial = true;
  parsedObj.warning =
    (parsedObj.warning ? parsedObj.warning + " " : "") +
    "Incohérence de régime détectée; correction serveur.";

  parsedObj.missing_coverage = Array.from(
    new Set([
      ...(parsedObj.missing_coverage ?? []),
      "Incohérence: le texte mentionnait un régime juridique d’une autre juridiction.",
    ])
  );

  parsedObj.ingest_needed = Array.from(
    new Set([
      ...(parsedObj.ingest_needed ?? []),
      "Ajouter au corpus les textes du régime applicable (dans la juridiction retenue) pour éviter tout recours au mauvais régime.",
    ])
  );

  // ✅ IMPORTANT: pas de shorthand si ton scope a déjà été cassé auparavant;
  // ici, on force les paires clé:valeur (et on protège cov)
  parsedObj.ilac = buildServerIlacFallback({
    message: message,
    domain: domain_detected,
    jurisdiction: jurisdiction_selected,
    gate: gate,
    cov: {
      missing_coverage: parsedObj.missing_coverage ?? cov?.missing_coverage ?? [],
      ingest_needed: parsedObj.ingest_needed ?? cov?.ingest_needed ?? [],
    },
  });
}

// 3) Warning policy (graduée)
if (serverWarning && parsedObj.type === "answer") {
  parsedObj.warning = parsedObj.warning ? `${serverWarning} ${parsedObj.warning}` : serverWarning;
  if (rag_quality <= 2) parsedObj.partial = parsedObj.partial ?? true;
}

// 4) followups safe
followups = Array.isArray(parsedObj.followups)
  ? parsedObj.followups.filter((x) => typeof x === "string" && x.trim()).slice(0, 3)
  : [];

if (followups.length === 0) {
  followups = [
    "Si tu veux, je peux l’appliquer à un mini-cas (2–3 phrases).",
    "Si tu veux, je peux te faire une checklist d’examen + pièges.",
    "Si tu veux, je peux te dire exactement quoi ingérer pour citer précisément.",
  ];
}

// 5) render
let answer = renderAnswer({
  parsed: parsedObj,
  sources: sources,
  distinctions: distinctions ?? [],
  serverWarning: serverWarning,
  examTip: null,
  mode: mode === "prod" ? "prod" : "dev",
});

// ✅ En prod, on masque la section Sources côté client
if (mode === "prod") {
  answer = stripSourcesSectionForUser(answer);
}

const had_qc_source = sources.some((s) => normalizeJurisdiction(s.jur ?? "") === "QC");

return json({
  answer,
  sources,
  followups,
  usage: {
    type: parsedObj.type,
    goal_mode: gmode,
    domain_detected,
    jurisdiction_expected,
    jurisdiction_selected,
    jurisdiction_lock: gate.lock,
    rag_quality,
    relevance_ok,
    coverage_ok,
    had_qc_source,
    missing_coverage: parsedObj.missing_coverage ?? cov.missing_coverage ?? [],
    ingest_needed: parsedObj.ingest_needed ?? cov.ingest_needed ?? [],
    distinctions_count: distinctions.length,
    kernels_count: kernelHits.length,
    hybrid_error: hybridError,
  },
});

} catch (e: any) {
  console.error("chat route error:", e);
  return json({ error: e?.message ?? "Unknown error" }, 500);
}
}
