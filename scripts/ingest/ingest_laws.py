import os
import re
import time
from typing import List, Dict, Any, Tuple
from datetime import datetime, timezone
from urllib.parse import urlparse

import requests
from bs4 import BeautifulSoup
from dotenv import load_dotenv
from supabase import create_client
from postgrest.exceptions import APIError

load_dotenv()

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

HEADERS = {
    "User-Agent": "droitis-ingester/1.0",
    "Accept-Language": "fr-CA,fr;q=0.9,en;q=0.7",
}

ONLY_LAW_KEY = os.environ.get("ONLY_LAW_KEY")      # ex: "cpc_qc"
ONLY_JURISDICTION = os.environ.get("ONLY_JURISDICTION")  # ex: "CA-FED" ou "QC"

# -----------------------------
# Common helpers
# -----------------------------

def fetch_html(url: str) -> str:
    r = requests.get(url, headers=HEADERS, timeout=90)
    r.raise_for_status()
    # Justice Laws est parfois mal “détecté” → force utf-8 si besoin
    if not r.encoding:
        r.encoding = "utf-8"
    return r.text


def normalize_text(s: str) -> str:
    return (s or "").replace("\xa0", " ").strip()

def extract_main_text(html: str) -> str:
    soup = BeautifulSoup(html, "lxml")
    for tag in soup(["script", "style", "noscript"]):
        tag.decompose()
    for tag in soup.find_all(["header", "footer", "nav", "aside"]):
        tag.decompose()
    main = soup.find("main") or soup.body
    text = main.get_text("\n", strip=True) if main else soup.get_text("\n", strip=True)
    return normalize_text(text)

def dedupe_rows(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Dédoublonne sur (code_id, jurisdiction, citation).
    Si doublon: garde le texte le plus long.
    """
    best: Dict[Tuple[str, str, str], Dict[str, Any]] = {}
    for r in rows:
        key = (r["code_id"], r["jurisdiction"], r["citation"])
        if key not in best or len(r.get("text") or "") > len(best[key].get("text") or ""):
            best[key] = r
    return list(best.values())

def upsert_legal_vectors(rows: List[Dict[str, Any]], batch_size: int = 100):
    rows = dedupe_rows(rows)
    for i in range(0, len(rows), batch_size):
        batch = rows[i:i + batch_size]
        try:
            supabase.table("legal_vectors").upsert(
                batch,
                on_conflict="code_id,jurisdiction,citation"
            ).execute()
        except APIError as e:
            sample = [b.get("citation") for b in batch[:5]]
            raise RuntimeError(
                f"Upsert failed on batch starting at {i}. Sample citations={sample}. APIError={e}"
            ) from e

def mark_ingested(law_key: str):
    supabase.table("law_registry").update({
        "status": "ingested",
        "last_ingested_at": datetime.now(timezone.utc).isoformat(),
    }).eq("law_key", law_key).execute()

# -----------------------------
# QC parser (LegisQuebec)
# -----------------------------

ARTICLE_RE_QC_DOT = re.compile(r"(?m)^\s*(\d+(?:\.\d+)?)\s*\.\s+")
ARTICLE_RE_QC_WORD = re.compile(r"(?mi)^\s*Article\s+(\d+(?:\.\d+)?)\s*$")

def parse_legisquebec_articles(html: str, code_id: str, jurisdiction: str, bucket: str) -> List[Dict[str, Any]]:
    text = extract_main_text(html)

    matches = list(ARTICLE_RE_QC_DOT.finditer(text))
    if not matches:
        matches = list(ARTICLE_RE_QC_WORD.finditer(text))
        mode = "word"
    else:
        mode = "dot"

    if not matches:
        return []

    rows: List[Dict[str, Any]] = []
    for i, m in enumerate(matches):
        art_num = m.group(1)
        start = m.start()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        chunk = text[start:end].strip()

        if mode == "dot":
            chunk = re.sub(rf"^\s*{re.escape(art_num)}\s*\.\s+", "", chunk).strip()
        else:
            chunk = re.sub(rf"(?im)^\s*Article\s+{re.escape(art_num)}\s*$", "", chunk).strip()

        if not chunk or len(chunk) < 60:
            continue

        rows.append({
            "code_id": code_id,
            "jurisdiction": jurisdiction,
            "jurisdiction_bucket": bucket,
            "citation": f"art. {art_num} {code_id}",
            "title": None,
            "text": chunk,
        })

    return dedupe_rows(rows)

# -----------------------------
# CA-FED parser (Justice Laws)
# -----------------------------

# Regex fallback si on doit splitter du texte brut:
# Ex: "1 Titre abrégé" / "1 Short title" / "2 Définitions"
SECTION_RE_TEXT = re.compile(r"(?m)^\s*(\d+(?:\.\d+){0,3})\s+([A-Za-zÉÈÊËÀÂÎÏÔÛÜÇ].+)$")

def _is_justice_laws(url: str) -> bool:
    host = (urlparse(url).netloc or "").lower()
    return "laws-lois.justice.gc.ca" in host
def resolve_justice_laws_fulltext_url(index_html: str, current_url: str) -> str | None:
    soup = BeautifulSoup(index_html, "lxml")

    # Cherche un href qui contient TexteComplet.html / textecomplet.html / FullText.html
    candidates = []
    for a in soup.find_all("a", href=True):
        href = a["href"]
        if re.search(r"(TexteComplet|textecomplet|FullText)\.html", href):
            candidates.append(href)

    if not candidates:
        return None

    href = candidates[0]
    # normaliser relative -> absolute
    if href.startswith("http"):
        return href
    if href.startswith("/"):
        return f"https://{urlparse(current_url).netloc}{href}"
    # relative simple
    base = current_url.rstrip("/")
    return f"{base}/{href}"

def parse_justice_laws_sections(html: str, code_id: str, jurisdiction: str, bucket: str) -> List[Dict[str, Any]]:
    """
    Stratégie robuste:
    1) Essayer DOM: repérer les blocs de section via des indices (class/id/data) + numéros.
    2) Si DOM fail: fallback regex sur texte.
    """
    soup = BeautifulSoup(html, "lxml")

    for tag in soup(["script", "style", "noscript"]):
        tag.decompose()

    # On enlève nav/headers/footers pour éviter TOC et menus
    for tag in soup.find_all(["header", "footer", "nav", "aside"]):
        tag.decompose()

    main = soup.find("main") or soup.body
    if not main:
        return []

    rows: List[Dict[str, Any]] = []

    # ---- (A) DOM-based (flexible)
    # On cherche des éléments qui ressemblent à une "section":
    # - id contenant "s-" ou "section"
    # - ou class contenant "section"
    candidates = []
    for el in main.find_all(True):
        el_id = (el.get("id") or "").lower()
        el_cls = " ".join(el.get("class") or []).lower()
        if ("section" in el_cls) or el_id.startswith("s-") or ("section" in el_id):
            candidates.append(el)

    # On essaye d’extraire un numéro de section depuis le texte du candidat
    sec_num_re = re.compile(r"^\s*(\d+(?:\.\d+){0,3})\b")

    seen = set()
    for el in candidates:
        text = normalize_text(el.get_text("\n", strip=True))
        if not text or len(text) < 40:
            continue

        m = sec_num_re.match(text)
        if not m:
            continue

        sec_num = m.group(1)
        key = (code_id, jurisdiction, sec_num)
        if key in seen:
            continue
        seen.add(key)

        # Retire juste le numéro au début, mais garde le reste (titre + contenu)
        body = re.sub(rf"^\s*{re.escape(sec_num)}\b\s*", "", text).strip()
        if len(body) < 60:
            continue

        rows.append({
            "code_id": code_id,
            "jurisdiction": jurisdiction,
            "jurisdiction_bucket": bucket,
            "citation": f"s. {sec_num} {code_id}",
            "title": None,
            "text": body,
        })

    # Si on a un volume correct, on retourne
    if len(rows) >= 20:
        return dedupe_rows(rows)

    # ---- (B) Fallback regex sur texte complet
    text = normalize_text(main.get_text("\n", strip=True))
    matches = list(SECTION_RE_TEXT.finditer(text))
    if not matches:
        return []

    rows = []
    for i, m in enumerate(matches):
        sec_num = m.group(1)
        start = m.start()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        chunk = text[start:end].strip()

        # enlève "X " au début
        chunk = re.sub(rf"^\s*{re.escape(sec_num)}\s+", "", chunk).strip()

        if not chunk or len(chunk) < 60:
            continue

        rows.append({
            "code_id": code_id,
            "jurisdiction": jurisdiction,
            "jurisdiction_bucket": bucket,
            "citation": f"s. {sec_num} {code_id}",
            "title": None,
            "text": chunk,
        })

    return dedupe_rows(rows)

# -----------------------------
# Dispatcher
# -----------------------------

from urllib.parse import urlparse

def parse_by_jurisdiction(html: str, source_url: str, code_id: str, jurisdiction: str, bucket: str) -> List[Dict[str, Any]]:
    if jurisdiction == "QC":
        return parse_legisquebec_articles(html, code_id, jurisdiction, bucket)

    if jurisdiction == "CA-FED":
        # Si l’URL n’est pas déjà “textecomplet/page-x/fulltext”, on essaie de résoudre depuis l’index.
        low = source_url.lower()
        is_full = ("textecomplet.html" in low) or ("fulltext.html" in low) or ("page-" in low)

        if ("laws-lois.justice.gc.ca" in (urlparse(source_url).netloc or "").lower()) and not is_full:
            full_url = resolve_justice_laws_fulltext_url(html, source_url)
            if full_url:
                print(f"[RESOLVE] {source_url} -> {full_url}")
                html = fetch_html(full_url)
                source_url = full_url

        return parse_justice_laws_sections(html, code_id, jurisdiction, bucket)

    return []


def main():
    q = (
        supabase.table("law_registry")
        .select("law_key, canonical_code_id, jurisdiction, jurisdiction_bucket, source_url, status")
        .eq("status", "to_ingest")
    )

    if ONLY_LAW_KEY:
        q = q.eq("law_key", ONLY_LAW_KEY)

    if ONLY_JURISDICTION:
        q = q.eq("jurisdiction", ONLY_JURISDICTION)

    laws = q.execute().data
    if not laws:
        print("No laws with status=to_ingest (respecting filters).")
        return

    for law in laws:
        law_key = law["law_key"]
        code_id = law["canonical_code_id"]
        jurisdiction = law.get("jurisdiction") or "QC"
        bucket = law.get("jurisdiction_bucket") or jurisdiction
        url = law.get("source_url")

        if not url:
            print(f"[SKIP] Missing source_url for {law_key}")
            continue

        print(f"[FETCH] {law_key} ({code_id}) [{jurisdiction}]")
        html = fetch_html(url)

        rows = parse_by_jurisdiction(html, url, code_id, jurisdiction, bucket)

        if len(rows) == 0:
            snippet = extract_main_text(html)[:500].replace("\n", " ")
            raise RuntimeError(f"Parsed 0 rows for {law_key} ({code_id}) [{jurisdiction}]. Snippet: {snippet}")

        rows = dedupe_rows(rows)
        print(f"[PARSE] {law_key}: {len(rows)} chunks (after dedupe)")

        upsert_legal_vectors(rows)
        print(f"[UPSERT] {law_key}: ok")

        mark_ingested(law_key)
        print(f"[DONE] {law_key}: status=ingested")

        time.sleep(0.5)

if __name__ == "__main__":
    main()
