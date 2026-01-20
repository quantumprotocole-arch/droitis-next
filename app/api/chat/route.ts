/* eslint-disable no-console */
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
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

// RPC hybrid result can include extra scoring fields.
type HybridHit = EnrichedRow & {
  similarity?: number | null; // 0..1
  distance?: number | null;
  fts_rank?: number | null;
  score?: number | null;
  rrf_score?: number | null; // ✅ returned by RPC v2
  from_fts?: boolean | null; // ✅ returned by RPC v2
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
function scoreContext(message: string) {
  const m = message.toLowerCase();

  const civil = [
    "contrat","obligation","clause","nullité","nullite","dol","erreur","violence",
    "inexécution","inexecution","responsabilité","responsabilite","1457","ccq","lpc"
  ];
  const health = ["soin","patient","hôpital","hopital","clsc","médecin","medecin","urgence"];
  const penal = ["code criminel","criminel","accusé","accuse","infraction","procès","proces","arrestation","charte canadienne"];
  const fed = ["irpa","immigration","emploi fédéral","emploi federal","banque","aérien","aerien","télécom","telecom"];

  const count = (arr: string[]) => arr.reduce((n, w) => n + (m.includes(w) ? 1 : 0), 0);

  return {
    civil: count(civil),
    health: count(health),
    penal: count(penal),
    fed: count(fed),
    len: m.trim().split(/\s+/).length
  };
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

// Secteurs fédéraux (travail) + employeurs/organismes fédéraux (admin)
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
    if (hasPenalSignals(message)) return { selected: "CA-FED", reason: "penal_substantive_fed", lock: true };
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
function makeGate(args?: Partial<Gate>): Gate {
  return {
    selected: "UNKNOWN",
    reason: "gate_default",
    lock: false,
    pitfall_keyword: null,
    assumptions: { union_assumed: false, penal_provincial_assumed: false },
    ...(args ?? {}),
  };
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

  if (hasPenalSignals(message) || hasQcProvPenalSignals(message)) return "Penal";
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

  // On s’appuie sur CourseProfile (ingestion pack) plutôt que des ifs fragiles.
  const p: any = getCourseProfile(s);
  const domains: string[] = Array.isArray(p?.B?.domaines) ? p.B.domaines : [];
  const tags = domains.map((x) => String(x).toLowerCase());

  const has = (...keys: string[]) => keys.some((k) => tags.some((t) => t.includes(k)));

  if (has("pénal", "penal", "criminel", "crime", "procédure pénale")) return "Penal";
  if (has("travail", "emploi", "syndicat", "relations de travail")) return "Travail";
  if (has("fiscal", "tax", "impôt", "impot")) return "Fiscal";
  if (has("administratif", "contentieux administratif", "taq", "cai")) return "Admin";
  if (has("santé", "sante", "médical", "medical", "bioéthique")) return "Sante";

  // Civil / obligations / contrats / responsabilité / biens / etc.
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

  // Pas de “blocs debug” visibles: on reste pédagogique + prudent.
  return [
    `Je peux t’aider, mais je n’ai pas retrouvé d’extraits fiables dans le corpus pour appuyer des citations.`,

    domain === "Travail" ? `\n*(Contexte de travail: ${unionTxt}.)*\n` : "",

    `\nVoici une façon sûre d’aborder ta question **sans inventer** :`,
    `- **Clarifier** le fait central (qui, quoi, quand, où, préjudice/dommage, lien, etc.).`,
    `- **Identifier** le régime juridique applicable (QC vs fédéral / civil vs pénal / etc.).`,
    `- **Appliquer** une grille d’analyse (ILAC/IRAC) en laissant les références d’articles en attente tant que le corpus n’est pas disponible.`,

    `\n**Ce que j’ai compris de ta question**\n${message}`,

    `\n**Ce qu’il faut vérifier/ingérer pour citer correctement**\n${missing}`,
    `\n**À ingérer en priorité (si tu veux des articles/citations précises)**\n${ingest}`,

    `\nSi tu me dis : (1) la juridiction visée, (2) le contexte factuel minimal, et (3) le texte/loi que ton cours utilise, je peux reformuler un plan de réponse et les points à rechercher.`
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
async function expandAnswerIfTooShort(args: {
  mode: string;
  explicitArticleAsked: boolean;
  answer: string;
  minChars: number;
  userPayloadText: string;
  allowed_citations: string[];
  allowed_source_ids: string[];
  openaiCall: (payload: { system: string; user: string }) => Promise<string>; // adapte à ton wrapper
}): Promise<string> {
  if (args.mode !== "prod") return args.answer;
  if (!args.explicitArticleAsked) return args.answer;
  if ((args.answer ?? "").trim().length >= args.minChars) return args.answer;

  // Prompt de réécriture: même sources, même contraintes
  const rewriteUser = [
    "Tu dois RÉÉCRIRE la réponse en version longue, pédagogique, et spécifique à l’article demandé.",
    "Contraintes:",
    "- Interdit d’inventer une règle, exception, nuance, ou référence non présente dans les extraits.",
    "- Tu dois paraphraser l’extrait fourni dans 'Contexte (extraits)'.",
    "- Tu ne cites que via source_ids_allowed / citations autorisées.",
    "",
    "Structure obligatoire (remplie avec contenu, pas des consignes):",
    "1) Idée centrale (paraphrase de l’extrait)",
    "2) Ce qu’il faut prouver (liste claire)",
    "3) Mini-exemple guidé (faits → application → conclusion)",
    "4) Pièges fréquents (2–4 points)",
    "5) 3 questions de suivi",
    "",
    "=== CONTEXTE COMPLET ===",
    args.userPayloadText,
  ].join("\n");

  const rewritten = await args.openaiCall({
    system: "Réécriture pédagogique. Respecte STRICTEMENT les citations autorisées.",
    user: rewriteUser,
  });

  return rewritten?.trim() ? rewritten.trim() : args.answer;
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
// Supabase REST (service role)
// ------------------------------
// ------------------------------
// Supabase access (RLS via user session)
// ------------------------------
// NOTE: We use createClient() (anon key + user cookies). No service_role.
// All DB reads/writes must pass RLS policies.
// ------------------------------

// ------------------------------
// Hybrid RPC search (FTS + vector) — RPC ONLY
// ------------------------------
// ------------------------------
// Hybrid RPC search (FTS + vector) — RPC ONLY (RLS)
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
  } catch (e: any) {
    // fallback v1 (older RPC)
    return await callRpc<HybridHit>(supabase, "search_legal_vectors_hybrid_v1", payload);
  }
}

/**
 * ✅ Wrapper anti-timeout.
 */
async function hybridSearchWithRetry(supabase: ReturnType<typeof createClient>, args: {
  query_text: string;
  query_embedding: number[];
  domain: Domain;
  gate: Gate;
  jurisdiction_expected: Jurisdiction;
  goal_mode: "exam" | "case" | "learn";
}): Promise<{ hits: HybridHit[]; hybridError: string | null }> {
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
      filter_bucket: null, // ✅ IMPORTANT : ne pas confondre bucket et juridiction
});

      return { hits, hybridError: null };
    } catch (e: any) {
      lastErr = e?.message ?? String(e);
      if (!isStatementTimeout(lastErr)) break;
    }
  }

  return { hits: [], hybridError: lastErr };
}
function hasStrongFedOverride(message: string): boolean {
  // “Signaux forts” = mentions explicites ou faits imposant le fédéral.
  // (Tu peux enrichir cette liste, mais elle doit rester stricte.)
  return (
    hasFedLegalSignals(message) ||
    hasFedAdminAgencySignals(message) ||
    hasFedPublicEmployerSignals(message) ||
    hasFedWorkSectorSignals(message).matched ||
    /\b(code criminel|criminal code|irpa|immigration and refugee protection)\b/i.test(message)
  );
}

function hasStrongPenalOverride(message: string): boolean {
  // Évite de basculer “Penal” pour des mots faibles (“sanction”, “amende”).
  return /\b(code criminel|criminal code|mens rea|actus reus|accusation|infraction|procureur|dpcp)\b/i.test(message);
}

function courseJurisdictionLock(profileObj: any, course_slug: string): Jurisdiction | null {
  const j = String(profileObj?.B?.juridiction_principale ?? "").toUpperCase().trim();
  if (j === "QC") return "QC";
  if (j === "CA-FED" || j === "FED") return "CA-FED";
  if (j === "OTHER") return "OTHER";
  return null;
}

// ------------------------------
// ------------------------------
// Mapping helpers (course laws) — RLS safe (no service_role)
// ------------------------------
function normCodeId(codeId: string | null | undefined): string {
  return String(codeId ?? "").trim().toLowerCase();
}

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

async function expandAliases(
  supabase: ReturnType<typeof createClient>,
  canonicalCodes: string[]
): Promise<Set<string>> {
  const out = new Set<string>();
  for (const c of canonicalCodes) out.add(normCodeId(c));

  if (!canonicalCodes.length) return out;

  // optional table: code_aliases(canonical_code text, aliases text[])
  const { data, error } = await supabase
    .from("code_aliases")
    .select("canonical_code,aliases")
    .in("canonical_code", canonicalCodes);

  if (error) {
    // fail-open on aliases only (keep canon)
    return out;
  }

  for (const row of data ?? []) {
    const c = (row as any).canonical_code;
    if (typeof c === "string" && c.trim()) out.add(normCodeId(c));
    const aliases = (row as any).aliases;
    if (Array.isArray(aliases)) {
      for (const a of aliases) {
        if (typeof a === "string" && a.trim()) out.add(normCodeId(a));
      }
    }
  }

  return out;
}

async function getIngestNeededForCourse(
  supabase: ReturnType<typeof createClient>,
  course_slug: string
): Promise<string[]> {
  // returns a short list of laws/ids that are required/recommended but not ingested (best-effort)
  const { data, error } = await supabase
    .from("course_law_requirements")
    .select("law_key,canonical_code_id,status")
    .eq("course_slug", course_slug);

  if (error) return [];

  const needed = new Set<string>();
  for (const r of data ?? []) {
    const status = String((r as any).status ?? "").toLowerCase().trim();
    if (status && status !== "ingested") {
      const c = (r as any).canonical_code_id;
      const k = (r as any).law_key;
      const v = (typeof c === "string" && c.trim()) ? c.trim() : (typeof k === "string" && k.trim() ? k.trim() : null);
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
// Prompt + output checks
// ------------------------------
const SYSTEM_PROMPT = `
Tu es Droitis, tuteur IA spécialisé en droit québécois ET canadien (QC/CA-FED) selon la juridiction applicable.
Structure implicite (problème → règle → application → conclusion) ; sous-titres seulement si ça aide.

INTERDICTIONS
- Interdiction absolue : inventer une loi, un article, une décision, une citation, ou un lien.
- Tu ne cites QUE ce qui est présent dans sources[] et dans l’allowlist fournie.
- Si une information n’est pas disponible dans les sources : tu dois le dire et expliquer quoi ingérer.

RÈGLES DE JURIDICTION
- Tu annonces la juridiction applicable avant d’énoncer la règle.
- Si la juridiction est verrouillée (lock=true), tu NE DOIS PAS appliquer un autre régime.
- Si les extraits disponibles ne couvrent pas la juridiction verrouillée, tu réponds quand même (orientation prudente) et tu proposes d’ingérer le bon texte si nécessaire.

HYPOTHÈSES PAR DÉFAUT (si non mentionné)
1) Travail : travailleur NON syndiqué.
2) Juridiction : appliquer la juridiction majoritaire du domaine, sauf signal explicite ou exception typique.
3) Tu indiques explicitement dans l’Application quand tu relies ton raisonnement à une hypothèse par défaut.

RÈGLES DE STYLE (réponse visible):
- En production, la réponse doit être conversationnelle, pédagogique et fluide.
- Ne pas afficher: “Juridiction applicable…”, “Contexte partiel…”, ni des blocs ILAC répétitifs.
- Utilise 1–2 sous-titres max, paragraphes courts.
- Adapte au user_goal:
  - comprendre: explication + analogie + mini-exemple guidé + mini-quiz (1 question).
  - examen: checklist + pièges + “si tu vois X → fais Y”.
  - reformuler: reformulation + correction des ambiguïtés + version corrigée.
- Ajoute followups: 3 propositions max (“Si tu veux, je peux…”).
- Les sources: cite uniquement via source_ids_used; n’invente jamais.

EXIGENCE DE PROFONDEUR:
  - Si la question vise un article précis et qu'au moins 1 source existe: tu dois EXPLIQUER le contenu concret de l'article (paraphrase) + détailler les critères + illustrer.
  - Interdit de répondre par une seule phrase de synthèse.
  - answer_markdown doit contenir au minimum: "Idée centrale", "Ce qu’il faut prouver", "Mini-exemple", "Pièges fréquents".


PHASE 4B — RÉPONSE GRADUÉE
- Le refus total doit être rare.
- Si les sources sont limitées mais pertinentes : réponds quand même prudemment, et liste missing_coverage[] + ingest_needed[] si utile.
- Ne “complète” jamais avec du plausible.
`.trim();

type ModelJson = {
  type: "answer" | "clarify" | "refuse";
  jurisdiction: Jurisdiction;
  domain?: Domain;
  ilac?: { probleme: string; regle: string; application: string; conclusion: string };

  // ✅ Phase 4D “conversationnelle”
  answer_markdown?: string;      // réponse finale “naturelle”
  followups?: string[];          // 3 suggestions max
  quiz?: { question: string; expected_points?: string[] }; // mini-quiz

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

function redactUnsupportedRefs(text: string, allowedCitationsLower: string): { text: string; redactions: string[] } {
  let out = text ?? "";
  const redactions: string[] = [];

  const artRe = /\b(?:art\.?|article)\s*([0-9]{1,5})\b/gi;
  out = out.replace(artRe, (m) => {
    const ml = m.toLowerCase();
    if (allowedCitationsLower.includes(ml)) return m;
    redactions.push(m);
    return "article [non supporté par le corpus]";
  });

  const caseRe = /\b(19\d{2}|20\d{2})\s*(CSC|SCC|QCCA|QCCS|QCCQ|BCCA|ONCA|FCA|CAF)\s*([0-9]{1,6})\b/gi;
  out = out.replace(caseRe, (m) => {
    const ml = m.toLowerCase();
    if (allowedCitationsLower.includes(ml)) return m;
    redactions.push(m);
    return "[décision non supportée par le corpus]";
  });

  return { text: out, redactions };
}

// ------------------------------
// Minimal “server ILAC” fallback
// ------------------------------
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
// Format answer (ModelJson actuel)
// ------------------------------
// ------------------------------
// Format answer (ModelJson actuel)
// ------------------------------
function ensureMinLength(answer: string, args: { message: string; gmode?: string }) {
  const gmode = args.gmode ?? "comprendre";
  const min = gmode === "comprendre" ? 1200 : gmode === "examen" ? 900 : 700; // caractères

  const base = (answer ?? "").trim();
  if (base.length >= min) return base;

  // Expansion déterministe (pas de nouveau retrieval, pas de nouvelles citations)
  // Objectif: rendre la réponse réellement pédagogique même avec 1 seule source.
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
    "3) Conclus : responsabilité probable ou non, et pourquoi.",
    "",
    "### Pièges fréquents",
    "- Confondre **dommage** (conséquence) et **faute** (comportement).",
    "- Oublier le **lien causal** (même s’il y a faute + dommage).",
    "- Rester vague : il faut des faits concrets pour appliquer la règle.",
    "",
    "### Pour aller plus loin (3 questions)",
    "- Quels faits précis peux-tu donner (chronologie, acteurs, dommages) pour appliquer l’article à TON cas ?",
    "- Est-ce une situation plutôt **contractuelle** ou **extra-contractuelle** (ou mixte) ?",
    "- Quel type de dommage (matériel, corporel, moral) est allégué et comment il est démontré ?",
  ].join("\n");
}

function buildUserPayloadText(userPayload: string[] | string): string {
  if (typeof userPayload === "string") return userPayload;
  return userPayload.reduce((acc, v) => {
    const s = typeof v === "string" ? v.trim() : "";
    return s ? (acc ? acc + "\n" + s : s) : acc;
  }, "");
}

function renderAnswer(args: {
  parsed: ModelJson;
  sources: Source[];
  distinctions: DistinctionRow[];
  serverWarning?: string;
  examTip?: string;
  mode: "prod" | "dev";
}): string {
  const { parsed, sources, serverWarning, examTip, mode } = args;

  // PROD: réponse conversationnelle uniquement (pas de “debug blocks”)
  if (mode === "prod") {
    const body = (parsed.answer_markdown ?? "").trim();
    const followups = Array.isArray(parsed.followups) ? parsed.followups.filter(Boolean).slice(0, 3) : [];
    const sourcesLines = (parsed.source_ids_used ?? [])
      .map((id) => sources.find((s) => String(s.id) === String(id))?.citation)
      .filter(Boolean)
      .map((c) => `- ${c}`)
      .join("\n");

    return [
      body || (parsed.ilac ? `${parsed.ilac.conclusion}` : "Je te réponds au mieux avec le corpus actuel."),
      followups.length ? `\n\n**Si tu veux, je peux :**\n${followups.map((f) => `- ${f}`).join("\n")}` : "",
      sourcesLines ? `\n\n**Sources (corpus)**\n${sourcesLines}` : "",
    ]
      .filter(Boolean)
      .join("");
  }

  // DEV: conserve des blocs structurés utiles pour QA (mais sans inventer)
  const missingBlock =
    Array.isArray(parsed.missing_coverage) && parsed.missing_coverage.length
      ? `**Couverture manquante**\n\n${parsed.missing_coverage.map((x) => `- ${x}`).join("\n")}`
      : "";

  const ingestBlock =
    Array.isArray(parsed.ingest_needed) && parsed.ingest_needed.length
      ? `**À ingérer pour répondre avec certitude**\n${parsed.ingest_needed.map((x) => `- ${x}`).join("\n")}`
      : "";

  const partialBlock = ""; // volontaire: pas de “réponse partielle” visible

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
      "*(Structure ILAC indisponible dans la réponse modèle.)*",
      examTip ? `\n**Conseil examen**\n${examTip}` : "",
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
      const tail = [id ? `id:${id}` : null, url ? url : null].filter((x): x is string => Boolean(x)).join(" — ");
      return `- ${cit}${jur ? ` — (${jur})` : ""}${tail ? " — " + tail : ""}`;
    })
    .filter((x): x is string => Boolean(x))
    .join("\n");

  const warn = serverWarning || parsed.warning ? `⚠️ ${serverWarning || parsed.warning}` : "";

  return [
    warn,
    partialBlock,
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

function buildExamTip(args: {
  message: string;
  goal_mode: "exam" | "case" | "learn";
  parsed: ModelJson;
  sources: Source[];
  distinctions: DistinctionRow[];
}): string {
  const bullets: string[] = [];

  const usedIds = (args.parsed.source_ids_used ?? []).map((x) => String(x));
  const usedSources = usedIds.map((id) => args.sources.find((s) => String(s.id) === id)).filter((s): s is Source => Boolean(s));

  const citations = usedSources
    .map((s) => (s.citation ?? "").trim())
    .filter((c): c is string => Boolean(c));

  const articleLike = citations.filter((c) => /^art\./i.test(c) || c.toLowerCase().includes("article"));
  const picked = (articleLike.length ? articleLike : citations).slice(0, 2);

  if (picked.length) {
    bullets.push(`- **À citer / mobiliser** : ${picked.map((c) => `« ${c} »`).join(" ; ")}`);
  }

  const d = args.distinctions?.[0] ?? null;
  if (d) {
    const thumb = makeExcerpt(d.rule_of_thumb ?? "", 160);
    bullets.push(`- **Distinction utile** : ${d.concept_a} vs ${d.concept_b} — ${thumb}`);

    const pit = (d.pitfalls ?? []).filter((p): p is string => Boolean(p))[0];
    if (pit) bullets.push(`- **Piège classique** : ${makeExcerpt(pit, 160)}`);
  }

  if (!bullets.length) {
    if (args.goal_mode === "case") {
      bullets.push("- **Méthode** : applique ILAC (problème → règle → application → conclusion) et justifie chaque qualification par un indice factuel.");
    } else {
      bullets.push("- **Méthode** : fais une mini-fiche (définition + conditions + exceptions + 1 exemple) et garde 1 phrase de conclusion testable en examen.");
    }
  }

  return bullets.slice(0, 3).join("\n");
}

// ------------------------------
// “Wrong-regime” detector
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
    if (domain === "Penal" && cit.includes("procedure penale")) sc += 1;
    if (domain === "Fiscal" && (cit.includes("impôt") || cit.includes("impot") || cit.includes("tax"))) sc += 1;

    if (/^art\./i.test((s.citation ?? "").trim())) sc += 0.5;
    if (domain === "Penal" && (cit.includes("faillite") || cit.includes("insolv"))) sc -= 2;

    return sc;
  };

  const ranked = [...sources].sort((a, b) => score(b) - score(a));
  return ranked.slice(0, Math.min(2, ranked.length)).map((x) => x.id);
}
// ✅ TOP-LEVEL helpers (pas dans POST)

const extractArticleNum = (citation?: string | null): string | null => {
  if (!citation) return null;
  const m =
    citation.match(/\b(?:art(?:icle)?\.?\s*)?(\d{1,6}(?:\.\d+)*)\b/i) ||
    citation.match(/\b(\d{3,5}(?:\.\d+)*)\b/);
  return m ? m[1] : null;
};

const toHybridHitFromCodeChunk = (row: any): HybridHit => {
  const jur = String(row?.jur ?? "UNKNOWN").toUpperCase();
  const citation = (row?.citation ?? null) as string | null;
  const text = (row?.content ?? row?.text ?? null) as string | null;
  const codeIdRaw = row?.code_id ?? null;

  const enriched: any = {
    title: citation ?? row?.title ?? "Référence (corpus)",
    text: text ?? "",
    code_id_struct: row?.code_id_struct ?? { raw: codeIdRaw },
    article_num: row?.article_num ?? extractArticleNum(citation),
    url_struct: row?.url_struct ?? null,
  };

  const hybrid: any = {
    id: row.id,
    citation,
    code_id: codeIdRaw,
    jurisdiction_norm: jur,
    content: text,
    snippet: text ? String(text).slice(0, 520) : null,
    rrf_score: 0,
    score: 0,
    from_fts: false,
    fts_rank: 0,
    similarity: null,
    distance: null,
  };

  return { ...enriched, ...hybrid } as HybridHit;
};

const directArticleLookup = async (
  message: string,
  supabase: ReturnType<typeof createClient>
) => {
  // ex: "1457 C.c.Q.", "art. 1457 CCQ", "article 58 LPC"
  const re =
    /(art(?:icle)?\.?\s*)?(\d{1,6}(?:\.\d+)*)\s*(c\.?c\.?q|ccq|c\.c\.q|l\.?p\.?c|lpc)/i;
  const match = message.match(re);
  if (!match) return [];

  const art = match[2];
  const raw = match[3].toLowerCase();

  const codeCandidates = raw.includes("lpc")
    ? ["L.P.C.", "LPC", "L.p.c.", "l.p.c."]
    : ["C.c.Q.", "CCQ", "C.C.Q.", "c.c.q."];

  // 1) Prefer legal_vectors (same corpus as hybrid search)
  try {
    const like = `%${art}%`;

    const { data, error } = await supabase
      .from("legal_vectors")
      .select("id,code_id,jurisdiction,jurisdiction_bucket,citation,title,text")
      .in("code_id", codeCandidates as any)
      // IMPORTANT: pas de article_num (n’existe pas chez toi)
      .or(`citation.ilike.${like},text.ilike.${like}`)
      .limit(12);

    if (!error && Array.isArray(data) && data.length) {
      return data.map((row: any) =>
        toHybridHitFromCodeChunk({
          ...row,
          // toHybridHitFromCodeChunk attend des champs type "jur" + "content"
          jur: row?.jurisdiction ?? row?.jurisdiction_bucket ?? "UNKNOWN",
          content: row?.text ?? null,
        })
      );
    }
  } catch {
    // ignore and fallback to legacy table
  }

  // 2) Legacy fallback: code_chunks (if still present)
  try {
    const legacyCode = raw.includes("lpc") ? "LPC" : "CCQ";
    const { data, error } = await supabase
      .from("code_chunks")
      .select("id,citation,content,code_id,jur")
      .eq("code_id", legacyCode)
      .ilike("citation", `%${art}%`)
      .limit(8);

    if (!error && Array.isArray(data) && data.length) return data.map(toHybridHitFromCodeChunk);
  } catch {
    // ignore
  }

  return [];
};



function detectExplicitArticleRef(message: string): { code_id: string; article: string } | null {
  const re = /(art(?:icle)?\.?\s*)?(\d{1,6}(?:\.\d+)*)\s*(c\.?c\.?q|ccq|c\.c\.q|l\.?p\.?c|lpc)/i;
  const m = message.match(re);
  if (!m) return null;

  const article = m[2];
  const raw = m[3].toLowerCase();
  const code_id = raw.includes("lpc") ? "L.P.C." : "C.c.Q.";
  return { code_id, article };
}



// ------------------------------
// POST
// ------------------------------
export async function POST(req: Request) {
  const supabaseAuth = createClient();
  const {
    data: { user },
  } = await supabaseAuth.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: CORS_HEADERS });
  }

  const startedAt = Date.now();

  try {
    if (!OPENAI_API_KEY) return json({ error: "OPENAI_API_KEY manquant" }, 500);
    const body = (await req.json().catch(() => ({}))) as ChatRequest;

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

    const course_slug_raw = (body?.course_slug ?? '').trim();
    const course_slug =
    typeof body.course_slug === "string" && body.course_slug.trim()
      ? body.course_slug.trim()
      : "general";

    const user_goal = typeof body.user_goal === "string" && body.user_goal.trim() ? body.user_goal.trim() : null;
    const institution_name = typeof body.institution_name === "string" && body.institution_name.trim() ? body.institution_name.trim() : null;

    const risk_flags: Record<string, any> = {};
    if (!course_slug) risk_flags.missing_course_slug = true;

    const profile = body.profile ?? null;
    const top_k = clamp(body.top_k ?? 7, 5, 8);
    const mode = (body.mode ?? "prod").toLowerCase();

    const intent = inferIntent({ message, user_goal });
    const profileObj = getCourseProfile(course_slug) ?? getCourseProfile("general");
    const { expanded: expandedQuery } = expandQueryWithProfile(message, profileObj);
    const gmode = intent.goal_mode;
    let expanded = expandedQuery;
    const wants_exam_tip = intent.wants_exam_tip;
// ------------------------------
// Supabase mini-GET helper (RLS, used by senseRouter only)
// ------------------------------
const supaGet = async <T,>(path: string): Promise<T> => {
  // Supported endpoints (restricted on purpose):
  // - /rest/v1/legal_senses?... (term eq)
  // - /rest/v1/legal_sense_triggers?... (sense_id in)
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
      .map((x) => x.replace(/^"|"$/g, "")); // unquote if any

    const { data, error } = await supabaseAuth
      .from("legal_sense_triggers")
      .select(sel)
      .in("sense_id", ids as any);

    if (error) throw new Error(`legal_sense_triggers select failed: ${error.message}`);
    return (data ?? []) as any;
  }

  throw new Error(`Unsupported supaGet path: ${path}`);
};


// ------------------------------
// Sense-Aware Router (polysémie → override domain/jurisdiction/expanded)
// ------------------------------
let sense: Awaited<ReturnType<typeof senseRouter>> | null = null;

try {
  sense = await senseRouter({
  message,
  course_slug,
  expandedQuery: expanded,
  goal_mode: gmode,
  supaGet,                // ✅ PAS de wrapper custom
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
    // IMPORTANT: en prod tu peux renvoyer "answer" = question de clarification
    // ou un type "clarify" si ton front le gère.
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
  // fail-open: on continue sans router
  if (mode !== "prod") console.warn("senseRouter error:", e?.message ?? e);
}

    // ------------------------------
    // Domain + Jurisdiction
    // ------------------------------
    let domain_detected = detectDomain(message);

    const forcedDomain = domainByCourseSlug(course_slug);
    const lockedJur = courseJurisdictionLock(profileObj, course_slug);

// 🔒 Domaine verrouillé si cours QC civil, sauf signaux forts
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

// 🔒 Juridiction verrouillée par cours (QC civil), sauf signaux forts explicites
let gate = jurisdictionGateNoBlock(message, domain_detected);
if (
  course_slug !== "general" &&
  lockedJur === "QC" &&
  !gate.lock &&                                // pas de signal explicite déjà locké
  !hasStrongFedOverride(message)
) {
  gate = { ...gate, selected: "QC", lock: true, reason: "course_lock_qc" };
}

const jurisdiction_expected = gate.selected;


    // ------------------------------
    // Embedding + hybrid retrieval
    // ------------------------------
    const queryEmbedding = await createEmbedding(expanded);
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
        query_text: expanded,              // ✅ FIX
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

  // --- Reference lock (article explicite) ---
// Si l’utilisateur demande explicitement "1457 C.c.Q." / "58 L.P.C." :
// - si on trouve l’article : on répond UNIQUEMENT avec ces sources
// - si on ne le trouve pas : on force sources=[] (pas de bruit genre "Loi sur les impôts")
const detectExplicitArticleRef = (msg: string): { code: "CCQ" | "LPC"; article: string } | null => {
  const re = /(art(?:icle)?\.?\s*)?(\d{1,6}(?:\.\d+)*)\s*(c\.?c\.?q|ccq|c\.c\.q|l\.?p\.?c|lpc)/i;
  const m = msg.match(re);
  if (!m) return null;
  const article = m[2];
  const raw = (m[3] || "").toLowerCase();
  const code = raw.includes("lpc") ? "LPC" : "CCQ";
  return { code, article };
};

const explicitRef = detectExplicitArticleRef(message);
const hasExplicitRef = /(art(?:icle)?\.?\s*)?\d{1,6}(?:\.\d+)*\s*(c\.?c\.?q|ccq|c\.c\.q|l\.?p\.?c|lpc)/i.test(
  message
);

const directRows = await directArticleLookup(message, supabaseAuth);

if (hasExplicitRef) {
  if (directRows.length) {
    // ✅ article explicitement demandé et trouvé => on verrouille sur lui
    hybridHits = directRows;
  } else {
    // ✅ article explicitement demandé mais absent => aucune source (pas de bruit fiscal)
    hybridHits = [];
  }
} else if (directRows.length) {
  // pas de ref explicite => on enrichit comme avant
  hybridHits = [...directRows, ...(hybridHits ?? [])];
}






    // ------------------------------
    // Course law mapping: restrict sources to required codes (fallback if empty)
    // ------------------------------
    let _allowedCodeIds: Set<string> | null = null;
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
if (_allowedCodeIds && _allowedCodeIds.size) {
  const filtered = (hybridHits ?? []).filter((h) => _allowedCodeIds!.has(normCodeId(h.code_id)));
  hybridHits = filtered; // strict only (no fallback)
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

    let article_confidence = 0;
    const scanN = Math.min(finalRows.length, 6);
    for (let i = 0; i < scanN; i++) {
      const sc = scoreHit({ row: finalRows[i], expected: jurisdiction_expected, keywords, article, similarity: null });
      if (sc.article_conf > article_confidence) article_confidence = sc.article_conf;
    }

    const had_qc_source = sources.some((s) => normalizeJurisdiction(s.jur ?? "") === "QC");

    // ------------------------------
    // No-source / low-relevance => ALWAYS ANSWER
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


// ✅ Toujours renvoyer les sources + followups au client (prod/dev)
//    En prod: on masque seulement les diagnostics internes.
// ✅ Toujours renvoyer les sources + followups au client (prod/dev)
//    En prod: on masque seulement les diagnostics internes.
//    NB: Ici (no-source/low-relevance), on n’a pas de `parsed` (pas d’appel modèle).
const followups = [
  "Si tu veux, je peux te poser 3 questions pour préciser les faits et conclure plus solidement.",
  "Si tu veux, je peux te proposer un plan ILAC/IRAC à remplir avec tes faits (sans citations inventées).",
  "Si tu veux, je peux t’indiquer exactement quels textes/lois ingérer pour obtenir une réponse avec citations.",
];

const basePayload = {
  type: "answer" as const,
  answer,
  sources,
  followups,
};

const clientPayload =
  mode === "prod"
    ? basePayload
    : {
        ...basePayload,
        usage: {
          type: "answer",
          goal_mode: gmode,
          domain_detected,
          jurisdiction_expected,
          jurisdiction_selected,
          jurisdiction_lock: gate.lock,
          rag_quality: 0,
          relevance_ok: false,
          coverage_ok: false,
          partial: true,
          hybrid_error: hybridError,
          kernels_count: kernelHits.length,
          distinctions_count: distinctions.length,
        },
        missing_coverage: cov?.missing_coverage ?? [],
        ingest_needed: cov?.ingest_needed ?? [],
        source_ids_used: [],
      };

return json(clientPayload);



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
      `Domaine détecté: ${domain_detected}`,
      `Juridiction attendue (heuristique): ${jurisdiction_expected}`,
      `Juridiction sélectionnée (système): ${jurisdiction_selected}`,
      `Juridiction verrouillée (lock): ${gate.lock}`,
      explicitArticleAsked
  ? "- IMPORTANT: l’utilisateur a cité un article précis. Ta réponse doit expliquer l’article en profondeur: (1) paraphrase simple, (2) éléments/conditions à prouver, (3) mini-exemple guidé, (4) erreurs fréquentes, (5) 3 questions de suivi."
  : "",
      explicitArticleAsked
  ? "- Ton answer_markdown doit faire au moins ~8–12 paragraphes courts (pas une seule phrase)."
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
      "EXIGENCES:",
      "- Réponds en ILAC/IRAC très structurée.",
      "- Respecte STRICTEMENT la juridiction sélectionnée (surtout si lock=true).",
      "- Réponse graduée: si sources limitées, continue et remplis missing_coverage[] + ingest_needed[] (si utile).",
      "- Ne mentionne aucun article/arrêt/lien/test précis hors allowlist.",
      "- No-block: si un fait manque, applique l’hypothèse commune et mentionne-la.",
      
      kernelHits.length ? "- Priorité: si des course kernels sont fournis, utilise-les comme structure (plan/étapes/pièges) et adapte aux faits." : "",
      kernelHits.length ? "- OBLIGATION: commence l'Application par un mini 'Plan d'examen' en 3–6 puces (basé kernels)." : "",
      distinctions.length ? "- Si une distinction pertinente est fournie, intègre explicitement 1–2 pitfalls dans l'Application." : "",
      
      "",
      
      "INSTRUCTIONS DE SORTIE (JSON strict, uniquement):",
      `{
  "type": "answer" | "clarify" | "refuse",
  "jurisdiction": "QC" | "CA-FED" | "OTHER" | "UNKNOWN",
  "domain": "Civil" | "Travail" | "Sante" | "Penal" | "Fiscal" | "Admin" | "Autre" | "Inconnu",
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

    let completion = await runModel();
    let parsed = safeJsonParse<ModelJson>(completion.content);

    if (parsed && (parsed.type === "refuse" || parsed.type === "clarify") && sources.length > 0 && relevance_ok) {
      completion = await runModel("IMPORTANT: No-block. Réponds en 'answer' + partial=true si possible, uniquement avec l’allowlist.");
      parsed = safeJsonParse<ModelJson>(completion.content) ?? parsed;
    }

    if (!parsed) {
      const answer = buildAlwaysAnswerFallback({
        message,
        domain: domain_detected,
        gate,
        hybridError,
        missing_coverage: cov.missing_coverage,
        ingest_needed: cov.ingest_needed,
      });
// ✅ Followups fallback (parsed existe ici, pas ailleurs)
let followups =
  Array.isArray(parsed?.followups) ? parsed.followups.filter(Boolean).slice(0, 3) : [];

if (!followups.length) {
  followups = [
    "Si tu veux, je peux l’appliquer à un mini-cas que tu inventes (2–3 phrases).",
    "Si tu veux, je peux te faire une checklist d’examen (faute / dommage / causalité) + pièges.",
    "Si tu veux, je peux te poser 3 questions pour préciser les faits et conclure plus solidement.",
  ];
}

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

      // ✅ Payload robuste (prod/dev) — sources + followups toujours renvoyés.
//    En prod: on masque seulement les diagnostics internes.
const basePayload = {
  type: (parsed?.type ?? "answer"),
  answer,
  sources,
  followups,
  ...(parsed?.quiz ? { quiz: parsed.quiz } : {}),
};

const clientPayload =
  mode === "prod"
    ? basePayload
    : {
        ...basePayload,
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
          partial: Boolean(parsed?.partial),
          hybrid_error: hybridError,
          kernels_count: kernelHits.length,
          distinctions_count: distinctions.length,
        },
        missing_coverage: parsed?.missing_coverage ?? cov?.missing_coverage ?? [],
        ingest_needed: parsed?.ingest_needed ?? cov?.ingest_needed ?? [],
        source_ids_used: parsed?.source_ids_used ?? [],
      };

return json(clientPayload);
    }

    // ------------------------------
    // Server-side normalization (ultimate guardrails)
    // ------------------------------
    parsed.domain = domain_detected;
    parsed.jurisdiction = jurisdiction_selected;

    if (parsed.type === "clarify") {
      parsed.type = "answer";
      parsed.partial = true;
      parsed.warning = (parsed.warning ? parsed.warning + " " : "") + "No-block: clarification remplacée par hypothèses par défaut.";
    }
    if (parsed.type === "refuse") {
      parsed.type = "answer";
      parsed.partial = true;
      parsed.warning = (parsed.warning ? parsed.warning + " " : "") + "No-block: refus converti en réponse utile.";
    }

    if (!parsed.missing_coverage || parsed.missing_coverage.length === 0) parsed.missing_coverage = cov.missing_coverage ?? [];
    if (!parsed.ingest_needed || parsed.ingest_needed.length === 0) parsed.ingest_needed = cov.ingest_needed ?? [];

    const allow = enforceAllowedSourceIds(parsed, allowed_source_ids);
    let bad_source_ids: string[] = [];
    if (!allow.ok) {
      bad_source_ids = allow.bad;
      parsed.source_ids_used = allow.kept;
      parsed.partial = true;
      parsed.warning = (parsed.warning ? parsed.warning + " " : "") + "Certaines sources hors allowlist ont été retirées.";
    }

    if (!parsed.source_ids_used || parsed.source_ids_used.length === 0) {
      parsed.source_ids_used = bestFallbackSourceIds({ sources, domain: domain_detected, jurisdiction: jurisdiction_selected });
      parsed.partial = true;
      parsed.warning = (parsed.warning ? parsed.warning + " " : "") + "Aucune source sélectionnée par le modèle; sélection serveur appliquée.";
    }

    if (!parsed.ilac) {
      parsed.ilac = buildServerIlacFallback({
        message,
        domain: domain_detected,
        jurisdiction: jurisdiction_selected,
        gate,
        cov: { missing_coverage: parsed.missing_coverage ?? [], ingest_needed: parsed.ingest_needed ?? [] },
      });
      parsed.partial = true;
      parsed.warning = (parsed.warning ? parsed.warning + " " : "") + "ILAC manquant; ILAC serveur appliqué.";
    }

    let redactions: string[] = [];
    {
      const p1 = redactUnsupportedRefs(parsed.ilac.probleme ?? "", allowedCitationsLower);
      const p2 = redactUnsupportedRefs(parsed.ilac.regle ?? "", allowedCitationsLower);
      const p3 = redactUnsupportedRefs(parsed.ilac.application ?? "", allowedCitationsLower);
      const p4 = redactUnsupportedRefs(parsed.ilac.conclusion ?? "", allowedCitationsLower);
      parsed.ilac.probleme = p1.text;
      parsed.ilac.regle = p2.text;
      parsed.ilac.application = p3.text;
      parsed.ilac.conclusion = p4.text;
      redactions = [...p1.redactions, ...p2.redactions, ...p3.redactions, ...p4.redactions];

      if (redactions.length) {
        parsed.partial = true;
        parsed.missing_coverage = Array.from(new Set([...(parsed.missing_coverage ?? []), ...redactions.map((x) => `Référence non supportée par l’allowlist: ${x}`)]));
        parsed.ingest_needed = Array.from(
          new Set([...(parsed.ingest_needed ?? []), "Ajouter au corpus la source officielle correspondant aux références manquantes, ou retirer la demande de citation précise."])
        );
        parsed.warning = (parsed.warning ? parsed.warning + " " : "") + "Certaines références non supportées ont été redigées (anti-hallucination).";
      }
    }

    const leak =
      hasForbiddenRegimeLeak({ text: parsed.ilac.probleme, domain: domain_detected, jurisdiction: jurisdiction_selected }) ||
      hasForbiddenRegimeLeak({ text: parsed.ilac.regle, domain: domain_detected, jurisdiction: jurisdiction_selected }) ||
      hasForbiddenRegimeLeak({ text: parsed.ilac.application, domain: domain_detected, jurisdiction: jurisdiction_selected }) ||
      hasForbiddenRegimeLeak({ text: parsed.ilac.conclusion, domain: domain_detected, jurisdiction: jurisdiction_selected });

    if (leak) {
      parsed.partial = true;
      parsed.warning = (parsed.warning ? parsed.warning + " " : "") + "Incohérence de régime détectée; correction serveur.";
      parsed.missing_coverage = Array.from(new Set([...(parsed.missing_coverage ?? []), "Incohérence: le texte mentionnait un régime juridique d’une autre juridiction."]));
      parsed.ingest_needed = Array.from(new Set([...(parsed.ingest_needed ?? []), "Ajouter au corpus les textes du régime applicable (dans la juridiction retenue) pour éviter tout recours au mauvais régime."]));
      parsed.ilac = buildServerIlacFallback({
        message,
        domain: domain_detected,
        jurisdiction: jurisdiction_selected,
        gate,
        cov: { missing_coverage: parsed.missing_coverage ?? [], ingest_needed: parsed.ingest_needed ?? [] },
      });
    }

    if (serverWarning && parsed.type === "answer") {
      parsed.warning = parsed.warning ? `${serverWarning} ${parsed.warning}` : serverWarning;
      if (rag_quality <= 2) parsed.partial = parsed.partial ?? true;
    }

    const examTip = wants_exam_tip && parsed.type === "answer" ? buildExamTip({ message, goal_mode: gmode, parsed, sources, distinctions }) : null;

  let answer = renderAnswer({
    parsed,
    sources,
    distinctions: distinctions ?? [],
    serverWarning,
    examTip,
    mode: mode === "prod" ? "prod" : "dev",
});
// ✅ Force une réponse plus longue en prod (sans inventer de sources)
if (mode === "prod") {
  answer = ensureMinLength(answer, { message, gmode });
}

const userPayloadText = buildUserPayloadText(userPayload);



answer = await expandAnswerIfTooShort({
  mode,
  explicitArticleAsked,
  answer,
  minChars: 1200,
  userPayloadText,
  allowed_citations,
  allowed_source_ids,
  openaiCall: async ({ system, user }) => {
    // TODO: remplace par TON appel OpenAI existant
    // ex: return await callModelRaw({ system, user })
    const { content } = await createChatCompletion([
  { role: "system", content: system },
  { role: "user", content: user },
]);
return content;

  },
});




    // ------------------------------
    // Logging QA
    // ------------------------------
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

   const followups = Array.isArray(parsed.followups) ? parsed.followups.slice(0, 3) : [];

if (mode === "prod") {
  return json({ answer, sources, followups });
}

return json({
  answer,
  sources,
  followups,
  usage: {
    type: parsed.type,
    goal_mode: gmode,
    domain_detected,
    jurisdiction_expected,
    jurisdiction_selected,
    jurisdiction_lock: gate.lock,
    rag_quality,
    relevance_ok,
    coverage_ok,
    had_qc_source,
    article_confidence,
    missing_coverage: parsed.missing_coverage ?? cov.missing_coverage ?? [],
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
