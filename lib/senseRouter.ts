// lib/senseRouter.ts
type Domain = "Civil" | "Travail" | "Sante" | "Penal" | "Fiscal" | "Admin" | "Autre" | "Inconnu";
type Jurisdiction = "QC" | "CA-FED" | "OTHER" | "UNKNOWN";

export type SenseRouterResult = {
  selected_sense_key: string;
  term: string;
  domain_override?: Domain;
  jurisdiction_hint?: Jurisdiction;
  expandedQuery_override?: string;
  should_clarify?: boolean;
  clarify_question?: string;
  debug?: any;
};

type LegalSense = {
  id: string;
  term: string;
  sense_key: string;
  domain: Domain;
  jurisdiction_hint: Jurisdiction | null;
  description: string;
  canonical_query: string;
  course_slugs: string[] | null;
  embedding?: number[] | null; // if you fetch it as array (depends on API)
};

type Trigger = { sense_id: string; type: "pos" | "neg"; pattern: string; weight: number };

const HIGH_RISK_TERMS = new Set([
  "consentement",
  "capacité",
  "capacite",
  "sanction",
  "nullité",
  "nullite",
  "responsabilité",
  "responsabilite",
  "preuve",
  "compétence",
  "competence",
  "appel",
]);

function tokenize(s: string) {
  const base = (s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, ""); // enlève accents

  return base
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}


function containsRiskTerm(message: string) {
  const t = tokenize(message);
  return t.find((w) => HIGH_RISK_TERMS.has(w)) || null;
}

function matchTrigger(pattern: string, message: string) {
  // simple: regex if looks like /.../ else substring token
  const p = (pattern || "").trim();
  if (!p) return false;
  if (p.startsWith("/") && p.endsWith("/")) {
    try {
      const re = new RegExp(p.slice(1, -1), "i");
      return re.test(message);
    } catch {
      return false;
    }
  }
  return message.toLowerCase().includes(p.toLowerCase());
}

function dot(a: number[], b: number[]) {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

function norm(a: number[]) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * a[i];
  return Math.sqrt(s);
}

function cosine(a: number[], b: number[]) {
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return 0;
  return dot(a, b) / (na * nb);
}

export async function senseRouter(args: {
  message: string;
  course_slug: string;
  expandedQuery: string;
  goal_mode: "exam" | "case" | "learn";
  // injected deps (so no coupling)
  supaGet: <T>(path: string) => Promise<T>;
  createEmbedding: (input: string) => Promise<number[] | undefined>;
  microRetrieve: (query_text: string, query_embedding: number[]) => Promise<{ hits: any[] }>;
}): Promise<SenseRouterResult | null> {
  const { message, course_slug, expandedQuery, goal_mode } = args;

  const term = containsRiskTerm(message);
  if (!term) return null;

  const CONTRACT_STRONG = [
  "contrat", "clause", "obligation", "prestation",
  "nullité", "résolution", "résiliation",
  "vice", "erreur", "dol", "violence",
  "mise en demeure", "dommages", "inexécution",
  "c.c.q", "ccq", "l.p.c", "lpc"
];

function hasContractSignals(msg: string) {
  const m = msg.toLowerCase();
  return CONTRACT_STRONG.some((w) => m.includes(w));
}


  // 1) fetch candidate senses for the term
  let senses: LegalSense[] = [];
  try {
    senses = await args.supaGet<LegalSense[]>(
      `/rest/v1/legal_senses?term=eq.${encodeURIComponent(term)}&select=id,term,sense_key,domain,jurisdiction_hint,description,canonical_query,course_slugs`
    );
  } catch {
    return null; // no table / no permission / preview mismatch → don’t break pipeline
  }
  if (!senses.length) return null;

  // 2) triggers (optional)
  let triggers: Trigger[] = [];
  try {
    const inList = senses.map((s) => `"${s.id}"`).join(",");
    triggers = await args.supaGet<Trigger[]>(
      `/rest/v1/legal_sense_triggers?sense_id=in.(${encodeURIComponent(inList)})&select=sense_id,type,pattern,weight`
    );
  } catch {
    triggers = [];
  }

  // 3) base scoring
  const msgEmb = await args.createEmbedding(message).catch(() => undefined);
  const bySense = senses.map((s) => {
    let score = 0;

    // course prior
    if (course_slug && course_slug !== "general") {
      const list = s.course_slugs || [];
      if (list.includes(course_slug)) score += 3.0;
    }

    // trigger score
    for (const tr of triggers) {
      if (tr.sense_id !== s.id) continue;
      if (!matchTrigger(tr.pattern, message)) continue;
      score += (tr.type === "pos" ? 1 : -1) * (tr.weight ?? 1);
    }
// HARD NEGATIVE: si on est clairement en contrats/obligations,
// les sens "Santé" deviennent extrêmement improbables.
if (hasContractSignals(message) && String(s.domain).toLowerCase() === "sante") {
  score -= 1000;
}

    // embedding similarity (if available later)
    // (phase 1: optional, because you may not store embeddings yet)
    // we can approximate with description embedding computed on the fly:
    return { s, score };
  });

  bySense.sort((a, b) => b.score - a.score);
  const top2 = bySense.slice(0, 2);

  // 4) retrieval-as-disambiguation
const evalOne = async (sense: LegalSense) => {
  const q = `${sense.canonical_query}\n\n${expandedQuery}`;
  const emb = await args.createEmbedding(q).catch(() => undefined);
  if (!emb) return { hitScore: 0, jurScore: 0, total: 0, q };

  const { hits } = await args.microRetrieve(q, emb).catch(() => ({ hits: [] as any[] }));
  const jurHint = sense.jurisdiction_hint;

  // --- Jurisdiction evidence ---
  let jurOk = 0;
  for (const h of hits) {
    const j = String(h.jurisdiction_norm || "").toUpperCase();
    if (!jurHint) continue;
    if (jurHint === "QC" && j.includes("QC")) jurOk++;
    if (jurHint === "CA-FED" && (j.includes("CA") || j.includes("FED"))) jurOk++;
  }

  // --- “Neighbourhood” evidence (Civil vs Santé) ---
  const blob = (hits ?? [])
    .map((h) => `${h.citation ?? ""} ${h.title ?? ""} ${h.text ?? ""} ${h.content ?? ""}`)
    .join(" | ")
    .toLowerCase();

  const looksCivil =
    /ccq|c\.c\.q|lpc|l\.p\.c|contrat|obligation|nullit|dol|erreur|violence|clause/.test(blob);

  const looksHealth =
    /soin|sant|h[oô]pital|clsc|m[eé]dec|infirm|patient|aptitud|consentement aux soins/.test(blob);

  // --- Scoring ---
  const hitScore = Math.min(10, hits.length);
  let evidence = 0;
  evidence += looksCivil ? 2 : 0;
  evidence -= looksHealth ? 2 : 0;

  const total = hitScore + 0.6 * jurOk + evidence;

  return { hitScore, jurScore: jurOk, total, q };
};


  const a = await evalOne(top2[0].s);
  const b = top2[1] ? await evalOne(top2[1].s) : null;

  let winner = top2[0].s;
  let margin = 999;

  if (b) {
    // combine heuristic + retrieval evidence
    const scoreA = top2[0].score + a.total;
    const scoreB = top2[1].score + b.total;
    margin = Math.abs(scoreA - scoreB);
    winner = scoreA >= scoreB ? top2[0].s : top2[1].s;
  }

  // 5) should clarify?
  const isShort = tokenize(message).length <= 6;
  const shouldClarify = Boolean(b) && isShort && margin < 1.5 && goal_mode !== "exam";

  if (shouldClarify) {
    // single best clarifier
    const clar = term === "consentement"
      ? "Quand tu dis « consentement », tu parles du consentement **au contrat** (erreur/dol/violence, CCQ) ou du consentement **aux soins** (aptitude, décision médicale) ?"
      : `Quand tu dis « ${term} », c’est dans quel contexte (contrat, santé, pénal, travail) ?`;

    return {
      selected_sense_key: winner.sense_key,
      term,
      should_clarify: true,
      clarify_question: clar,
      debug: { margin, top: top2.map(x => ({ sense_key: x.s.sense_key, score: x.score })), a, b },
    };
  }

  return {
    selected_sense_key: winner.sense_key,
    term,
    domain_override: winner.domain,
    jurisdiction_hint: (winner.jurisdiction_hint ?? undefined) as any,
    expandedQuery_override: winner.canonical_query ? `${winner.canonical_query}\n\n${expandedQuery}` : expandedQuery,
    debug: { margin, top: top2.map(x => ({ sense_key: x.s.sense_key, score: x.score })), a, b },
  };
}
