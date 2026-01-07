/* eslint-disable no-console */
import { NextResponse } from "next/server";
import { createClient } from "../../../lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ------------------------------
// Types
// ------------------------------
type Jurisdiction = "QC" | "CA-FED" | "OTHER" | "UNKNOWN";

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
  similarity?: number | null;
  distance?: number | null;
  fts_rank?: number | null;
  score?: number | null;
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

  if (fedSector.matched && !qcStrong) {
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
        "Dis-moi lequel tu veux appliquer, et si tu es **syndiqué** (oui/non).",
    };
  }

  if (fedStrong) return { type: "continue", selected: "CA-FED", reason: "explicit_fed_law" };
  if (qcStrong) return { type: "continue", selected: "QC", reason: "explicit_qc_law" };

  const detected = detectJurisdictionExpected(message);
  return { type: "continue", selected: detected, reason: "heuristic_detected" };
}

// ------------------------------
// Keyword extraction + expansion
// ------------------------------
const STOPWORDS_FR = new Set([
  "alors","aucun","avec","dans","donc","elle","elles","entre","être","mais","même","pour","sans","sont","tout","toute","tous",
  "le","la","les","un","une","des","de","du","au","aux","et","ou","sur","par","que","qui","quoi","dont","est","etre","a","à","en","se","sa","son","ses","ce","cet","cette","ces",
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
    add("diligence");

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

function computeRagQuality(args: { jurisdiction_selected: Jurisdiction; sources: Source[] }): 0 | 1 | 2 | 3 {
  const { jurisdiction_selected, sources } = args;
  const n = sources.length;
  if (n === 0) return 0;

  if (jurisdiction_selected === "UNKNOWN") return n >= 2 ? 2 : 1;

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

// ------------------------------
// NEW: Hybrid RPC search (FTS + vector) — robust payload variants
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
  bucket?: string | null;
}): Promise<HybridHit[]> {
  const rpcName = "search_legal_vectors_hybrid_v2";

  // Variants to survive parameter naming differences (solid production hardening)
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
// Matview REST endpoints (replaces legal_vectors_enriched view)
// ------------------------------
const ENRICHED_RESOURCE = "legal_vectors_enriched_mv";

async function pinByArticleNums(passJur: Jurisdiction, nums: string[], limit: number): Promise<EnrichedRow[]> {
  if (!nums.length) return [];
  let base =
    `/rest/v1/${ENRICHED_RESOURCE}` +
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

// ------------------------------
// Prompt + output checks
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
          details:
            "Le body JSON doit contenir soit { message: string } (Phase 3), soit { question: string }, soit { messages: [{role:'user', content:string}, ...] }.",
        },
        { status: 400 }
      );
    }

    const profile = body.profile ?? null;
    const top_k = Math.max(1, Math.min(body.top_k ?? 5, 20));
    const mode = (body.mode ?? "prod").toLowerCase();

    // ------------------------------
    // Jurisdiction gate
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

      return json({
        answer: clarify,
        sources: [],
        usage: {
          type: "clarify",
          jurisdiction_expected: "UNKNOWN",
          jurisdiction_selected: "UNKNOWN",
          rag_quality: 0,
          had_qc_source: false,
        },
      });
    }

    const jurisdiction_expected = gate.selected;

    // ------------------------------
    // Embedding + hybrid retrieval
    // ------------------------------
    const queryEmbedding = await createEmbedding(message);
    if (!queryEmbedding) return json({ error: "Échec embedding" }, 500);

    const baseKeywords = extractKeywords(message, 10);
    const { keywords, pinnedArticleNums } = expandQuery(message, baseKeywords, jurisdiction_expected);
    const article = detectArticleMention(message);

    // Pin “piliers” (retrieval aid only) — now against matview
    const pinnedRows =
      jurisdiction_expected === "QC" || jurisdiction_expected === "UNKNOWN"
        ? await pinByArticleNums("QC", pinnedArticleNums, 10)
        : [];

    // Call hybrid RPC ONCE (solid core)
    const poolSize = 220;
    let hybridHits: HybridHit[] = [];
    let hybridError: string | null = null;

    try {
      // Optional bucket hint: if you created a bucket system, you can pass it.
      // If the RPC ignores/doesn't accept it, the variant logic will still work.
      hybridHits = await hybridSearchRPC({
        query_text: message,
        query_embedding: queryEmbedding,
        match_count: poolSize,
        bucket: jurisdiction_expected === "UNKNOWN" ? null : jurisdiction_expected,
      });
    } catch (e: any) {
      hybridError = e?.message ?? String(e);
      console.warn("hybridSearchRPC failed; continuing with empty hits:", hybridError);
      hybridHits = [];
    }

    // If RPC failed completely, we still proceed; rag_quality will drop and you’ll get clarify/refuse properly.
    // (If you want a true legacy fallback, tell me and I’ll re-add vector-only RPC as a second path.)

    const passOrder = passOrderFor(jurisdiction_expected);
    const vectorN = 70;

    const allRows: EnrichedRow[] = [];
    const debugPasses: any[] = [];

    for (let i = 0; i < pinnedRows.length; i++) allRows.push(pinnedRows[i]);

    // Pass filtering over RPC results (already fused FTS+vector)
    for (let p = 0; p < passOrder.length; p++) {
      const passJur = passOrder[p];

      const kept: Array<{ row: EnrichedRow; similarity: number | null }> = [];
      for (let i = 0; i < hybridHits.length; i++) {
        const h = hybridHits[i];
        const jur = normalizeJurisdiction(h.jurisdiction_norm);
        const norm: Jurisdiction = jur === "OTHER" ? "OTHER" : jur;
        if (passJur !== "UNKNOWN" && norm !== passJur) continue;

        kept.push({ row: h, similarity: typeof h.similarity === "number" ? h.similarity : null });
        if (kept.length >= vectorN) break;
      }

      // Rank with RRF + quality score (keeps your existing guardrails)
      const fused = new Map<number, { row: EnrichedRow; rrf: number; similarity: number | null }>();
      for (let i = 0; i < kept.length; i++) {
        const it = kept[i];
        fused.set(it.row.id, { row: it.row, rrf: rrfScore(i + 1), similarity: it.similarity });
      }

      const byDedup = new Map<string, { row: EnrichedRow; composite: number }>();
      const values = Array.from(fused.values());

      for (let i = 0; i < values.length; i++) {
        const it = values[i];
        const scored = scoreHit({
          row: it.row,
          expected: jurisdiction_expected,
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

      debugPasses.push({
        passJurisdiction: passJur,
        hybridHitsTotal: hybridHits.length,
        passKept: kept.length,
        dedupUnique: byDedup.size,
        hybridError,
      });

      for (let i = 0; i < ranked.length; i++) allRows.push(ranked[i]);

      if (p === 0 && jurisdiction_expected !== "UNKNOWN") {
        let good = 0;
        const checkN = Math.min(ranked.length, 10);
        for (let i = 0; i < checkN; i++) {
          const s = scoreHit({ row: ranked[i], expected: jurisdiction_expected, keywords, article, similarity: null });
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

    const sources: Source[] = finalRows.map((r) => ({
      id: r.id,
      citation: r.citation,
      title: r.title,
      jur: r.jurisdiction_norm,
      url: r.url_struct,
      snippet: makeExcerpt(`${r.title ?? ""}\n${r.text ?? ""}`, 1100),
    }));

    const jurisdiction_selected = selectJurisdictionFromSources(sources, jurisdiction_expected);
    const rag_quality = computeRagQuality({ jurisdiction_selected, sources });

    let article_confidence = 0;
    const scanN = Math.min(finalRows.length, 6);
    for (let i = 0; i < scanN; i++) {
      const sc = scoreHit({ row: finalRows[i], expected: jurisdiction_expected, keywords, article, similarity: null });
      if (sc.article_conf > article_confidence) article_confidence = sc.article_conf;
    }

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
              hybrid_error: hybridError,
            },
          },
          usage: { mode, top_k, latency_ms: Date.now() - startedAt, debugPasses },
          user_id: user.id,
        }).catch((e) => console.warn("log insert failed:", e));

        return json({
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
        });
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
            hybrid_error: hybridError,
          },
        },
        usage: { mode, top_k, latency_ms: Date.now() - startedAt, debugPasses },
        user_id: user.id,
      }).catch((e) => console.warn("log insert failed:", e));

      return json({
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
      });
    }

    const warning =
      rag_quality === 2
        ? "Contexte partiel : je réponds prudemment selon les extraits disponibles."
        : rag_quality === 1
          ? "Contexte faible : réponse limitée (il manque probablement des sources clés)."
          : undefined;

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
      hybridError ? `HYBRID_RPC_WARNING: ${hybridError}` : "",
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
    ]
      .filter(Boolean)
      .join("\n\n");

    const completion = await createChatCompletion([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPayload },
    ]);

    const parsed = safeJsonParse<ModelJson>(completion.content);

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
            hybrid_error: hybridError,
          },
        },
        usage: { mode, top_k, latency_ms: Date.now() - startedAt, openai_usage: completion.usage ?? null, debugPasses },
        user_id: user.id,
      }).catch((e) => console.warn("log insert failed:", e));

      return json({ answer: refusal, sources: [], usage: { type: "refuse", rag_quality } });
    }

    if (warning && parsed.type === "answer") parsed.warning = warning;

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
            hybrid_error: hybridError,
          },
        },
        usage: { mode, top_k, latency_ms: Date.now() - startedAt, openai_usage: completion.usage ?? null, debugPasses },
        user_id: user.id,
      }).catch((e) => console.warn("log insert failed:", e));

      return json({ answer: refusal, sources: [], usage: { type: "refuse", rag_quality } });
    }

    const answer = formatAnswerFromModel(parsed, sources, warning);

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
          hybrid_error: hybridError,
        },
      },
      usage: { mode, top_k, latency_ms: Date.now() - startedAt, openai_usage: completion.usage ?? null, debugPasses },
      user_id: user.id,
    }).catch((e) => console.warn("log insert failed:", e));

    return json({
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
    });
  } catch (e: any) {
    console.error("chat route error:", e);
    return json({ error: e?.message ?? "Unknown error" }, 500);
  }
}
