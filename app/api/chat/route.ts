/* eslint-disable no-console */
import { NextResponse } from "next/server";
import { createClient } from "../../../lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ------------------------------
// Types
// ------------------------------
type Jurisdiction = "QC" | "CA-FED" | "OTHER" | "UNKNOWN";

type VectorHit = {
  id?: string | number;
  code_id?: string | null;
  jurisdiction?: string | null;
  citation?: string | null;
  title?: string | null;
  text?: string | null;
  similarity?: number | null; // recommended
  distance?: number | null; // legacy
};

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
  // Phase 3
  message?: string;
  profile?: string | null;
  top_k?: number | null;
  mode?: string | null; // "dev" force dev

  // Phase 4 compatibility
  question?: string;
  messages?: Array<{ role: "user" | "assistant" | "system"; content: string }>;
};

// ------------------------------
// Env
// ------------------------------
const { OPENAI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;

// ------------------------------
// Helpers
// ------------------------------
function json(data: any, init?: number | ResponseInit) {
  return new Response(JSON.stringify(data, null, 2), {
    status: typeof init === "number" ? init : init?.status ?? 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(typeof init !== "number" ? init?.headers : undefined),
    },
  });
}

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "Content-Type, Authorization",
};

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

// ------------------------------
// Jurisdiction detection (Phase 4B: robust, non-work-centric)
// ------------------------------
// ✅ “Québec” seul = signal faible (lieu), pas un signal juridique QC.
// On ne déclenche QC “fort” que si l’utilisateur mentionne clairement le régime QC.
function hasQcLegalSignals(q: string): boolean {
  const s = q.toLowerCase();
  const qcStrong = [
    "c.c.q",
    "ccq",
    "code civil du québec",
    "code de procédure civile",
    "cpc",
    "cnesst",
    "tribunal administratif du travail",
    "tat",
    "legisquebec",
    "légisquébec",
    "charte québécoise",
    "loi du québec",
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
    "criminal code",
    "code criminel",
  ];
  for (let i = 0; i < fedStrong.length; i++) if (s.includes(fedStrong[i])) return true;
  return false;
}

// Signaux pénal/procédure pénale (CA-FED probable)
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

// Signaux santé/consentement (QC probable si contexte QC)
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
  ];
  for (let i = 0; i < health.length; i++) if (s.includes(health[i])) return true;
  return false;
}

// Secteurs “très typiquement fédéraux”
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
  // 1) Signaux juridiques explicites
  if (hasQcLegalSignals(q)) return "QC";
  if (hasFedLegalSignals(q)) return "CA-FED";

  // 2) Signaux pénal → CA-FED probable (ex: Code criminel / Charte)
  if (hasPenalSignals(q)) return "CA-FED";

  // 3) Santé + QC-location → QC probable
  if (hasHealthSignals(q) && hasQcWeakLocationSignals(q)) return "QC";

  // 4) Secteur fédéral explicite → CA-FED (même “au Québec”)
  const fedSector = hasStrongFedSectorSignals(q);
  if (fedSector.matched) return "CA-FED";

  // 5) Autres provinces/pays
  const s = q.toLowerCase();
  const otherSignals = ["ontario", "alberta", "colombie-britannique", "british columbia", "france", "europe", "usa", "états-unis", "etats-unis"];
  for (let i = 0; i < otherSignals.length; i++) if (s.includes(otherSignals[i])) return "OTHER";

  // 6) Lieu QC seul => UNKNOWN (on laisse le retrieval décider)
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

  // ✅ secteur fédéral explicitement nommé ET pas d’ancrage juridique QC explicite -> auto CA-FED, no clarify
  if (fedSector.matched && !qcStrong) {
    return {
      type: "continue",
      selected: "CA-FED",
      reason: "strong_federal_sector_autopick",
      pitfall_keyword: fedSector.keyword ?? null,
    };
  }

  // Conflit “vrai” : user invoque explicitement QC ET mentionne secteur fédéral
  if (qcStrong && fedSector.matched) {
    return {
      type: "clarify",
      pitfall_keyword: fedSector.keyword ?? null,
      question:
        "Avant de répondre : tu veux appliquer quel régime **juridique** ?\n" +
        "- **Fédéral (CA-FED)** : si ton employeur relève d’un secteur fédéral (banque/télécom/aviation/transport interprovincial, etc.)\n" +
        "- **Québec (QC)** : si tu vises un régime provincial (ex. CNESST/TAT/CCQ)\n" +
        "Dis-moi lequel tu veux appliquer, et si tu es **syndiqué** (oui/non).",
    };
  }

  if (fedStrong) return { type: "continue", selected: "CA-FED", reason: "explicit_fed_law" };
  if (qcStrong) return { type: "continue", selected: "QC", reason: "explicit_qc_law" };

  // Sinon: heuristique globale
  const detected = detectJurisdictionExpected(message);
  return { type: "continue", selected: detected, reason: "heuristic_detected" };
}

// ------------------------------
// Keyword extraction + safe expansion (no hallucination)
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

/**
 * Expansion "safe":
 * - ajoute seulement des mots-concepts (pas de règles)
 * - pin d’articles seulement pour aider le retrieval (si pas en base => aucun effet)
 */
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

  // Responsabilité civile (QC)
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
    add("diligence");

    if (expected === "QC" || expected === "UNKNOWN") {
      pinnedArticleNums.push("1457", "1458", "1459");
    }
  }

  // Contrat
  if (has("contrat") || has("contractuel") || has("inexécution") || has("inexecution") || has("obligation")) {
    add("contrat");
    add("obligation");
    add("inexécution");
    add("inexecution");
    add("dommages");
    add("réparation");
    add("reparation");
  }

  // Travail / congédiement
  if (has("congédi") || has("congedi") || has("licenci") || has("renvoi") || has("emploi") || has("travail") || has("probation")) {
    add("congédiement");
    add("licenciement");
    add("renvoi");
    add("motif");
    add("cause");
    add("probation");
    add("préavis");
    add("preavis");
    add("recours");
  }

  // Pénal / preuve
  if (hasPenalSignals(message)) {
    add("fouille");
    add("perquisition");
    add("saisie");
    add("déclaration");
    add("declaration");
    add("preuve");
    add("police");
    add("charte");
  }

  // Santé / consentement
  if (hasHealthSignals(message)) {
    add("consentement");
    add("soins");
    add("urgence");
    add("inapte");
    add("capacité");
    add("capacite");
  }

  return { keywords: kw.slice(0, 14), pinnedArticleNums };
}

// ------------------------------
// Ranking / scoring
// ------------------------------
function rrfScore(rank: number, k = 60): number {
  return 1 / (k + rank);
}

function makeExcerpt(text: string, maxLen = 1000): string {
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
}): { hit_quality_score: number; article_conf: number } {
  const { row, expected, keywords, article, similarity } = args;

  let score = 0;

  const jur = normalizeJurisdiction(row.jurisdiction_norm);
  const jurMatch = expected === "UNKNOWN" ? true : jur === expected;

  if (expected === "UNKNOWN") score += 0.3;
  else if (jurMatch) score += 1.0;
  else score -= 0.8;

  // Prefer “art.” sources slightly; penalize mega headings
  const citRaw = row.citation ?? "";
  const cit = citRaw.toLowerCase();
  if (/^art\./i.test(citRaw)) score += 0.15;
  if (cit.startsWith("livre ") || cit.startsWith("book ")) score -= 0.25;

  // Article mention boost only if user asked an article explicitly
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

  return { hit_quality_score: score, article_conf: articleConf };
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

/**
 * rag_quality (0–3) — FIXED:
 * - no forced "QC" when expected is UNKNOWN
 * - judged vs jurisdiction_selected (dominant evidence)
 */
function computeRagQuality(args: { jurisdiction_selected: Jurisdiction; sources: Source[] }): 0 | 1 | 2 | 3 {
  const { jurisdiction_selected, sources } = args;
  const n = sources.length;
  if (n === 0) return 0;

  if (jurisdiction_selected === "UNKNOWN") {
    // still not “0” if we have sources; we just don’t know the proper bucket
    return n >= 2 ? 2 : 1;
  }

  // At least 1 source in selected jurisdiction?
  let match = 0;
  for (let i = 0; i < sources.length; i++) {
    const j = normalizeJurisdiction(sources[i].jur ?? "");
    const norm: Jurisdiction = j === "OTHER" ? "OTHER" : j;
    if (norm === jurisdiction_selected) match++;
  }
  if (match === 0) return 0;

  if (match >= 2) return 3;
  return 2;
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

async function supaGet(path: string) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY manquant");
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    method: "GET",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "count=none",
    },
  });
  return res;
}

async function vectorSearchRPC(rpcName: string, query_embedding: number[], match_count: number): Promise<VectorHit[]> {
  const rpcRes = await supaPost(`/rest/v1/rpc/${rpcName}`, { query_embedding, match_count });
  if (!rpcRes.ok) {
    const t = await rpcRes.text().catch(() => "");
    throw new Error(`RPC ${rpcName} failed: ${rpcRes.status} ${t}`);
  }
  return ((await rpcRes.json()) ?? []) as VectorHit[];
}

async function enrichByIds(ids: Array<string | number>): Promise<Map<number, EnrichedRow>> {
  const map = new Map<number, EnrichedRow>();
  if (!ids.length) return map;

  const numericIds: number[] = [];
  for (let i = 0; i < ids.length; i++) {
    const n = Number(ids[i]);
    if (!Number.isNaN(n)) numericIds.push(n);
  }
  if (!numericIds.length) return map;

  const list = numericIds.join(",");
  const url =
    `/rest/v1/legal_vectors_enriched` +
    `?select=id,code_id,citation,title,text,jurisdiction_norm,code_id_struct,article_num,url_struct` +
    `&id=in.(${encodeURIComponent(list)})`;

  const res = await supaGet(url);
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`enrichByIds failed: ${res.status} ${t}`);
  }
  const rows = ((await res.json()) ?? []) as EnrichedRow[];
  for (let i = 0; i < rows.length; i++) map.set(rows[i].id, rows[i]);
  return map;
}

async function keywordSearchFallback(passJur: Jurisdiction, keywords: string[], limit: number): Promise<EnrichedRow[]> {
  let base =
    `/rest/v1/legal_vectors_enriched` +
    `?select=id,code_id,citation,title,text,jurisdiction_norm,code_id_struct,article_num,url_struct` +
    `&limit=${limit}`;

  if (passJur !== "UNKNOWN") base += `&jurisdiction_norm=eq.${encodeURIComponent(passJur)}`;

  const ors: string[] = [];
  for (let i = 0; i < keywords.length; i++) {
    const raw = keywords[i].trim().replace(/[%_]/g, "");
    if (!raw) continue;
    const pat = `*${raw}*`;
    ors.push(`citation.ilike.${pat}`);
    ors.push(`title.ilike.${pat}`);
    ors.push(`text.ilike.${pat}`);
  }

  if (ors.length) base += `&or=(${encodeURIComponent(ors.join(","))})`;

  const res = await supaGet(base);
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    console.warn("keywordSearchFallback failed:", res.status, t);
    return [];
  }
  return ((await res.json()) ?? []) as EnrichedRow[];
}

async function pinByArticleNums(passJur: Jurisdiction, nums: string[], limit: number): Promise<EnrichedRow[]> {
  if (!nums.length) return [];
  let base =
    `/rest/v1/legal_vectors_enriched` +
    `?select=id,code_id,citation,title,text,jurisdiction_norm,code_id_struct,article_num,url_struct` +
    `&limit=${limit}`;

  if (passJur !== "UNKNOWN") base += `&jurisdiction_norm=eq.${encodeURIComponent(passJur)}`;

  const ors: string[] = [];
  for (let i = 0; i < nums.length; i++) {
    const n = nums[i].trim();
    if (!n) continue;
    const pat = `*${n}*`;
    ors.push(`citation.ilike.${pat}`);
    ors.push(`title.ilike.${pat}`);
    ors.push(`text.ilike.${pat}`);
  }
  if (!ors.length) return [];
  base += `&or=(${encodeURIComponent(ors.join(","))})`;

  const res = await supaGet(base);
  if (!res.ok) return [];
  return ((await res.json()) ?? []) as EnrichedRow[];
}

function passOrderFor(expected: Jurisdiction): Jurisdiction[] {
  if (expected === "QC") return ["QC", "CA-FED", "OTHER"];
  if (expected === "CA-FED") return ["CA-FED", "QC", "OTHER"];
  if (expected === "OTHER") return ["OTHER", "QC", "CA-FED"];
  return ["QC", "CA-FED", "OTHER"];
}

async function hybridPassFromPreVector(args: {
  passJurisdiction: Jurisdiction;
  expected: Jurisdiction;
  keywords: string[];
  article: { mentioned: boolean; nums: string[] };
  vectorPool: Array<{ row: EnrichedRow; similarity: number | null }>;
  vectorN: number;
  keywordN: number;
}): Promise<{ rows: EnrichedRow[]; debug: any }> {
  const { passJurisdiction, expected, keywords, article, vectorPool, vectorN, keywordN } = args;

  const vList: Array<{ row: EnrichedRow; similarity: number | null }> = [];
  for (let i = 0; i < vectorPool.length; i++) {
    const it = vectorPool[i];
    const jur = normalizeJurisdiction(it.row.jurisdiction_norm);
    const norm: Jurisdiction = jur === "OTHER" ? "OTHER" : jur;
    if (passJurisdiction !== "UNKNOWN" && norm !== passJurisdiction) continue;
    vList.push(it);
    if (vList.length >= vectorN) break;
  }

  const kRows = await keywordSearchFallback(passJurisdiction, keywords, keywordN);

  const fused = new Map<number, { row: EnrichedRow; rrf: number; similarity: number | null }>();

  for (let i = 0; i < vList.length; i++) {
    const it = vList[i];
    const prev = fused.get(it.row.id);
    fused.set(it.row.id, {
      row: it.row,
      rrf: (prev ? prev.rrf : 0) + rrfScore(i + 1),
      similarity: it.similarity ?? (prev ? prev.similarity : null),
    });
  }

  for (let i = 0; i < kRows.length; i++) {
    const r = kRows[i];
    const prev = fused.get(r.id);
    fused.set(r.id, {
      row: r,
      rrf: (prev ? prev.rrf : 0) + rrfScore(i + 1),
      similarity: prev ? prev.similarity : null,
    });
  }

  const byDedup = new Map<string, { row: EnrichedRow; composite: number }>();
  const values = Array.from(fused.values());

  for (let i = 0; i < values.length; i++) {
    const it = values[i];
    const scored = scoreHit({
      row: it.row,
      expected,
      keywords,
      article,
      similarity: it.similarity,
    });
    const composite = it.rrf + scored.hit_quality_score * 0.15;
    const key = dedupKey(it.row);
    const ex = byDedup.get(key);
    if (!ex || composite > ex.composite) byDedup.set(key, { row: it.row, composite });
  }

  const ranked = Array.from(byDedup.values())
    .sort((a, b) => b.composite - a.composite)
    .map((x) => x.row);

  return {
    rows: ranked,
    debug: {
      passJurisdiction,
      vectorKept: vList.length,
      keywordReturned: kRows.length,
      fusedUnique: fused.size,
      dedupUnique: byDedup.size,
    },
  };
}

// ------------------------------
// Prompt “verrouillé” + JSON output (Central socle injected)
// ------------------------------
const SYSTEM_PROMPT = `
SOCLE ANTI-ERREUR / ANTI-HALLUCINATION — RÈGLES NON NÉGOCIABLES
- Aucune citation inventée : tu ne cites que des sources présentes dans sources[].
- Tu n’as PAS le droit d’utiliser des références (articles/arrêts/liens) hors sources[].
- Si une règle/exception/test n’est pas supporté par sources[] → tu dis "Information non disponible dans le corpus actuel" et tu proposes quoi ingérer.
- Juridiction annoncée AVANT les règles (QC / CA-FED / OTHER / UNKNOWN).
- Si un fait critique (qui change la loi applicable) est incertain → tu poses 1–3 questions max (type="clarify").
- Interdiction d’improviser (doctrine, tests, liens, numéros d’articles, noms d’arrêts) hors sources[].

PHASE 4B — OBJECTIF
- Répondre en IRAC/ILAC : Problème → Règle → Application → Conclusion.
- Réponse partielle permise : si certaines sous-questions sont couvertes par sources[], réponds à celles-là; pour le reste, indique "Non disponible" + ingest_needed.

FORMAT DE SORTIE (JSON STRICT)
- Tu dois sortir uniquement un JSON.
- Tu dois retourner source_ids_used (IDs) qui sont un sous-ensemble exact de allowed_source_ids.
`.trim();

type ModelJson = {
  type: "answer" | "clarify" | "refuse";
  jurisdiction: Jurisdiction;
  domain?: "Civil" | "Travail" | "Admin" | "Penal" | "Sante" | "Fiscal" | "Autre" | "Inconnu";
  ilac?: { probleme: string; regle: string; application: string; conclusion: string };
  clarification_question?: string;
  refusal_reason?: string;
  ingest_needed?: string[];
  source_ids_used?: Array<string | number>;
  warning?: string;
  partial?: boolean;
};

function enforceAllowedSourceIds(parsed: ModelJson, allowed: string[]): { ok: boolean; bad: string[] } {
  const used = parsed.source_ids_used ?? [];
  const bad: string[] = [];
  for (let i = 0; i < used.length; i++) {
    const id = String(used[i]);
    if (allowed.indexOf(id) === -1) bad.push(id);
  }
  return { ok: bad.length === 0, bad };
}

function formatAnswerFromModel(parsed: ModelJson, sources: Source[], warning?: string): string {
  if (parsed.type === "clarify") {
    return parsed.clarification_question ?? "Avant de répondre : peux-tu préciser les éléments nécessaires (juridiction / faits critiques) ?";
  }

  if (parsed.type === "refuse") {
    const ingest = (parsed.ingest_needed ?? []).map((x) => `- ${x}`).join("\n");
    return [
      parsed.refusal_reason ?? "Je ne peux pas répondre de façon fiable avec le corpus actuel.",
      "",
      `Information non disponible dans le corpus actuel. Pour répondre avec certitude, il faut ingérer : ${ingest || "[préciser la loi / l’article / la juridiction à ingérer]."}`,
    ].join("\n");
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

  const warn = warning ? `\n\n⚠️ ${warning}\n` : "";
  const partial = parsed.partial ? `\n\n⚠️ Réponse partielle : certaines sous-questions ne sont pas couvertes par les extraits.\n` : "";

  return [
    `**Juridiction applicable (selon le corpus) : ${parsed.jurisdiction}**`,
    parsed.domain ? `**Domaine : ${parsed.domain}**` : "",
    warn,
    partial,
    `**Problème**\n${ilac.probleme}`,
    `\n**Règle**\n${ilac.regle}`,
    `\n**Application**\n${ilac.application}`,
    `\n**Conclusion**\n${ilac.conclusion}`,
    `\n**Sources citées (IDs allowlist)**\n${citedLines || "- (aucune)"}\n`,
  ]
    .filter(Boolean)
    .join("\n");
}

// ------------------------------
// POST
// ------------------------------
export async function POST(req: Request) {
  // ✅ Auth gate (Phase 3)
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
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return json({ error: "SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY manquant" }, 500);
    }

    const body = (await req.json().catch(() => ({}))) as ChatRequest;

    // ✅ Compat parsing: Phase 3 uses `message`
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
          details:
            "Le body JSON doit contenir soit { message: string } (Phase 3), soit { question: string }, soit { messages: [{role:'user', content:string}, ...] }.",
        },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    const profile = body.profile ?? null;
    const top_k = Math.max(1, Math.min(body.top_k ?? 5, 20));
    const mode = (body.mode ?? "prod").toLowerCase();

    // ------------------------------
    // Phase 4B: Jurisdiction gate
    // ------------------------------
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
            jurisdiction_expected: "UNKNOWN",
            jurisdiction_selected: "UNKNOWN",
            pitfall_keyword: gate.pitfall_keyword ?? null,
            rag_quality: 0,
            had_qc_source: false,
            article_confidence: 0,
            refused_reason: "jurisdiction_ambiguous_clarification_required",
          },
        },
        usage: { mode, top_k, latency_ms: Date.now() - startedAt },
        user_id: user.id,
      }).catch((e) => console.warn("log insert failed:", e));

      return json(
        {
          answer: clarify,
          sources: [],
          usage: {
            type: "clarify",
            jurisdiction_expected: "UNKNOWN",
            jurisdiction_selected: "UNKNOWN",
            rag_quality: 0,
            had_qc_source: false,
          },
        },
        { status: 200, headers: CORS_HEADERS }
      );
    }

    const jurisdiction_expected = gate.selected;

    // ------------------------------
    // Embedding + retrieval
    // ------------------------------
    const queryEmbedding = await createEmbedding(message);
    if (!queryEmbedding) return json({ error: "Échec embedding" }, 500);

    const isDev = mode === "dev";
    const rpcName = isDev ? "search_legal_vectors_dev" : "search_legal_vectors_v2";

    // ✅ Keywords + expansion (helps “no-article” questions)
    const baseKeywords = extractKeywords(message, 10);
    const { keywords, pinnedArticleNums } = expandQuery(message, baseKeywords, jurisdiction_expected);
    const article = detectArticleMention(message);

    // ✅ Pin “piliers” (retrieval aid only)
    const pinnedRows =
      jurisdiction_expected === "QC" || jurisdiction_expected === "UNKNOWN"
        ? await pinByArticleNums("QC", pinnedArticleNums, 10)
        : [];

    // ✅ Vector once (perf): get a big pool, enrich once, then do pass filtering + RRF
    const vectorPoolSize = 160;
    const vHits = await vectorSearchRPC(rpcName, queryEmbedding, vectorPoolSize);

    const vIds: Array<string | number> = [];
    for (let i = 0; i < vHits.length; i++) vIds.push(vHits[i].id ?? "");
    const enriched = await enrichByIds(vIds);

    // Build vectorPool (ordered as returned)
    const vectorPool: Array<{ row: EnrichedRow; similarity: number | null }> = [];
    for (let i = 0; i < vHits.length; i++) {
      const h = vHits[i];
      const idNum = Number(h.id);
      if (Number.isNaN(idNum)) continue;
      const r = enriched.get(idNum);
      if (!r) continue;
      vectorPool.push({ row: r, similarity: typeof h.similarity === "number" ? h.similarity : null });
    }

    const passOrder = passOrderFor(jurisdiction_expected);

    const vectorN = 70;
    const keywordN = 45;

    const allRows: EnrichedRow[] = [];
    const debugPasses: any[] = [];

    for (let i = 0; i < pinnedRows.length; i++) allRows.push(pinnedRows[i]);

    for (let p = 0; p < passOrder.length; p++) {
      const passJur = passOrder[p];

      const pass = await hybridPassFromPreVector({
        passJurisdiction: passJur,
        expected: jurisdiction_expected,
        keywords,
        article,
        vectorPool,
        vectorN,
        keywordN,
      });
      debugPasses.push(pass.debug);

      for (let i = 0; i < pass.rows.length; i++) allRows.push(pass.rows[i]);

      // Stop early only when expected is NOT UNKNOWN (otherwise we want evidence across buckets)
      if (p === 0 && jurisdiction_expected !== "UNKNOWN") {
        let good = 0;
        const checkN = Math.min(pass.rows.length, 10);
        for (let i = 0; i < checkN; i++) {
          const s = scoreHit({ row: pass.rows[i], expected: jurisdiction_expected, keywords, article, similarity: null });
          if (s.hit_quality_score >= 1.2) good++;
        }
        if (good >= 4 || pinnedRows.length >= 2) break;
      }
    }

    // Final dedup & top_k
    const seen = new Set<string>();
    const finalRows: EnrichedRow[] = [];
    for (let i = 0; i < allRows.length; i++) {
      const k = dedupKey(allRows[i]);
      if (seen.has(k)) continue;
      seen.add(k);
      finalRows.push(allRows[i]);
      if (finalRows.length >= top_k) break;
    }

    const sources: Source[] = [];
    for (let i = 0; i < finalRows.length; i++) {
      const r = finalRows[i];
      sources.push({
        id: r.id,
        citation: r.citation,
        title: r.title,
        jur: r.jurisdiction_norm,
        url: r.url_struct,
        snippet: makeExcerpt(`${r.title ?? ""}\n${r.text ?? ""}`, 1100),
      });
    }

    // ✅ Select jurisdiction based on best evidence (dominance in sources), not “QC by default”
    const jurisdiction_selected = selectJurisdictionFromSources(sources, jurisdiction_expected);

    const rag_quality = computeRagQuality({
      jurisdiction_selected,
      sources,
    });

    // article_confidence (max on first 6)
    let article_confidence = 0;
    const scanN = Math.min(finalRows.length, 6);
    for (let i = 0; i < scanN; i++) {
      const sc = scoreHit({ row: finalRows[i], expected: jurisdiction_expected, keywords, article, similarity: null });
      if (sc.article_conf > article_confidence) article_confidence = sc.article_conf;
    }

    // If we truly have nothing: prefer clarification when expected UNKNOWN (don’t hard-refuse too early)
    if (rag_quality === 0) {
      if (jurisdiction_expected === "UNKNOWN") {
        const clarify =
          "Avant de répondre, je n’ai pas trouvé d’extraits pertinents dans le corpus.\n" +
          "1) Quelle juridiction veux-tu appliquer (QC / CA-FED / autre) ?\n" +
          "2) Peux-tu préciser le texte/loi visé (ou un mot-clé/section), ou le contexte exact (ex: travail, pénal, soins) ?";

        await supaPost("/rest/v1/logs", {
          question: message,
          profile_slug: profile ?? null,
          top_ids: finalRows.map((r) => r.id),
          response: {
            answer: clarify,
            sources,
            qa: {
              jurisdiction_expected,
              jurisdiction_selected,
              rag_quality,
              article_confidence,
              refused_reason: "rag_quality_0_clarify_unknown",
            },
          },
          usage: { mode, top_k, latency_ms: Date.now() - startedAt, debugPasses },
          user_id: user.id,
        }).catch((e) => console.warn("log insert failed:", e));

        return json(
          {
            answer: clarify,
            sources: [],
            usage: {
              type: "clarify",
              jurisdiction_expected,
              jurisdiction_selected,
              rag_quality,
              had_qc_source: false,
              article_confidence,
            },
          },
          { status: 200, headers: CORS_HEADERS }
        );
      }

      const refusal =
        "Information non disponible dans le corpus actuel. Pour répondre avec certitude, il faut ingérer :\n" +
        "- la loi / le règlement applicable (avec juridiction)\n" +
        "- l’article précis si tu en as un\n" +
        "- ou la décision/jurisprudence pertinente\n";

      await supaPost("/rest/v1/logs", {
        question: message,
        profile_slug: profile ?? null,
        top_ids: finalRows.map((r) => r.id),
        response: {
          answer: refusal,
          sources,
          qa: {
            jurisdiction_expected,
            jurisdiction_selected,
            rag_quality,
            article_confidence,
            refused_reason: "rag_quality_0_refuse",
          },
        },
        usage: { mode, top_k, latency_ms: Date.now() - startedAt, debugPasses },
        user_id: user.id,
      }).catch((e) => console.warn("log insert failed:", e));

      return json(
        {
          answer: refusal,
          sources: [],
          usage: {
            type: "refuse",
            jurisdiction_expected,
            jurisdiction_selected,
            rag_quality,
            had_qc_source: false,
            article_confidence,
          },
        },
        { status: 200, headers: CORS_HEADERS }
      );
    }

    const warning =
      rag_quality === 2
        ? "Contexte partiel : je réponds prudemment selon les extraits disponibles."
        : rag_quality === 1
          ? "Contexte faible : réponse limitée (il manque probablement des sources clés)."
          : undefined;

    // ✅ Allowlist by source IDs (robust)
    const allowed_source_ids: string[] = sources.map((s) => String(s.id));

    const context =
      sources
        .map(
          (s) =>
            `SOURCE id=${s.id}\nCitation: ${s.citation}\nJuridiction: ${s.jur}\nURL: ${s.url ?? ""}\nExtrait:\n${s.snippet ?? ""}`
        )
        .join("\n---\n") || "(aucun extrait)";

    const userPayload = [
      `Question: ${message}`,
      `Juridiction attendue (heuristique): ${jurisdiction_expected}`,
      `Juridiction sélectionnée (sources dominantes): ${jurisdiction_selected}`,
      `Contexte:\n${context}`,
      `allowed_source_ids:\n${allowed_source_ids.map((id) => `- ${id}`).join("\n") || "(vide)"}`,
      "",
      "EXIGENCES:",
      "- Réponse en ILAC/IRAC très structurée, claire.",
      "- Tu ne peux utiliser QUE les sources ci-dessus.",
      "- Réponse partielle permise si une sous-question n’est pas couverte (et indique ingest_needed).",
      "",
      "INSTRUCTIONS DE SORTIE (JSON strict):",
      `Réponds en JSON uniquement:
{
  "type": "answer" | "clarify" | "refuse",
  "jurisdiction": "QC" | "CA-FED" | "OTHER" | "UNKNOWN",
  "domain": "Civil" | "Travail" | "Admin" | "Penal" | "Sante" | "Fiscal" | "Autre" | "Inconnu",
  "ilac": { "probleme": "...", "regle": "...", "application": "...", "conclusion": "..." },
  "source_ids_used": ["..."],
  "partial": false,
  "warning": "...",
  "ingest_needed": ["..."],
  "refusal_reason": "...",
  "clarification_question": "..."
}
IMPORTANT:
- source_ids_used doit être un sous-ensemble exact de allowed_source_ids.
- Si tu ne peux pas soutenir une règle clé avec une source: type="refuse" (ou "clarify" si un fait critique manque).`,
    ].join("\n\n");

    const completion = await createChatCompletion([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPayload },
    ]);

    const parsed = safeJsonParse<ModelJson>(completion.content);

    // Post-check serveur: JSON must parse
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
            jurisdiction_expected,
            jurisdiction_selected,
            rag_quality,
            article_confidence,
            refused_reason: "json_parse_failed",
          },
        },
        usage: { mode, top_k, latency_ms: Date.now() - startedAt, openai_usage: completion.usage ?? null, debugPasses },
        user_id: user.id,
      }).catch((e) => console.warn("log insert failed:", e));

      return json({ answer: refusal, sources: [], usage: { type: "refuse", rag_quality } }, { status: 200, headers: CORS_HEADERS });
    }

    if (warning && parsed.type === "answer") parsed.warning = warning;

    // Hard rule: if "answer", must cite at least 1 allowed source id
    if (parsed.type === "answer" && (!parsed.source_ids_used || parsed.source_ids_used.length === 0)) {
      parsed.type = "refuse";
      parsed.refusal_reason = "Information non disponible dans le corpus actuel. (Réponse sans source_ids_used détectée)";
      parsed.ingest_needed = [
        "Ajouter au corpus les textes exacts (loi + juridiction) nécessaires pour soutenir la règle et les distinctions demandées.",
      ];
    }

    const allow = enforceAllowedSourceIds(parsed, allowed_source_ids);
    if (!allow.ok) {
      const refusal =
        "Je ne peux pas répondre de façon fiable (sources hors allowlist détectées). " +
        "Information non disponible dans le corpus actuel. Pour répondre avec certitude, il faut ingérer : " +
        "- ajouter les sources manquantes au corpus (loi/article/jurisprudence).";

      await supaPost("/rest/v1/logs", {
        question: message,
        profile_slug: profile ?? null,
        top_ids: finalRows.map((r) => r.id),
        response: {
          answer: refusal,
          sources,
          bad_source_ids: allow.bad,
          qa: {
            jurisdiction_expected,
            jurisdiction_selected: parsed.jurisdiction,
            rag_quality,
            article_confidence,
            refused_reason: "allowlist_violation",
          },
        },
        usage: { mode, top_k, latency_ms: Date.now() - startedAt, openai_usage: completion.usage ?? null, debugPasses },
        user_id: user.id,
      }).catch((e) => console.warn("log insert failed:", e));

      return json({ answer: refusal, sources: [], usage: { type: "refuse", rag_quality } }, { status: 200, headers: CORS_HEADERS });
    }

    const answer = formatAnswerFromModel(parsed, sources, warning);

    // Log QA
    await supaPost("/rest/v1/logs", {
      question: message,
      profile_slug: profile ?? null,
      top_ids: finalRows.map((r) => r.id),
      response: {
        answer,
        sources,
        qa: {
          jurisdiction_expected,
          jurisdiction_selected,
          rag_quality,
          article_confidence,
          refused_reason: parsed.type === "refuse" ? parsed.refusal_reason ?? null : null,
        },
      },
      usage: { mode, top_k, latency_ms: Date.now() - startedAt, openai_usage: completion.usage ?? null, debugPasses },
      user_id: user.id,
    }).catch((e) => console.warn("log insert failed:", e));

    // ✅ Phase 3 response contract
    return json(
      {
        answer,
        sources,
        usage: {
          type: parsed.type,
          jurisdiction_expected,
          jurisdiction_selected,
          rag_quality,
          had_qc_source: sources.some((s) => normalizeJurisdiction(s.jur ?? "") === "QC"),
          article_confidence,
        },
      },
      { status: 200, headers: CORS_HEADERS }
    );
  } catch (e: any) {
    console.error("chat route error:", e);
    return json({ error: e?.message ?? "Unknown error" }, { status: 500, headers: CORS_HEADERS });
  }
}
