/* eslint-disable no-console */
import { NextResponse } from "next/server";
import { createClient } from "../../../lib/supabase/server";

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

  question?: string;
  messages?: Array<{ role: "user" | "assistant" | "system"; content: string }>;
};

// Hybrid RPC result can include extra scoring fields.
type HybridHit = EnrichedRow & {
  similarity?: number | null; // 0..1
  distance?: number | null; // 0..2 (cosine dist) depending impl
  fts_rank?: number | null; // 0..?
  score?: number | null; // fused score (RRF) if returned by RPC
  bucket?: string | null;
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

// ------------------------------
// Jurisdiction detection (Phase 4B)
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

function hasQcWeakLocationSignals(q: string): boolean {
  const s = q.toLowerCase();
  const weak = ["québec", "quebec", "montréal", "montreal", "saguenay", "gatineau", "laval", "trois-rivières", "trois-rivieres"];
  for (let i = 0; i < weak.length; i++) if (s.includes(weak[i])) return true;
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
  const work = ["congédi", "congedi", "licenci", "renvoi", "emploi", "travail", "harcèlement", "harcelement", "disciplin", "grief", "syndic", "préavis", "preavis"];
  for (let i = 0; i < work.length; i++) if (s.includes(work[i])) return true;
  return false;
}

function hasStrongFedSectorSignals(q: string): { matched: boolean; keyword?: string } {
  const s = q.toLowerCase();
  const strong = [
    "banque",
    "banques",
    "télécom",
    "telecom",
    "radiodiffusion",
    "aviation",
    "aéroport",
    "aeroport",
    "transport interprovincial",
    "ferroviaire",
    "maritime",
    "pipeline",
    "poste",
  ];
  for (let i = 0; i < strong.length; i++) {
    if (s.includes(strong[i])) return { matched: true, keyword: strong[i] };
  }
  return { matched: false };
}

function detectJurisdictionExpected(q: string): Jurisdiction {
  if (hasQcLegalSignals(q)) return "QC";
  if (hasFedLegalSignals(q)) return "CA-FED";
  if (hasPenalSignals(q)) return "CA-FED";
  if (hasHealthSignals(q) && hasQcWeakLocationSignals(q)) return "QC";

  const fedSector = hasStrongFedSectorSignals(q);
  if (fedSector.matched) return "CA-FED";

  const s = q.toLowerCase();
  const otherSignals = ["ontario", "alberta", "colombie-britannique", "british columbia", "france", "europe", "usa", "états-unis", "etats-unis"];
  for (let i = 0; i < otherSignals.length; i++) if (s.includes(otherSignals[i])) return "OTHER";

  if (hasQcWeakLocationSignals(q)) return "UNKNOWN";
  return "UNKNOWN";
}

type GateDecision =
  | { type: "continue"; selected: Jurisdiction; reason: string; pitfall_keyword?: string | null }
  | { type: "clarify"; question: string; pitfall_keyword?: string | null };

function jurisdictionGate(message: string): GateDecision {
  const qcStrong = hasQcLegalSignals(message);
  const fedStrong = hasFedLegalSignals(message);
  const fedSector = hasStrongFedSectorSignals(message);
  const work = hasWorkSignals(message);

  // Piège classique: travail + secteur fédéral probable
  if (work && fedSector.matched && !qcStrong) {
    return {
      type: "clarify",
      pitfall_keyword: fedSector.keyword ?? null,
      question:
        "Avant de répondre (juridiction) : ton emploi relève-t-il d’un **secteur fédéral** (banque/télécom/aviation/transport interprovincial, etc.) ou d’un **employeur provincial au Québec** ?\n" +
        "Réponds : **fédéral** ou **QC**. Et es-tu **syndiqué** (oui/non) ?",
    };
  }

  if (fedSector.matched && !qcStrong && !fedStrong) {
    return {
      type: "continue",
      selected: "CA-FED",
      reason: "strong_federal_sector_autopick",
      pitfall_keyword: fedSector.keyword ?? null,
    };
  }

  if (qcStrong && fedSector.matched) {
    return {
      type: "clarify",
      pitfall_keyword: fedSector.keyword ?? null,
      question:
        "Avant de répondre : tu veux appliquer quel régime **juridique** ?\n" +
        "- **Fédéral (CA-FED)** : si ton employeur relève d’un secteur fédéral (banque/télécom/aviation/transport interprovincial, etc.)\n" +
        "- **Québec (QC)** : si tu vises un régime provincial (ex. CNESST/TAT/CCQ)\n" +
        "Dis-moi lequel (CA-FED ou QC) et si tu es **syndiqué** (oui/non).",
    };
  }

  if (fedStrong) return { type: "continue", selected: "CA-FED", reason: "explicit_fed_law" };
  if (qcStrong) return { type: "continue", selected: "QC", reason: "explicit_qc_law" };

  const detected = detectJurisdictionExpected(message);

  // Si UNKNOWN et pas de signaux, on laisse continuer (on clarifiera seulement si RAG=0)
  return { type: "continue", selected: detected, reason: "heuristic_detected" };
}

// ------------------------------
// Domain detection (heuristique)
// ------------------------------
function detectDomain(message: string): Domain {
  const s = message.toLowerCase();

  if (hasPenalSignals(message)) return "Penal";
  if (hasWorkSignals(message)) return "Travail";
  if (hasHealthSignals(message)) return "Sante";

  const fiscal = ["revenu québec", "revenu quebec", "agence du revenu", "cotisation", "objection", "appel fiscal", "tps", "tvq", "impôt", "impot", "taxe"];
  if (containsAny(s, fiscal)) return "Fiscal";

  const admin = ["taq", "cai", "commission d'accès", "commission d’acces", "contrôle judiciaire", "controle judiciaire", "tribunal administratif", "permis", "zonage"];
  if (containsAny(s, admin)) return "Admin";

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

function expandQuery(message: string, baseKeywords: string[], expected: Jurisdiction) {
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
    add("syndicat");
    add("grief");
  }

  if (hasPenalSignals(message)) {
    add("fouille");
    add("perquisition");
    add("saisie");
    add("déclaration");
    add("declaration");
    add("preuve");
    add("police");
    add("charte");
    add("exclusion");
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
// Ranking / scoring
// ------------------------------
function makeExcerpt(text: string, maxLen = 900): string {
  const t = (text || "").replace(/\s+/g, " ").trim();
  if (t.length <= maxLen) return t;
  return t.slice(0, maxLen) + "…";
}

function dedupKey(r: EnrichedRow): string {
  if (r.code_id_struct && r.article_num) return `${r.code_id_struct}::${r.article_num}`;
  if (r.citation) return `CIT::${r.citation}`;
  return `ID::${r.id}`;
}

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
// Coverage signals (minimum viable rules)
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
  // minimal (à élargir si ton corpus a des tags)
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

function computeCoverage(args: {
  domain: Domain;
  message: string;
  finalRows: EnrichedRow[];
  jurisdiction_selected: Jurisdiction;
}): { coverage_ok: boolean; missing_coverage: string[]; ingest_needed: string[] } {
  const { domain, message, finalRows, jurisdiction_selected } = args;

  const missing: string[] = [];
  const ingest: string[] = [];

  if (finalRows.length === 0) {
    return { coverage_ok: false, missing_coverage: ["Aucune source pertinente dans le corpus."], ingest_needed: ["Ajouter les textes (loi + juridiction) pertinents à la question."] };
  }

  // Default: ok
  let ok = true;

  if (domain === "Penal") {
    const hasCharter = finalRows.some(isCharterSource);
    const hasCrCode = finalRows.some(isCriminalCodeSource);
    const hasEv = hasEvidenceExclusionSignals(message);

    // règle MV: (Criminal Code) ET (Charte OU signaux preuve/exclusion)
    ok = hasCrCode && (hasCharter || hasEv);

    if (!hasCrCode) {
      missing.push("Code criminel (disposition pertinente) non trouvé dans les extraits.");
      ingest.push("Ajouter au corpus les dispositions pertinentes du Code criminel (Canada) liées à la fouille/détention/déclarations/preuve selon la question.");
    }
    if (!hasCharter) {
      missing.push("Charte canadienne (droit invoqué) non trouvée dans les extraits.");
      ingest.push("Ajouter au corpus les extraits pertinents de la Charte canadienne (droits et réparations) liés à la question.");
    }
  }

  if (domain === "Travail") {
    // On n’impose pas CA-FED systématiquement, mais si on est en CA-FED (ou piège fédéral),
    // on veut au moins 1 source CLC pour des recours de congédiement.
    const work = hasWorkSignals(message);
    const hasCLC = finalRows.some(isCanadaLabourCodeSource);
    if (work && jurisdiction_selected === "CA-FED") {
      ok = hasCLC;
      if (!hasCLC) {
        missing.push("Code canadien du travail (recours / congédiement) non trouvé dans les extraits.");
        ingest.push("Ajouter au corpus le Code canadien du travail (parties sur congédiement/recours, selon le cas) ou sources officielles équivalentes.");
      }
    }
  }

  if (domain === "Sante") {
    const hasCCQ = finalRows.some(isCivilCodeQcSource);
    const hasHealth = finalRows.some(isHealthLawQcSource);
    // MV: CCQ OU loi santé/accès
    ok = hasCCQ || hasHealth;
    if (!hasCCQ && !hasHealth) {
      missing.push("Base légale santé QC (CCQ ou loi santé/accès pertinente) non trouvée dans les extraits.");
      ingest.push("Ajouter au corpus les articles CCQ pertinents (consentement/aptitude/soins) et/ou la loi québécoise applicable (ex. accès/SSS) selon la question.");
    }
  }

  // Civil/Fiscal/Admin: pas de coverage hard en MV, mais on peut alimenter missing si article explicitement demandé
  const art = detectArticleMention(message);
  if (art.mentioned) {
    const wanted = art.nums;
    const hasAny = finalRows.some((r) => (r.article_num ? wanted.includes(r.article_num) : false));
    if (!hasAny) {
      missing.push(`Article(s) mentionné(s) (${wanted.join(", ")}) non trouvé(s) dans les extraits.`);
      ingest.push(`Ajouter au corpus les articles exacts demandés (${wanted.join(", ")}) (loi + juridiction) ou un extrait officiel contenant ces articles.`);
      ok = domain === "Penal" || domain === "Travail" || domain === "Sante" ? ok : false; // pour non-risqué: on marque coverage faible si article explicitement demandé
    }
  }

  // Si UNKNOWN et corpus mélange: on ne force pas "ok=false" — on préfère réponse prudente.
  if (jurisdiction_selected === "UNKNOWN") {
    ok = finalRows.length >= 1;
  }

  return { coverage_ok: ok, missing_coverage: missing, ingest_needed: ingest };
}

function computeRelevanceOk(args: {
  candidates: Array<{ row: EnrichedRow; composite: number; overlap: number }>;
}): boolean {
  const { candidates } = args;
  if (!candidates.length) return false;

  // Signal 1: composite fort sur au moins 1 hit
  const best = candidates[0];
  if (best.composite >= 1.2) return true;

  // Signal 2: overlap >= 2 sur au moins 1 hit
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

  // Base jurisdiction sanity
  let match = 0;
  if (jurisdiction_expected !== "UNKNOWN") {
    for (let i = 0; i < sources.length; i++) {
      const j = normalizeJurisdiction(sources[i].jur ?? "");
      const norm: Jurisdiction = j === "OTHER" ? "OTHER" : j;
      if (norm === jurisdiction_expected) match++;
    }
  } else {
    match = n >= 1 ? 1 : 0;
  }

  let base: 0 | 1 | 2 = 1;
  if (n >= 2 && (jurisdiction_expected === "UNKNOWN" || match >= 1)) base = 2;
  if (jurisdiction_expected !== "UNKNOWN" && match === 0) base = 1;

  // rag=3 seulement si relevance_ok ET coverage_ok (domain à risque inclus)
  if (base === 2 && relevance_ok && coverage_ok) return 3;
  if (base === 2) return 2;
  return 1;
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
// Hybrid RPC search (FTS + vector) — RPC ONLY (Phase 4B final)
// ------------------------------
async function callRpcWithVariants<T>(rpcName: string, variants: any[]): Promise<T[]> {
  let lastErr: any = null;

  for (let i = 0; i < variants.length; i++) {
    const body = variants[i];
    try {
      const rpcRes = await supaPost(`/rest/v1/rpc/${rpcName}`, body);
      if (!rpcRes.ok) {
        const t = await rpcRes.text().catch(() => "");
        lastErr = new Error(`RPC ${rpcName} failed: ${rpcRes.status} ${t}`);
        continue;
      }
      return ((await rpcRes.json()) ?? []) as T[];
    } catch (e) {
      lastErr = e;
    }
  }

  throw lastErr ?? new Error(`RPC ${rpcName} failed (no variant worked)`);
}

async function hybridSearchRPC(args: {
  query_text: string;
  query_embedding: number[];
  match_count: number;
  bucket?: string | null; // optional if your RPC supports it
}): Promise<HybridHit[]> {
  const rpcName = "search_legal_vectors_hybrid_v2";

  // Variants: robust aux différences de signature (prod hardening)
  const variants = [
    { query_text: args.query_text, query_embedding: args.query_embedding, match_count: args.match_count, bucket: args.bucket ?? null },
    { query_text: args.query_text, query_embedding: args.query_embedding, match_count: args.match_count },
    { query: args.query_text, query_embedding: args.query_embedding, match_count: args.match_count },
    { q: args.query_text, query_embedding: args.query_embedding, match_count: args.match_count },
    { query_text: args.query_text, query_embedding: args.query_embedding, k: args.match_count },
    { query: args.query_text, query_embedding: args.query_embedding, k: args.match_count },
  ];

  return await callRpcWithVariants<HybridHit>(rpcName, variants);
}

// ------------------------------
// Prompt + output checks (Phase 4B — “verrouillé” + réponse graduée)
// ------------------------------
// SYSTEM PROMPT — version verrouillée (aligné policy) :contentReference[oaicite:2]{index=2}
const SYSTEM_PROMPT = `
Tu es Droitis, tuteur IA spécialisé en droit québécois (QC).
Tu réponds en ILAC/IRAC : Problème → Règle → Application → Conclusion.
Interdiction absolue : inventer une loi, un article, une décision, une citation, ou un lien.
Tu ne cites QUE ce qui est présent dans sources[] et dans l’allowlist fournie.
Si une information n’est pas disponible dans les sources : tu dois le dire et expliquer quoi ingérer.
Tu dois annoncer la juridiction applicable avant d’énoncer la règle.
Si la juridiction est incertaine, tu poses 1 question de clarification avant de répondre.

PHASE 4B — RÉPONSE GRADUÉE (IMPORTANT)
- Le refus total doit être rare.
- Si les sources sont partielles mais pertinentes : réponds quand même prudemment (partial=true),
  et liste précisément missing_coverage[] + ingest_needed[].
- Tu n’as pas le droit de mentionner un article/arrêt/numéro/test précis s’il n’est pas dans l’allowlist.
- Ne “complète” jamais avec du plausible : si non supporté → “Information non disponible dans le corpus actuel” + ingest_needed.
`.trim();

type ModelJson = {
  type: "answer" | "clarify" | "refuse";
  jurisdiction: Jurisdiction;
  domain?: Domain;

  ilac?: { probleme: string; regle: string; application: string; conclusion: string };

  clarification_question?: string;

  refusal_reason?: string;

  // Phase 4B response graduée
  partial?: boolean;
  missing_coverage?: string[];
  ingest_needed?: string[];

  // Allowlist
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

// Post-check “anti-hallucination” (soft-redact)
// Objectif: ne jamais laisser passer des citations/arrêts/articles hors allowlist.
// On redige plutôt que refuser systématiquement (réduit les refus).
function buildAllowedCitationText(sources: Source[]): string {
  const uniq = new Set<string>();
  for (let i = 0; i < sources.length; i++) {
    const c = (sources[i].citation ?? "").trim();
    if (c) uniq.add(c);
  }
  return Array.from(uniq).join(" | ").toLowerCase();
}

function redactUnsupportedRefs(text: string, allowedCitationsLower: string): { text: string; redactions: string[] } {
  let out = text ?? "";
  const redactions: string[] = [];

  // Articles: "art. 8", "article 1457"
  const artRe = /\b(?:art\.?|article)\s*([0-9]{1,5})\b/gi;
  out = out.replace(artRe, (m) => {
    const ml = m.toLowerCase();
    if (allowedCitationsLower.includes(ml)) return m; // exact mention appears in allowlist string
    // Si l’allowlist contient "1457" sans "article", on reste prudent: on redige quand même
    redactions.push(m);
    return "article [non supporté par le corpus]";
  });

  // Citations style "2007 CSC 34", "2018 SCC 10", "2021 QCCA 123"
  const caseRe = /\b(19\d{2}|20\d{2})\s*(CSC|SCC|QCCA|QCCS|QCCQ|BCCA|ONCA|FCA|CAF)\s*([0-9]{1,6})\b/gi;
  out = out.replace(caseRe, (m) => {
    const ml = m.toLowerCase();
    if (allowedCitationsLower.includes(ml)) return m;
    redactions.push(m);
    return "[décision non supportée par le corpus]";
  });

  return { text: out, redactions };
}

function formatAnswerFromModel(parsed: ModelJson, sources: Source[], serverWarning?: string): string {
  if (parsed.type === "clarify") {
    return parsed.clarification_question ?? "Avant de répondre : peux-tu préciser les éléments nécessaires (juridiction / faits critiques) ?";
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

  const warn = (serverWarning || parsed.warning) ? `\n\n⚠️ ${serverWarning || parsed.warning}\n` : "";
  const partial = parsed.partial ? `\n\n⚠️ Réponse partielle : certaines sous-questions ne sont pas couvertes par les extraits.\n` : "";

  const missing = (parsed.missing_coverage ?? []).length
    ? `\n\n**Couverture manquante (missing_coverage)**\n${(parsed.missing_coverage ?? []).map((x) => `- ${x}`).join("\n")}\n`
    : "";

  const ingest = (parsed.ingest_needed ?? []).length
    ? `\n\n**À ingérer pour compléter (ingest_needed)**\n${(parsed.ingest_needed ?? []).map((x) => `- ${x}`).join("\n")}\n`
    : "";

  return [
    `**Juridiction applicable (selon le corpus) : ${parsed.jurisdiction}**`,
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

    const profile = body.profile ?? null;
    // UX/Perf: top_k visible (5–8 recommandé)
    const top_k = clamp(body.top_k ?? 7, 5, 8);
    const mode = (body.mode ?? "prod").toLowerCase();

    // ------------------------------
    // Domain + Jurisdiction gate (avant retrieval)
    // ------------------------------
    const domain_detected = detectDomain(message);

    const gate = jurisdictionGate(message);
    if (gate.type === "clarify") {
      const clarify = gate.question;

      await supaPost("/rest/v1/logs", {
        question: message,
        profile_slug: profile ?? null,
        top_ids: [],
        response: {
          answer: clarify,
          sources: [],
          qa: {
            domain_detected,
            jurisdiction_expected: "UNKNOWN",
            jurisdiction_selected: "UNKNOWN",
            pitfall_keyword: gate.pitfall_keyword ?? null,
            rag_quality: 0,
            relevance_ok: false,
            coverage_ok: false,
            missing_coverage: ["Juridiction ambiguë (piège fédéral/provincial)."],
            article_confidence: 0,
            refused_reason: "jurisdiction_ambiguous_clarification_required",
            hybrid_error: null,
          },
        },
        usage: { mode, top_k, latency_ms: Date.now() - startedAt },
        user_id: user.id,
      }).catch((e) => console.warn("log insert failed:", e));

      return json({
        answer: clarify,
        sources: [],
        usage: {
          type: "clarify",
          domain_detected,
          jurisdiction_expected: "UNKNOWN",
          jurisdiction_selected: "UNKNOWN",
          rag_quality: 0,
          relevance_ok: false,
          coverage_ok: false,
        },
      });
    }

    const jurisdiction_expected = gate.selected;

    // ------------------------------
    // Embedding + hybrid retrieval (RPC ONLY — 1 call)
    // ------------------------------
    const queryEmbedding = await createEmbedding(message);
    if (!queryEmbedding) return json({ error: "Échec embedding" }, 500);

    const baseKeywords = extractKeywords(message, 10);
    const { keywords } = expandQuery(message, baseKeywords, jurisdiction_expected);
    const article = detectArticleMention(message);

    const poolSize = 220;
    let hybridHits: HybridHit[] = [];
    let hybridError: string | null = null;

    try {
      // bucket hint optionnel — si RPC l’ignore, variants assurent la compat.
      hybridHits = await hybridSearchRPC({
        query_text: message,
        query_embedding: queryEmbedding,
        match_count: poolSize,
        bucket: jurisdiction_expected === "UNKNOWN" ? null : jurisdiction_expected,
      });
    } catch (e: any) {
      hybridError = e?.message ?? String(e);
      console.warn("hybridSearchRPC failed:", hybridError);
      hybridHits = [];
    }

    // ------------------------------
    // Passes QC → CA-FED → OTHER (app-side) + dedup + ranking
    // ------------------------------
    const PASS_ORDER: Jurisdiction[] = ["QC", "CA-FED", "OTHER"]; // non négociable Phase 4B :contentReference[oaicite:3]{index=3}
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

      // score RPC (RRF fusion) si disponible, sinon neutre
      const rpcScore = typeof h.score === "number" ? h.score : 0;
      const fts = typeof h.fts_rank === "number" ? Math.min(1, h.fts_rank) : 0;

      // Composite stable (calibrage conservateur)
      const composite = rpcScore * 0.9 + sc.hit_quality_score * 0.25 + (sim ?? 0) * 0.08 + fts * 0.05;

      return { composite, overlap: sc.overlap };
    };

    const goodThreshold = 1.25;
    const minGoodQCPass = 3;

    for (let p = 0; p < PASS_ORDER.length; p++) {
      const passJur = PASS_ORDER[p];
      const local: Cand[] = [];

      for (let i = 0; i < hybridHits.length; i++) {
        const h = hybridHits[i];
        const jur = normalizeJurisdiction(h.jurisdiction_norm);
        const norm: Jurisdiction = jur === "OTHER" ? "OTHER" : jur;
        if (norm !== passJur) continue;

        const key = dedupKey(h);
        if (seen.has(key)) continue;
        const { composite, overlap } = compositeFor(h);

        local.push({ row: h, composite, overlap, passJur });
      }

      local.sort((a, b) => b.composite - a.composite);

      // On limite par pass pour éviter exploser le prompt; on retient un pool utile.
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

      // Pass B/C seulement si Pass A insuffisant
      if (passJur === "QC" && good >= minGoodQCPass) {
        // On ne coupe pas si domaine pénal (souvent CA-FED needed)
        if (domain_detected !== "Penal") break;
      }

      // Si rien trouvé en QC, on continue.
      // Sinon, CA-FED/OTHER seront ajoutés selon nécessité.
    }

    // ------------------------------
    // Sélection top_k (coverage-aware) depuis candidates
    // ------------------------------
    // candidates est déjà par pass; on re-trie globalement par composite
    const global = [...candidates].sort((a, b) => b.composite - a.composite);

    const finalRows: EnrichedRow[] = [];
    const picked = new Set<string>();

    const need = {
      charter: domain_detected === "Penal",
      crcode: domain_detected === "Penal",
      clc: domain_detected === "Travail" && jurisdiction_expected === "CA-FED",
    };

    const addsNeed = (r: EnrichedRow) => {
      if (need.charter && isCharterSource(r)) return true;
      if (need.crcode && isCriminalCodeSource(r)) return true;
      if (need.clc && isCanadaLabourCodeSource(r)) return true;
      return false;
    };

    // 1) On essaie d’attraper d’abord les “piliers” nécessaires (si présents)
    for (let i = 0; i < global.length && finalRows.length < top_k; i++) {
      const r = global[i].row;
      const k = dedupKey(r);
      if (picked.has(k)) continue;
      if (!addsNeed(r)) continue;

      picked.add(k);
      finalRows.push(r);

      if (need.charter && isCharterSource(r)) need.charter = false;
      if (need.crcode && isCriminalCodeSource(r)) need.crcode = false;
      if (need.clc && isCanadaLabourCodeSource(r)) need.clc = false;
    }

    // 2) On complète avec les meilleurs hits
    for (let i = 0; i < global.length && finalRows.length < top_k; i++) {
      const r = global[i].row;
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

    const jurisdiction_selected = selectJurisdictionFromSources(sources, jurisdiction_expected);

    // Relevance signal: basé sur les meilleurs candidats (global)
    const relevance_ok = computeRelevanceOk({
      candidates: global.slice(0, 12).map((x) => ({ row: x.row, composite: x.composite, overlap: x.overlap })),
    });

    // Coverage signal: basé sur finalRows (puisque le modèle ne peut citer que ça)
    const cov = computeCoverage({ domain: domain_detected, message, finalRows, jurisdiction_selected });
    const coverage_ok = cov.coverage_ok;

    // rag_quality final (suffisance pour répondre)
    const rag_quality = computeRagQuality({
      jurisdiction_expected,
      jurisdiction_selected,
      sources,
      relevance_ok,
      coverage_ok,
      domain: domain_detected,
    });

    // article confidence (telemetry)
    let article_confidence = 0;
    const scanN = Math.min(finalRows.length, 6);
    for (let i = 0; i < scanN; i++) {
      const sc = scoreHit({ row: finalRows[i], expected: jurisdiction_expected, keywords, article, similarity: null });
      if (sc.article_conf > article_confidence) article_confidence = sc.article_conf;
    }

    const had_qc_source = sources.some((s) => normalizeJurisdiction(s.jur ?? "") === "QC");

    // ------------------------------
    // No-source / low-relevance decision (refus rare, mais déterministe)
    // ------------------------------
    if (sources.length === 0 || !relevance_ok) {
      // Si juridiction incertaine, on clarifie (max 1–3 questions)
      if (jurisdiction_expected === "UNKNOWN") {
        const clarify =
          "Avant de répondre, je n’ai pas trouvé d’extraits suffisamment pertinents dans le corpus.\n" +
          "1) Quelle juridiction veux-tu appliquer (QC / CA-FED / autre) ?\n" +
          "2) Quel domaine (pénal, travail, santé, civil, fiscal, administratif) ?\n" +
          "3) Peux-tu donner 2–3 mots-clés (ou un article précis) ?";
        await supaPost("/rest/v1/logs", {
          question: message,
          profile_slug: profile ?? null,
          top_ids: [],
          response: {
            answer: clarify,
            sources: [],
            qa: {
              domain_detected,
              jurisdiction_expected,
              jurisdiction_selected,
              rag_quality: 0,
              relevance_ok: false,
              coverage_ok: false,
              missing_coverage: ["Aucune source pertinente."],
              article_confidence,
              refused_reason: "rag_no_relevant_sources_clarify",
              hybrid_error: hybridError,
            },
          },
          usage: { mode, top_k, latency_ms: Date.now() - startedAt, debugPasses },
          user_id: user.id,
        }).catch((e) => console.warn("log insert failed:", e));

        return json({
          answer: clarify,
          sources: [],
          usage: { type: "clarify", domain_detected, jurisdiction_expected, jurisdiction_selected, rag_quality: 0, relevance_ok: false, coverage_ok: false },
        });
      }

      const refusal =
        "Information non disponible dans le corpus actuel (sources insuffisantes ou hors-sujet).\n" +
        "Pour répondre avec certitude, il faut ingérer :\n" +
        "- la loi / le règlement applicable (avec juridiction)\n" +
        "- l’article précis si tu en as un\n" +
        "- ou la décision/jurisprudence pertinente\n";

      await supaPost("/rest/v1/logs", {
        question: message,
        profile_slug: profile ?? null,
        top_ids: [],
        response: {
          answer: refusal,
          sources: [],
          qa: {
            domain_detected,
            jurisdiction_expected,
            jurisdiction_selected,
            rag_quality: 0,
            relevance_ok: false,
            coverage_ok: false,
            missing_coverage: ["Aucune source pertinente."],
            article_confidence,
            refused_reason: "rag_no_relevant_sources_refuse",
            hybrid_error: hybridError,
          },
        },
        usage: { mode, top_k, latency_ms: Date.now() - startedAt, debugPasses },
        user_id: user.id,
      }).catch((e) => console.warn("log insert failed:", e));

      return json({
        answer: refusal,
        sources: [],
        usage: { type: "refuse", domain_detected, jurisdiction_expected, jurisdiction_selected, rag_quality: 0, relevance_ok: false, coverage_ok: false },
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
        .map(
          (s) =>
            `SOURCE id=${s.id}\nCitation: ${s.citation}\nJuridiction: ${s.jur}\nURL: ${s.url ?? ""}\nExtrait:\n${s.snippet ?? ""}`
        )
        .join("\n---\n") || "(aucun extrait)";

    // ------------------------------
    // Model payload (includes missing_coverage + ingest_needed)
    // ------------------------------
    const userPayload = [
      `Question: ${message}`,
      `Domaine détecté: ${domain_detected}`,
      `Juridiction attendue (heuristique): ${jurisdiction_expected}`,
      `Juridiction sélectionnée (sources dominantes): ${jurisdiction_selected}`,
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
      "- Réponse graduée: si partiel, partial=true + missing_coverage[] + ingest_needed[].",
      "- Ne mentionne aucun article/arrêt/lien/test précis hors allowlist (sinon refuse ou répond partiellement sans le nommer).",
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
- Si tu peux répondre partiellement avec les extraits: type="answer" + partial=true (ne refuse pas par défaut).
- Refuse seulement si: aucune source pertinente OU question exige un article/test précis absent ET impossible de répondre sans inventer.`,
    ]
      .filter(Boolean)
      .join("\n\n");

    // ------------------------------
    // Call model (1 shot + retry-on-refusal when sources are ok)
    // ------------------------------
    const runModel = async (extraNudge?: string) => {
      const msgs: Array<{ role: "system" | "user" | "assistant"; content: string }> = [{ role: "system", content: SYSTEM_PROMPT }];
      if (extraNudge) msgs.push({ role: "system", content: extraNudge });
      msgs.push({ role: "user", content: userPayload });
      return await createChatCompletion(msgs);
    };

    let completion = await runModel();
    let parsed = safeJsonParse<ModelJson>(completion.content);

    // Retry once if model over-refuses despite relevance_ok
    if (parsed && parsed.type === "refuse" && sources.length > 0 && relevance_ok) {
      completion = await runModel(
        "IMPORTANT: Tu ne dois pas refuser si une réponse prudente et partielle est possible avec les extraits. Réponds en 'answer' + partial=true et utilise uniquement l’allowlist."
      );
      parsed = safeJsonParse<ModelJson>(completion.content) ?? parsed;
    }

    if (!parsed) {
      const refusal =
        "Je ne peux pas répondre de façon fiable (sortie invalide). " +
        "Information non disponible dans le corpus actuel. Pour répondre avec certitude, il faut ingérer : " +
        "- préciser la loi / l’article / la juridiction à ingérer.";

      await supaPost("/rest/v1/logs", {
        question: message,
        profile_slug: profile ?? null,
        top_ids: finalRows.map((r) => r.id),
        response: {
          answer: refusal,
          sources,
          qa: {
            domain_detected,
            jurisdiction_expected,
            jurisdiction_selected,
            rag_quality,
            relevance_ok,
            coverage_ok,
            missing_coverage: cov.missing_coverage ?? [],
            article_confidence,
            refused_reason: "json_parse_failed",
            hybrid_error: hybridError,
          },
        },
        usage: { mode, top_k, latency_ms: Date.now() - startedAt, openai_usage: completion.usage ?? null, debugPasses },
        user_id: user.id,
      }).catch((e) => console.warn("log insert failed:", e));

      return json({ answer: refusal, sources: [], usage: { type: "refuse", domain_detected, rag_quality } });
    }

    // ------------------------------
    // Server-side safety normalization (graduée)
    // ------------------------------
    parsed.domain = parsed.domain ?? domain_detected;
    parsed.jurisdiction = parsed.jurisdiction ?? jurisdiction_selected;

    // Ensure missing_coverage/ingest defaults if model omitted but we computed them
    if (!parsed.missing_coverage || parsed.missing_coverage.length === 0) parsed.missing_coverage = cov.missing_coverage ?? [];
    if (!parsed.ingest_needed || parsed.ingest_needed.length === 0) parsed.ingest_needed = cov.ingest_needed ?? [];

    // If coverage is weak, prefer partial answer instead of refusal (unless no sources)
    if (parsed.type === "refuse" && sources.length > 0) {
      // Convert to partial answer (safe), unless refusal is due to no-sources
      parsed.type = "answer";
      parsed.partial = true;
      parsed.warning = parsed.warning ?? "Réponse partielle (le modèle avait initialement refusé; conversion serveur pour éviter un refus total inutile).";
      parsed.ilac = parsed.ilac ?? {
        probleme: "Selon les extraits disponibles, la question soulève un enjeu juridique, mais certaines bases précises manquent dans le corpus.",
        regle: "Je ne peux énoncer que les règles explicitement supportées par les extraits. Pour le reste, l’information n’est pas disponible dans le corpus actuel.",
        application: "J’applique uniquement ce que les extraits permettent, et j’indique ce qui manque pour compléter l’analyse.",
        conclusion: "Réponse prudente et partielle; voir 'Couverture manquante' et 'À ingérer' pour compléter.",
      };
    }

    // Allowlist check
    const allow = enforceAllowedSourceIds(parsed, allowed_source_ids);

    // If allowlist violations, drop the bad IDs instead of refusing (unless none left)
    let bad_source_ids: string[] = [];
    if (!allow.ok) {
      bad_source_ids = allow.bad;
      parsed.source_ids_used = allow.kept;

      if (!parsed.source_ids_used || parsed.source_ids_used.length === 0) {
        parsed.type = "refuse";
        parsed.refusal_reason = "Je ne peux pas répondre de façon fiable (sources hors allowlist détectées et aucune source valide restante).";
        parsed.partial = false;
      } else {
        parsed.partial = true;
        parsed.warning =
          (parsed.warning ? parsed.warning + " " : "") +
          "Certaines sources proposées par le modèle étaient hors allowlist et ont été retirées (réponse partielle).";
      }
    }

    // If answer but no source_ids_used: auto-fill 1–2 sources (réduit refus inutiles)
    if (parsed.type === "answer" && (!parsed.source_ids_used || parsed.source_ids_used.length === 0)) {
      parsed.source_ids_used = sources.slice(0, Math.min(2, sources.length)).map((s) => s.id);
      parsed.partial = true;
      parsed.warning = (parsed.warning ? parsed.warning + " " : "") + "Aucune source sélectionnée par le modèle; sélection serveur minimale appliquée (réponse partielle).";
    }

    // Soft-redact unsupported refs in ILAC fields (anti-hallucination)
    let redactions: string[] = [];
    if (parsed.type === "answer" && parsed.ilac) {
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
        parsed.ingest_needed = Array.from(new Set([...(parsed.ingest_needed ?? []), "Ajouter au corpus la source officielle correspondant aux références manquantes, ou retirer la demande de citation précise."]));
        parsed.warning = (parsed.warning ? parsed.warning + " " : "") + "Certaines références non supportées ont été redigées (anti-hallucination).";
      }
    }

    // If the server warning says context weak, keep it
    if (serverWarning && parsed.type === "answer") {
      parsed.warning = parsed.warning ? `${serverWarning} ${parsed.warning}` : serverWarning;
      if (rag_quality <= 2) parsed.partial = parsed.partial ?? true;
    }

    // Ensure refused_reason always filled if refuse
    if (parsed.type === "refuse" && !parsed.refusal_reason) {
      parsed.refusal_reason = "Information non disponible dans le corpus actuel (refus déterministe).";
    }

    const answer = formatAnswerFromModel(parsed, sources, serverWarning);

    // ------------------------------
    // Logging QA (Phase 4B)
    // ------------------------------
    await supaPost("/rest/v1/logs", {
      question: message,
      profile_slug: profile ?? null,
      top_ids: finalRows.map((r) => r.id),
      response: {
        answer,
        sources,
        bad_source_ids: bad_source_ids.length ? bad_source_ids : null,
        qa: {
          domain_detected,
          jurisdiction_expected,
          jurisdiction_selected,
          rag_quality,
          relevance_ok,
          coverage_ok,
          missing_coverage: parsed.missing_coverage ?? cov.missing_coverage ?? [],
          had_qc_source,
          article_confidence,
          refused_reason: parsed.type === "refuse" ? parsed.refusal_reason ?? null : null,
          hybrid_error: hybridError,
          redactions_count: redactions.length,
        },
      },
      usage: {
        mode,
        top_k,
        latency_ms: Date.now() - startedAt,
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
        rag_quality,
        relevance_ok,
        coverage_ok,
        had_qc_source,
        article_confidence,
        missing_coverage: parsed.missing_coverage ?? [],
        hybrid_error: hybridError,
      },
    });
  } catch (e: any) {
    console.error("chat route error:", e);
    return json({ error: e?.message ?? "Unknown error" }, 500);
  }
}
