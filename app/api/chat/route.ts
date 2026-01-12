/* eslint-disable no-console */
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";


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
  distance?: number | null; // optional legacy
  fts_rank?: number | null; // optional legacy
  score?: number | null; // optional legacy
  rrf_score?: number | null; // ✅ returned by your RPC
  from_fts?: boolean | null; // ✅ returned by your RPC
  bucket?: string | null; // optional legacy
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
const { OPENAI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;

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

// ------------------------------
// Jurisdiction + domain signals (no-block, majority unless exception)
// ------------------------------
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

  // ⚠️ IMPORTANT: pas de "travail" ni "emploi" (trop génériques; "travailleur autonome" ≠ domaine Travail)
  // On garde des signaux de LITIGE/RELATION DE TRAVAIL.
  const workStrong = [
    "congédi", "congedi",
    "licenci", "mise à pied", "mise a pied",
    "renvoi", "cessation d'emploi", "cessation d’emploi", "fin d'emploi", "fin d’emploi",
    "harcèlement", "harcelement",
    "disciplin", "suspension",
    "grief", "syndic", "convention collective",
    "préavis", "preavis",
    "indemnité", "indemnite",
    "normes du travail",
    "employeur", "employé", "employe",
    "contrat de travail",
  ];

  return containsAny(s, workStrong);
}


// Hypothèse par défaut: si non mentionné => NON syndiqué
const UNION_KEYWORDS = ["syndiqué", "syndique", "syndicat", "grief", "convention collective", "accréditation", "accreditation"];
function hasUnionSignals(q: string): boolean {
  const s = q.toLowerCase();
  return containsAny(s, UNION_KEYWORDS);
}

// Secteurs fédéraux (travail) + employeurs/organismes fédéraux (admin)
const FED_WORK_SECTOR_KEYWORDS = [
  // banques
  "banque",
  "banques",
  "authorized foreign bank",
  "banque étrangère",
  "banque etrangere",

  // télécom / radiodiffusion
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

  // transport interprovincial / international
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

  // poste
  "poste canada",
  "canada post",
  "postal",
  "courrier",
  "messagerie",
  "courier",

  // nucléaire/uranium (fédéral)
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
  // logique “majoritaire” au Québec :
  // - civil/santé/admin => QC
  // - pénal “substantif” => CA-FED (sauf signaux pénal provincial)
  // - fiscal => mixte => UNKNOWN (laisser le retrieval récupérer QC + CA-FED)
  if (domain === "Penal") return "CA-FED";
  if (domain === "Fiscal") return "UNKNOWN";
  return "QC";
}

type Gate = {
  selected: Jurisdiction;
  reason: string;
  lock: boolean; // ✅ si true, on ne change PAS la juridiction même si les sources dominantes sont ailleurs
  pitfall_keyword?: string | null;
  assumptions: {
    union_assumed: boolean; // false si non mentionné
    penal_provincial_assumed: boolean;
  };
};

function detectJurisdictionExpected(message: string, domain: Domain): { selected: Jurisdiction; reason: string; lock: boolean; pitfall_keyword?: string | null } {
  // 1) signaux explicites (prioritaires, lock)
  if (hasQcLegalSignals(message)) return { selected: "QC", reason: "explicit_qc_signal", lock: true };
  if (hasFedLegalSignals(message)) return { selected: "CA-FED", reason: "explicit_fed_signal", lock: true };

  // 2) OTHER géographique explicite (lock)
  const s = message.toLowerCase();
  const otherSignals = ["ontario", "alberta", "colombie-britannique", "british columbia", "france", "europe", "usa", "états-unis", "etats-unis"];
  if (containsAny(s, otherSignals)) return { selected: "OTHER", reason: "explicit_other_geo", lock: true };

  // 3) par domaine + exceptions fréquentes
  if (domain === "Penal") {
    // pénal provincial (CSR, tickets municipaux, etc.) => QC (lock)
    if (hasQcProvPenalSignals(message)) return { selected: "QC", reason: "penal_provincial_qc", lock: true };
    // criminel “substantif” => CA-FED (lock)
    if (hasPenalSignals(message)) return { selected: "CA-FED", reason: "penal_substantive_fed", lock: true };
    return { selected: defaultJurisdictionByDomain(domain), reason: "penal_default_majority", lock: false };
  }

  if (domain === "Travail") {
    // défaut QC, sauf secteurs fédéraux / employeur fédéral (lock)
    const fedSector = hasFedWorkSectorSignals(message);
    if (fedSector.matched) return { selected: "CA-FED", reason: "work_federal_sector_exception", lock: true, pitfall_keyword: fedSector.keyword ?? null };
    if (hasFedPublicEmployerSignals(message)) return { selected: "CA-FED", reason: "work_federal_public_employer", lock: true };
    return { selected: "QC", reason: "work_default_qc_majority", lock: false };
  }

  if (domain === "Admin") {
    // défaut QC, sauf organisme/tribunal fédéral explicitement (lock)
    if (hasFedAdminAgencySignals(message)) return { selected: "CA-FED", reason: "admin_federal_agency_exception", lock: true };
    return { selected: "QC", reason: "admin_default_qc_majority", lock: false };
  }

  if (domain === "Fiscal") {
    // fiscalité = 2 régimes; si signal clair, lock; sinon UNKNOWN
    if (containsAny(s, ["revenu québec", "revenu quebec", "tvq"])) return { selected: "QC", reason: "fiscal_qc_signal", lock: true };
    if (containsAny(s, ["arc", "cra", "agence du revenu du canada", "tps", "gst"])) return { selected: "CA-FED", reason: "fiscal_fed_signal", lock: true };
    return { selected: "UNKNOWN", reason: "fiscal_mixed_default", lock: false };
  }

  if (domain === "Sante") return { selected: "QC", reason: "health_default_qc_majority", lock: false };
  if (domain === "Civil") return { selected: "QC", reason: "civil_default_qc_majority", lock: false };

  // 4) défaut majoritaire
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
      union_assumed: hasUnionSignals(message), // si absent => false (non syndiqué)
      penal_provincial_assumed: domain === "Penal" ? hasQcProvPenalSignals(message) : false,
    },
  };
}

// ------------------------------
// Domain detection (heuristique)
// ------------------------------
function detectDomain(message: string): Domain {
  const s = message.toLowerCase();

  // 1) Pénal (inclut pénal provincial)
  if (hasPenalSignals(message) || hasQcProvPenalSignals(message)) return "Penal";

  // 2) Santé
  if (hasHealthSignals(message)) return "Sante";

  // 3) Fiscal (AVANT Travail)
  const fiscal = [
    "revenu québec", "revenu quebec", "agence du revenu",
    "cotisation", "objection", "appel fiscal",
    "tps", "tvq", "gst", "hst",
    "impôt", "impot", "taxe", "déduction", "deduction",
    "déclar", "declar", "revenu", "revenus", "factur", "facturation"
  ];

  // Bonus : "travailleur autonome" est très souvent une question FISCALE,
  // même si l’utilisateur n’a pas écrit "impôt/taxes" explicitement.
  if (
    s.includes("travailleur autonome") ||
    (s.includes("autonome") && containsAny(s, ["revenu", "revenus", "déclar", "declar", "taxe", "tps", "tvq", "impôt", "impot", "factur"]))
  ) {
    return "Fiscal";
  }

  if (containsAny(s, fiscal)) return "Fiscal";

  // 4) Travail (litige/relations de travail)
  if (hasWorkSignals(message)) return "Travail";

  // 5) Admin
  const admin = ["taq", "cai", "commission d'accès", "commission d’acces", "contrôle judiciaire", "controle judiciaire", "tribunal administratif", "permis", "zonage"];
  if (containsAny(s, admin)) return "Admin";

  // 6) Civil
  const civil = ["responsabilité", "responsabilite", "faute", "préjudice", "prejudice", "dommage", "contrat", "obligation", "bail", "vice caché", "vice cache", "prescription"];
  if (containsAny(s, civil)) return "Civil";

  return "Inconnu";
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

  if (has("responsabilité civile") || (has("responsabilite") && has("civile")) || has("faute") || has("préjudice") || has("prejudice") || has("dommage") || has("causal")) {
    add("faute");
    add("préjudice");
    add("prejudice");
    add("dommage");
    add("causalité");
    add("causalite");
    add("lien");
    add("réparation");
    add("reparation");

    if (expected === "QC" || expected === "UNKNOWN") {
      pinnedArticleNums.push("1457", "1458", "1459");
    }
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

    // ✅ par défaut: non syndiqué (si rien n’est mentionné)
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
// Jurisdiction scope & filtering (CRUCIAL: prevent wrong-regime answers)
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

  // UNKNOWN => open (but we still try to prioritize expected in ranking)
  if (jurisdiction_selected === "UNKNOWN") {
    // in practice, still exclude OTHER unless expected OTHER
    if (rowJur === "OTHER" && gate.selected !== "OTHER") return false;
    return true;
  }

  // Fiscal => allow both QC and CA-FED (by nature). Exclude OTHER by default.
  if (domain === "Fiscal") {
    if (rowJur === "QC" || rowJur === "CA-FED") return true;
    return false;
  }

  // Penal QC (tickets CSR/municipal): allow QC + (Charter sources) because it can apply to provincial prosecutions.
  if (domain === "Penal" && jurisdiction_selected === "QC") {
    if (rowJur === "QC") return true;
    if (rowJur === "CA-FED" && isCharterSource(row)) return true;
    return false;
  }

  // Otherwise strict: only the selected jurisdiction.
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
    // When locked, say explicitly we cannot safely import the wrong regime.
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

    // If penal CA-FED => want Criminal Code + (Charter if relevant / or evidence exclusion signal)
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
      // Penal QC (ticket/CSR): want Code de procédure pénale / CSR / règlement municipal (selon la question)
      // (On ne peut pas deviner les articles exacts si non dans le corpus)
      ok = finalRows.length >= 1;
    }
  }

  if (domain === "Travail") {
    const work = hasWorkSignals(message);
    const hasCLC = finalRows.some(isCanadaLabourCodeSource);
    if (work && jurisdiction_selected === "CA-FED") {
      ok = hasCLC;
      if (!hasCLC) {
        missing.push("Régime fédéral du travail : extraits pertinents absents (ex. textes sur congédiement/recours/délais).");
        ingest.push("Ajouter au corpus le texte fédéral applicable au travail (ex. Code canadien du travail : parties sur congédiement/recours, selon le cas).");
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

  // For fiscal mixed, tolerate mixed selection.
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
  const { message, domain, gate, hybridError } = args;
  const warn = hybridError ? `⚠️ HYBRID_RPC_WARNING: ${hybridError}\n\n` : "";

  const unionTxt = gate.assumptions.union_assumed ? "syndiqué (signal détecté)" : "NON syndiqué (hypothèse par défaut: aucun signal)";
  const jurTxt = gate.selected;

  const missing = (args.missing_coverage ?? []).length ? (args.missing_coverage ?? []).map((x) => `- ${x}`).join("\n") : "- Aucune source pertinente (ou aucune source dans la juridiction applicable).";
  const ingest = (args.ingest_needed ?? []).length
    ? (args.ingest_needed ?? []).map((x) => `- ${x}`).join("\n")
    : [
        "- Texte officiel de la loi/règlement pertinent (QC ou CA selon la situation)",
        "- Articles précis visés (si connus)",
        "- Toute politique/contrat/convention collective si applicable (sinon hypothèse par défaut: non syndiqué)",
      ].join("\n");

  return (
    `${warn}` +
    `**Juridiction applicable (heuristique/exception) : ${jurTxt}**\n` +
    `**Domaine : ${domain}**\n\n` +
    `⚠️ Réponse partielle : je ne peux pas appliquer un autre régime juridique “par défaut” si la juridiction est verrouillée par une exception (ex. secteur fédéral).\n\n` +
    `**Hypothèses par défaut utilisées**\n- Travail : ${unionTxt}\n\n` +
    `**Problème**\n${message}\n\n` +
    `**Règle**\nInformation non disponible dans le corpus actuel (ou sources insuffisantes dans la juridiction applicable).\n\n` +
    `**Application**\nSans extraits du régime applicable, je ne peux pas conclure au fond sans inventer.\n\n` +
    `**Conclusion**\nImpossible de trancher au fond avec certitude à partir du corpus actuel.\n\n` +
    `**Couverture manquante (missing_coverage)**\n${missing}\n\n` +
    `**À ingérer pour compléter (ingest_needed)**\n${ingest}\n`
  );
}

// ------------------------------
// OpenAI — embeddings + chat
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
// Supabase REST (service role)
// ------------------------------
async function supaPost(path: string, body: any) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY manquant");
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "count=none",
    },
    body: JSON.stringify(body),
  });
  return res;
}

// ------------------------------
// Hybrid RPC search (FTS + vector) — RPC ONLY
// ------------------------------
async function callRpc<T>(rpcName: string, body: any): Promise<T[]> {
  const rpcRes = await supaPost(`/rest/v1/rpc/${rpcName}`, body);
  if (!rpcRes.ok) {
    const t = await rpcRes.text().catch(() => "");
    throw new Error(`RPC ${rpcName} failed: ${rpcRes.status} ${t}`);
  }
  return ((await rpcRes.json()) ?? []) as T[];
}

async function hybridSearchRPC(args: {
  query_text: string;
  query_embedding: number[];
  match_count: number;
  filter_jurisdiction_norm: string | null;
  filter_bucket: string | null;
}): Promise<HybridHit[]> {
  const payload = {
    query_embedding: args.query_embedding,
    query_text: args.query_text,
    match_count: args.match_count,
    filter_jurisdiction_norm: args.filter_jurisdiction_norm,
    filter_bucket: args.filter_bucket,
  };

  try {
    return await callRpc<HybridHit>("search_legal_vectors_hybrid_v2", payload);
  } catch {
    return await callRpc<HybridHit>("search_legal_vectors_hybrid_v1", payload);
  }
}
async function fetchTopDistinctions(course_slug: string, limit = 8): Promise<DistinctionRow[]> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/concept_distinctions?select=id,course_slug,concept_a,concept_b,rule_of_thumb,pitfalls,when_it_matters,priority&course_slug=eq.${encodeURIComponent(
      course_slug
    )}&order=priority.desc&limit=${limit}`,
    {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY!,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY!}`,
      },
    }
  );

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`fetchTopDistinctions failed: ${res.status} ${t}`);
  }
  return (await res.json()) as DistinctionRow[];
}

// ------------------------------
// Prompt + output checks — "verrouillé" + no-hallucination + no-block
// ------------------------------
const SYSTEM_PROMPT = `
Tu es Droitis, tuteur IA spécialisé en droit québécois ET canadien (QC/CA-FED) selon la juridiction applicable.
Tu réponds en ILAC/IRAC : Problème → Règle → Application → Conclusion.

INTERDICTIONS
- Interdiction absolue : inventer une loi, un article, une décision, une citation, ou un lien.
- Tu ne cites QUE ce qui est présent dans sources[] et dans l’allowlist fournie.
- Si une information n’est pas disponible dans les sources : tu dois le dire et expliquer quoi ingérer.

RÈGLES DE JURIDICTION
- Tu annonces la juridiction applicable avant d’énoncer la règle.
- Si la juridiction est verrouillée (lock=true), tu NE DOIS PAS appliquer un autre régime (ex: CNESST/TAT si CA-FED).
- Si les extraits disponibles ne couvrent pas la juridiction verrouillée, tu réponds PARTIELLEMENT et tu demandes d’ingérer le bon texte.

HYPOTHÈSES PAR DÉFAUT (si non mentionné)
1) Travail : travailleur NON syndiqué.
2) Juridiction : appliquer la juridiction majoritaire du domaine, sauf signal explicite ou exception typique
   (ex. banques/télécom/transport interprovincial => fédéral en droit du travail; criminel => fédéral; ticket CSR/municipal => QC).
3) Tu indiques explicitement dans l’Application quand tu relies ton raisonnement à une hypothèse par défaut.

PHASE 4B — RÉPONSE GRADUÉE (IMPORTANT)
- Le refus total doit être rare.
- Si les sources sont partielles mais pertinentes : réponds quand même prudemment (partial=true),
  et liste précisément missing_coverage[] + ingest_needed[].
- Ne “complète” jamais avec du plausible.
`.trim();

type ModelJson = {
  type: "answer" | "clarify" | "refuse";
  jurisdiction: Jurisdiction;
  domain?: Domain;

  ilac?: { probleme: string; regle: string; application: string; conclusion: string };

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

    // Normalisation: si la citation contient un numéro d'article, ajouter variantes
    const m = c.match(/\b(?:art\.?|article)\s*([0-9]{1,5})\b/i);
    if (m?.[1]) {
      const n = m[1];
      add(`art. ${n}`);
      add(`art ${n}`);
      add(`article ${n}`);
    }
  }

  // string "flat" pour includes()
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
// Minimal “server ILAC” (only when needed to prevent wrong-regime drift)
// ------------------------------
function buildServerIlacFallback(args: {
  message: string;
  domain: Domain;
  jurisdiction: Jurisdiction;
  gate: Gate;
  cov: { missing_coverage: string[]; ingest_needed: string[] };
}): NonNullable<ModelJson["ilac"]> {
  const { message, domain, jurisdiction, gate } = args;

  const unionTxt = gate.assumptions.union_assumed
    ? "syndiqué (signal détecté)"
    : "non syndiqué (hypothèse par défaut, aucun signal)";

  const assumptions =
    domain === "Travail"
      ? `Hypothèse travail: ${unionTxt}.`
      : "Hypothèses: faits non précisés → hypothèses communes appliquées.";

  return {
    probleme: message,
    regle:
      "Je me limite strictement aux extraits disponibles dans le corpus. " +
      "Si le corpus ne contient pas les textes applicables à la juridiction retenue, l’information juridique de fond n’est pas disponible ici.",
    application:
      `${assumptions} ` +
      "Comme les extraits nécessaires au régime applicable ne sont pas présents (ou insuffisants), je ne peux pas appliquer une règle de fond sans risquer d’inventer ou d’importer un mauvais régime.",
    conclusion:
      `Réponse partielle. Pour compléter, il faut ingérer les textes du régime ${jurisdiction} pertinents (voir ingest_needed).`,
  };
}


// ------------------------------
// Format answer
// ------------------------------
function formatAnswerFromModel(parsed: ModelJson, sources: Source[], serverWarning?: string): string {
  if (parsed.type === "clarify") {
    return parsed.clarification_question ?? "Je réponds par défaut selon les hypothèses communes; indique des précisions si tu veux raffiner.";
  }

  if (parsed.type === "refuse") {
    const ingest = (parsed.ingest_needed ?? []).map((x) => `- ${x}`).join("\n");
    const missing = (parsed.missing_coverage ?? []).map((x) => `- ${x}`).join("\n");
    return [
      parsed.refusal_reason ?? "Je ne peux pas répondre de façon fiable avec le corpus actuel.",
      "",
      missing ? `**Couverture manquante**\n${missing}\n` : "",
      `**Information non disponible dans le corpus actuel. Pour répondre avec certitude, il faut ingérer :**\n${ingest || "- [préciser la loi / l’article / la juridiction à ingérer]."}`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  const ilac = parsed.ilac!;
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
  const partial = parsed.partial ? `\n\n⚠️ Réponse partielle : certaines sous-questions ne sont pas couvertes par les extraits.\n` : "";

  const missing = (parsed.missing_coverage ?? []).length
    ? `\n\n**Couverture manquante (missing_coverage)**\n${(parsed.missing_coverage ?? []).map((x) => `- ${x}`).join("\n")}\n`
    : "";

  const ingest = (parsed.ingest_needed ?? []).length
    ? `\n\n**À ingérer pour compléter (ingest_needed)**\n${(parsed.ingest_needed ?? []).map((x) => `- ${x}`).join("\n")}\n`
    : "";

  return [
    `**Juridiction applicable (selon le système) : ${parsed.jurisdiction}**`,
    parsed.domain ? `**Domaine : ${parsed.domain}**` : "",
    warn,
    partial,
    `**Problème**\n${ilac.probleme}`,
    `\n**Règle**\n${ilac.regle}`,
    `\n**Application**\n${ilac.application}`,
    `\n**Conclusion**\n${ilac.conclusion}`,
    missing,
    ingest,
    `\n**Sources citées (allowlist uniquement)**\n${citedLines || "- (aucune)"}\n`,
  ]
    .filter(Boolean)
    .join("\n");
}

// ------------------------------
// “Wrong-regime” detector (server guardrail)
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
// Source picking improvement (when model picks none)
// ------------------------------
function bestFallbackSourceIds(args: { sources: Source[]; domain: Domain; jurisdiction: Jurisdiction }): Array<string | number> {
  const { sources, domain, jurisdiction } = args;
  if (!sources.length) return [];

  const score = (s: Source) => {
    const jur0 = normalizeJurisdiction(s.jur ?? "");
    const jur: Jurisdiction = jur0 === "OTHER" ? "OTHER" : jur0;

    let sc = 0;
    if (jurisdiction !== "UNKNOWN" && jur === jurisdiction) sc += 2;
    if (domain === "Penal" && ((s.citation ?? "").toLowerCase().includes("procédure pénale") || (s.citation ?? "").toLowerCase().includes("procédure penale"))) sc += 1;
    if (domain === "Travail" && ((s.citation ?? "").toLowerCase().includes("travail") || (s.citation ?? "").toLowerCase().includes("normes"))) sc += 1;
    if (domain === "Fiscal" && ((s.citation ?? "").toLowerCase().includes("impôt") || (s.citation ?? "").toLowerCase().includes("impot") || (s.citation ?? "").toLowerCase().includes("tax"))) sc += 1;

    // Prefer “art.” over random
    if (/^art\./i.test((s.citation ?? "").trim())) sc += 0.5;

    // Penal: prefer CPP / CSR rather than unrelated (like insolvency)
    if (domain === "Penal" && ((s.citation ?? "").toLowerCase().includes("faillite") || (s.citation ?? "").toLowerCase().includes("insolv"))) sc -= 2;

    return sc;
  };

  const ranked = [...sources].sort((a, b) => score(b) - score(a));
  return ranked.slice(0, Math.min(2, ranked.length)).map((x) => x.id);
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
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return json({ error: "SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY manquant" }, 500);

    const body = (await req.json().catch(() => ({}))) as ChatRequest;

    let message = (typeof body.message === "string" && body.message.trim()) || (typeof body.question === "string" && body.question.trim()) || "";

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
const course_slug =
  typeof body.course_slug === "string" && body.course_slug.trim() ? body.course_slug.trim() : null;

const user_goal =
  typeof body.user_goal === "string" && body.user_goal.trim() ? body.user_goal.trim() : null;

const institution_name =
  typeof body.institution_name === "string" && body.institution_name.trim()
    ? body.institution_name.trim()
    : null;

const risk_flags: Record<string, any> = {};
if (!course_slug) risk_flags.missing_course_slug = true;
if (!user_goal) risk_flags.missing_user_goal = true;

    const profile = body.profile ?? null;
    const top_k = clamp(body.top_k ?? 7, 5, 8);
    const mode = (body.mode ?? "prod").toLowerCase();
if (!course_slug || !user_goal) {
  const clarify =
    "Pour que je réponde selon ton cours : quel est ton **course_slug** (ou le nom du cours) et ton **objectif** (examen / comprendre / cas-pratique) ?";

  await supaPost("/rest/v1/logs", {
    question: message,
    profile_slug: profile ?? null,
    // Phase 4D
    course_slug,
    user_goal,
    institution_name,
    risk_flags,
    top_ids: [],
    response: {
      answer: clarify,
      sources: [],
      qa: {
        refused_reason: "clarify_missing_course_or_goal",
        missing_coverage: ["course_slug ou user_goal manquant"],
      },
    },
    usage: { mode, top_k, latency_ms: Date.now() - startedAt, type: "clarify", kernels_count: 0 },
    user_id: user.id,
  }).catch((e) => console.warn("log insert failed:", e));

  return json({
    answer: clarify,
    sources: [],
    usage: {
      type: "clarify",
      missing: { course_slug: !course_slug, user_goal: !user_goal },
    },
  });
}

    // ------------------------------
    // Domain + Jurisdiction (NO-BLOCK)
    // ------------------------------
    const domain_detected = detectDomain(message);
    const gate = jurisdictionGateNoBlock(message, domain_detected);
    const jurisdiction_expected = gate.selected;

    // ------------------------------
    // Embedding + hybrid retrieval (RPC ONLY — 1 call, no filter to allow mixed where needed)
    // ------------------------------
    const queryEmbedding = await createEmbedding(message);
    if (!queryEmbedding) return json({ error: "Échec embedding" }, 500);

    // ------------------------------
// Course kernels retrieval (Phase 4D — internal guides, NOT sources)
// ------------------------------
let kernelHits: KernelHit[] = [];
let kernelsWarning: string | null = null;

try {
  kernelHits = await callRpc<KernelHit>("search_course_kernels", {
    query_embedding: queryEmbedding,
    p_course_slug: course_slug as string,
    match_count: 6,
  });
} catch (e: any) {
  kernelsWarning = e?.message ? String(e.message) : String(e);
}

const kernelContext =
  kernelHits.length > 0
    ? kernelHits
        .map(
          (k, i) =>
            `KERNEL ${i + 1} (topic=${k.topic}; sim=${Number(k.similarity ?? 0).toFixed(3)}):\n${k.content}`
        )
        .join("\n---\n")
    : "(aucun kernel)";

    const baseKeywords = extractKeywords(message, 10);
    const { keywords } = expandQuery(message, baseKeywords, jurisdiction_expected, gate.assumptions.union_assumed);
    const article = detectArticleMention(message);

    const poolSize = 220;
    let hybridHits: HybridHit[] = [];
    let hybridError: string | null = null;

    try {
      hybridHits = await hybridSearchRPC({
        query_text: message,
        query_embedding: queryEmbedding,
        match_count: poolSize,
        filter_jurisdiction_norm: null,
        filter_bucket: null,
      });
    } catch (e: any) {
      hybridError = e?.message ?? String(e);
      console.warn("hybridSearchRPC failed:", hybridError);
      hybridHits = [];
    }
    let distinctions: DistinctionRow[] = [];
try {
  distinctions = await fetchTopDistinctions(course_slug as string, 8);
} catch (e: any) {
  console.warn("distinctions fetch failed:", e?.message ?? e);
}
const distinctionsContext =
  distinctions.length
    ? distinctions
        .map((d, i) => {
          const pits = (d.pitfalls ?? []).slice(0, 4).map((x) => `- ${x}`).join("\n");
          return `DISTINCTION ${i + 1}: ${d.concept_a} vs ${d.concept_b} (priority=${d.priority})\nRule: ${d.rule_of_thumb}\nPitfalls:\n${pits || "- (none)"}`;
        })
        .join("\n---\n")
    : "(aucune distinction)";

    // ------------------------------
    // Pass ordering prioritizes expected, but still explores
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
      const ftsBonus = h.from_fts === true ? 0.08 : typeof h.fts_rank === "number" ? Math.min(0.08, Math.max(0, h.fts_rank) * 0.02) : 0;

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

      // optimisation: si lock et assez de bons hits dans la juridiction attendue, on stop (sauf fiscal/pénal)
      if (gate.lock && passJur === jurisdiction_expected && good >= minGoodHits && domain_detected !== "Fiscal" && domain_detected !== "Penal") break;
    }

    // ------------------------------
    // Global candidate sort
    // ------------------------------
    const global = [...candidates].sort((a, b) => b.composite - a.composite);

    // ------------------------------
    // First pass selection (raw) — then strict scope filter (prevents wrong-regime citations)
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

    // Determine preliminary selected jurisdiction:
    // - if lock => ALWAYS expected
    // - fiscal: if we have both QC and CA-FED, set UNKNOWN (mixed)
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

    // Now apply strict scope filter BEFORE final top_k pick
    const scopedRows = rawRows.filter((r) =>
      allowRowByScope({
        row: r,
        domain: domain_detected,
        jurisdiction_expected,
        jurisdiction_selected,
        gate,
      })
    );

    // If lock and scope filtering leaves nothing, we MUST NOT “fallback” to wrong regime.
    // Always-answer fallback will handle this safely.
    // Build finalRows with coverage-aware needs:
    const finalRows: EnrichedRow[] = [];
    const picked = new Set<string>();

    const need = {
      charter: domain_detected === "Penal" && jurisdiction_selected !== "QC", // mostly for fed penal
      crcode: domain_detected === "Penal" && jurisdiction_selected !== "QC",
      clc: domain_detected === "Travail" && jurisdiction_selected === "CA-FED",
    };

    const addsNeed = (r: EnrichedRow) => {
      if (need.charter && isCharterSource(r)) return true;
      if (need.crcode && isCriminalCodeSource(r)) return true;
      if (need.clc && isCanadaLabourCodeSource(r)) return true;
      return false;
    };

    // Take needed coverage first
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

    // Fill remaining slots
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
    // No-source / low-relevance => ALWAYS ANSWER (no block)
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

      await supaPost("/rest/v1/logs", {
        question: message,
        profile_slug: profile ?? null,
        // Phase 4D
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
          kernels_count: kernelHits.length,
          debugPasses,
          distinctions_count: distinctions.length,
        },

        user_id: user.id,
      }).catch((e) => console.warn("log insert failed:", e));

      return json({
        answer,
        sources: [],
        usage: {
          type: "answer",
          domain_detected,
          jurisdiction_expected,
          jurisdiction_selected,
          jurisdiction_lock: gate.lock,
          rag_quality: 0,
          relevance_ok: false,
          coverage_ok: false,
          partial: true,
          hybrid_error: hybridError,
        },
      });
    }

    // ------------------------------
    // Warning policy (graduée)
    // ------------------------------
    const serverWarning =
      rag_quality === 3
        ? undefined
        : rag_quality === 2
        ? "Contexte partiel : je réponds prudemment selon les extraits disponibles."
        : "Contexte faible : réponse limitée (il manque probablement des sources clés).";

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

    // ------------------------------
    // Model payload
    // ------------------------------
    const userPayload = [
      `Question: ${message}`,
      `Domaine détecté: ${domain_detected}`,
      `Juridiction attendue (heuristique): ${jurisdiction_expected}`,
      `Juridiction sélectionnée (système): ${jurisdiction_selected}`,
      `Juridiction verrouillée (lock): ${gate.lock}`,
      "Concept distinctions (guides internes; NON des sources; NE PAS citer):",
distinctionsContext,
"",

      gate.pitfall_keyword ? `Exception/piège détecté: ${gate.pitfall_keyword}` : "",
      `Hypothèse syndicat (si non mentionné => non syndiqué): union_assumed=${gate.assumptions.union_assumed}`,
      `Signaux QA: relevance_ok=${relevance_ok} ; coverage_ok=${coverage_ok} ; rag_quality=${rag_quality}`,
      hybridError ? `HYBRID_RPC_WARNING: ${hybridError}` : "",
      cov.missing_coverage?.length ? `missing_coverage (pré-calculé):\n- ${cov.missing_coverage.join("\n- ")}` : "missing_coverage (pré-calculé): (aucun)",
      cov.ingest_needed?.length ? `ingest_needed (pré-calculé):\n- ${cov.ingest_needed.join("\n- ")}` : "ingest_needed (pré-calculé): (aucun)",
      "",
      kernelsWarning ? `KERNELS_WARNING: ${kernelsWarning}` : "",
      "Course kernels (guides pédagogiques internes; NON des sources de droit; NE PAS les citer):",
      kernelContext,
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
      "- Réponse graduée: si partiel, partial=true + missing_coverage[] + ingest_needed[].",
      "- Ne mentionne aucun article/arrêt/lien/test précis hors allowlist.",
      "- No-block: si un fait manque, applique l’hypothèse commune et mentionne-la (pas de question bloquante).",
      kernelHits.length ? "- Priorité: si des course kernels sont fournis, utilise-les comme structure (plan/étapes/pièges) et adapte aux faits." : "",
      kernelHits.length ?   "- OBLIGATION: commence l'Application par un mini 'Plan d'examen' en 3–6 puces, basé sur les course kernels fournis (reprendre leurs étapes/pièges), puis adapte aux faits."
  : "",
  distinctions.length ? "- Si une distinction pertinente est fournie, intègre explicitement 1–2 'pitfalls à éviter' dans l'Application." : "",

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

    // ------------------------------
    // If parse fails => safe fallback (no wrong regime)
    // ------------------------------
    if (!parsed) {
      const answer = buildAlwaysAnswerFallback({
        message,
        domain: domain_detected,
        gate,
        hybridError,
        missing_coverage: cov.missing_coverage,
        ingest_needed: cov.ingest_needed,
      });

      await supaPost("/rest/v1/logs", {
        question: message,
        profile_slug: profile ?? null,
        // Phase 4D
        course_slug,
        user_goal,
        institution_name,
        risk_flags,

        top_ids: finalRows.map((r) => r.id),
        response: {
          answer,
          sources,
          qa: {
            domain_detected,
            jurisdiction_expected,
            jurisdiction_selected,
            jurisdiction_lock: gate.lock,
            rag_quality,
            relevance_ok,
            coverage_ok,
            missing_coverage: cov.missing_coverage ?? [],
            article_confidence,
            refused_reason: "json_parse_failed_fallback_answer",
            hybrid_error: hybridError,
          },
        },
        usage: {
            mode,
            top_k,
            latency_ms: Date.now() - startedAt,
            kernels_count: kernelHits.length,
            openai_usage: completion.usage ?? null,
            debugPasses,
          },

        user_id: user.id,
      }).catch((e) => console.warn("log insert failed:", e));

      return json({ answer, sources: [], usage: { type: "answer", domain_detected, rag_quality, partial: true } });
    }

    // ------------------------------
    // Server-side normalization (ultimate guardrails)
    // ------------------------------
    // ✅ Force domain/jurisdiction to system decision to avoid model drift.
    parsed.domain = domain_detected;
    parsed.jurisdiction = jurisdiction_selected;

    // ✅ No-block conversions
    if (parsed.type === "clarify") {
      parsed.type = "answer";
      parsed.partial = true;
      parsed.warning = (parsed.warning ? parsed.warning + " " : "") + "No-block: clarification remplacée par hypothèses par défaut.";
    }
    if (parsed.type === "refuse") {
      parsed.type = "answer";
      parsed.partial = true;
      parsed.warning = (parsed.warning ? parsed.warning + " " : "") + "No-block: refus converti en réponse partielle.";
    }

    // Merge computed missing/ingest if model omitted
    if (!parsed.missing_coverage || parsed.missing_coverage.length === 0) parsed.missing_coverage = cov.missing_coverage ?? [];
    if (!parsed.ingest_needed || parsed.ingest_needed.length === 0) parsed.ingest_needed = cov.ingest_needed ?? [];

    // Allowlist enforcement
    const allow = enforceAllowedSourceIds(parsed, allowed_source_ids);
    let bad_source_ids: string[] = [];
    if (!allow.ok) {
      bad_source_ids = allow.bad;
      parsed.source_ids_used = allow.kept;
      parsed.partial = true;
      parsed.warning = (parsed.warning ? parsed.warning + " " : "") + "Certaines sources hors allowlist ont été retirées.";
    }

    // If model picked none => pick best in-domain/jurisdiction (NOT random)
    if (!parsed.source_ids_used || parsed.source_ids_used.length === 0) {
      parsed.source_ids_used = bestFallbackSourceIds({ sources, domain: domain_detected, jurisdiction: jurisdiction_selected });
      parsed.partial = true;
      parsed.warning = (parsed.warning ? parsed.warning + " " : "") + "Aucune source sélectionnée par le modèle; sélection serveur améliorée appliquée.";
    }

    // Ensure ILAC exists
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

    // Redact unsupported refs (anti-hallucination)
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

    // ✅ Absolute key: prevent wrong-regime content leaking into answer (Work QC vs Fed)
    const leak =
      hasForbiddenRegimeLeak({ text: parsed.ilac.probleme, domain: domain_detected, jurisdiction: jurisdiction_selected }) ||
      hasForbiddenRegimeLeak({ text: parsed.ilac.regle, domain: domain_detected, jurisdiction: jurisdiction_selected }) ||
      hasForbiddenRegimeLeak({ text: parsed.ilac.application, domain: domain_detected, jurisdiction: jurisdiction_selected }) ||
      hasForbiddenRegimeLeak({ text: parsed.ilac.conclusion, domain: domain_detected, jurisdiction: jurisdiction_selected });

    if (leak) {
      parsed.partial = true;
      parsed.warning = (parsed.warning ? parsed.warning + " " : "") + "Incohérence de régime détectée; correction serveur (pas d’importation d’un autre régime).";
      parsed.missing_coverage = Array.from(new Set([...(parsed.missing_coverage ?? []), "Incohérence: le texte mentionnait un régime juridique d’une autre juridiction."]));
      parsed.ingest_needed = Array.from(
        new Set([...(parsed.ingest_needed ?? []), "Ajouter au corpus les textes du régime applicable (dans la juridiction retenue) afin d’éviter tout recours au mauvais régime."])
      );
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

    const answer = formatAnswerFromModel(parsed, sources, serverWarning);

    // ------------------------------
    // Logging QA
    // ------------------------------
    await supaPost("/rest/v1/logs", {
      question: message,
      profile_slug: profile ?? null,
      // Phase 4D
      course_slug,
      user_goal,
      institution_name,
      risk_flags,
      top_ids: finalRows.map((r) => r.id),
      response: {
        answer,
        sources,
        bad_source_ids: bad_source_ids.length ? bad_source_ids : null,
        qa: {
          domain_detected,
          jurisdiction_expected,
          jurisdiction_selected,
          jurisdiction_lock: gate.lock,
          pitfall_keyword: gate.pitfall_keyword ?? null,
          rag_quality,
          relevance_ok,
          coverage_ok,
          missing_coverage: parsed.missing_coverage ?? cov.missing_coverage ?? [],
          had_qc_source,
          article_confidence,
          refused_reason: null,
          hybrid_error: hybridError,
          redactions_count: redactions.length,
        },
      },
      usage: {
        mode,
        top_k,
        latency_ms: Date.now() - startedAt,
        kernels_count: kernelHits.length,
        openai_usage: completion.usage ?? null,
        debugPasses,
      },

      user_id: user.id,
    }).catch((e) => console.warn("log insert failed:", e));

    return json({
      answer,
      sources,
      usage: {
        type: parsed.type,
        domain_detected,
        jurisdiction_expected,
        jurisdiction_selected,
        jurisdiction_lock: gate.lock,
        rag_quality,
        relevance_ok,
        coverage_ok,
        had_qc_source,
        article_confidence,
        missing_coverage: parsed.missing_coverage ?? [],
        hybrid_error: hybridError,
        kernels_count: kernelHits.length,
        distinctions_count: distinctions.length,
      },
    });
  } catch (e: any) {
    console.error("chat route error:", e);
    return json({ error: e?.message ?? "Unknown error" }, 500);
  }
}
