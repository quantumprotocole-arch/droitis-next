import os
import re
import json
import argparse
import unicodedata
from pathlib import Path
from typing import Dict, Any, List, Tuple, Optional

from dotenv import load_dotenv
from supabase import create_client


# ----------------------------
# ENV / SUPABASE
# ----------------------------

def load_env() -> None:
    """
    Charge .env et .env.local depuis la racine du repo, peu importe d'où tu lances.
    On suppose que ce script est: scripts/ingest/seed_course_law_requirements.py
    """
    here = Path(__file__).resolve()
    repo_root = here.parents[2]  # .../droitis-next
    load_dotenv(repo_root / ".env")
    load_dotenv(repo_root / ".env.local")
    # fallback
    load_dotenv()


def get_supabase():
    supabase_url = os.getenv("SUPABASE_URL")
    supabase_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not supabase_url or not supabase_key:
        raise RuntimeError(
            "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.\n"
            "→ Mets-les dans .env / .env.local (à la racine du repo) OU set dans PowerShell:\n"
            '$env:SUPABASE_URL="..."\n'
            '$env:SUPABASE_SERVICE_ROLE_KEY="..."\n'
        )
    return create_client(supabase_url, supabase_key)


# ----------------------------
# NORMALIZATION
# ----------------------------

def normalize_course_key(s: str) -> str:
    if not s:
        return ""
    s = s.strip().lower()

    # supprime accents
    s = unicodedata.normalize("NFD", s)
    s = "".join(ch for ch in s if unicodedata.category(ch) != "Mn")

    # nettoie whitespace + tirets
    s = s.replace("\n", " ").replace("\r", " ").replace("\t", " ")
    s = re.sub(r"\s+", " ", s).strip()
    s = re.sub(r"\s*-\s*", "-", s)  # "a - b" -> "a-b"
    s = re.sub(r"[_/|]+", "-", s)   # rapproche des slugs
    s = re.sub(r"[^\w-]", "-", s)   # enlève ponctuation -> "-"
    s = re.sub(r"-{2,}", "-", s).strip("-")
    return s


def normalize_law_key(s: str) -> str:
    return (s or "").strip()


# ----------------------------
# DB LOADERS
# ----------------------------

def build_course_lookup(supabase) -> Tuple[Dict[str, str], set]:
    """
    normalized_key -> course_slug
    + set des slugs existants
    """
    lookup: Dict[str, str] = {}

    catalog = supabase.table("course_catalog").select("course_slug, course_title").execute().data or []
    aliases = supabase.table("course_aliases").select("course_slug, alias").execute().data or []

    existing_slugs = set()

    for c in catalog:
        slug = c["course_slug"]
        existing_slugs.add(slug)

        # slug direct + normalisé
        lookup[slug] = slug
        lookup[normalize_course_key(slug)] = slug

        title = c.get("course_title")
        if title:
            lookup[normalize_course_key(title)] = slug

    for a in aliases:
        slug = a["course_slug"]
        alias = a.get("alias")
        if alias:
            lookup[alias] = slug
            lookup[normalize_course_key(alias)] = slug

    return lookup, existing_slugs


LAW_KEY_ALIASES = {
    # alias courants
    "ccq": "ccq_qc",
    "cpc": "cpc_qc",
    # ajoute au besoin…
}


def load_law_registry_map(supabase) -> Dict[str, Dict[str, Any]]:
    """
    law_key -> {canonical_code_id, status, jurisdiction, jurisdiction_bucket, title}
    (pas de colonne citation dans ton schéma)
    """
    rows = (
        supabase.table("law_registry")
        .select("law_key, canonical_code_id, status, jurisdiction, jurisdiction_bucket, title")
        .execute()
        .data
    ) or []

    m: Dict[str, Dict[str, Any]] = {}
    for r in rows:
        lk = normalize_law_key(r.get("law_key"))
        if not lk:
            continue
        m[lk] = {
            "law_key": lk,
            "canonical_code_id": (r.get("canonical_code_id") or "").strip(),
            "status": (r.get("status") or "").strip(),
            "jurisdiction": (r.get("jurisdiction") or "").strip(),
            "jurisdiction_bucket": (r.get("jurisdiction_bucket") or "").strip(),
            "title": r.get("title"),
        }
    return m


def resolve_law(law_key: str, law_map: Dict[str, Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """
    Résout la loi via law_registry, avec alias.
    Retourne None si introuvable.
    """
    lk = normalize_law_key(law_key)
    if not lk:
        return None

    # direct
    if lk in law_map:
        return law_map[lk]

    # alias
    alt = LAW_KEY_ALIASES.get(lk)
    if alt and alt in law_map:
        return law_map[alt]

    return None


def auto_create_law_registry_row(
    supabase,
    law_key: str,
    title: Optional[str],
    jurisdiction: Optional[str],
) -> Dict[str, Any]:
    """
    Crée une entrée minimale dans law_registry, pour éviter de SKIP le mapping.
    IMPORTANT: canonical_code_id est NOT NULL dans ton schéma => on met une valeur non vide.
    Ici, on met canonical_code_id = law_key (fallback sûr).
    """
    lk = normalize_law_key(law_key)
    jur = (jurisdiction or "OTHER").strip() or "OTHER"

    # ton CHECK accepte: QC, CA-FED, CA, OTHER
    if jur not in ("QC", "CA-FED", "CA", "OTHER"):
        jur = "OTHER"

    row = {
        "law_key": lk,
        "canonical_code_id": lk,              # fallback non-null
        "jurisdiction": jur,
        "jurisdiction_bucket": jur,           # simple (tu peux raffiner plus tard)
        "title": title,
        "status": "to_ingest",
        "source_url": None,
    }

    supabase.table("law_registry").upsert(row, on_conflict="law_key").execute()
    return {
        "law_key": lk,
        "canonical_code_id": lk,
        "status": "to_ingest",
        "jurisdiction": jur,
        "jurisdiction_bucket": jur,
        "title": title,
    }


# ----------------------------
# MAPPING PARSER
# ----------------------------

def parse_mapping_file(raw: str) -> Dict[str, Dict[str, Any]]:
    """
    Accepte:
    - JSON dict directement
    - ou TS-like: "course_key": { required: [ { law_key: "..." }, ... ], recommended: [...] }
    """
    raw = raw.strip()

    # 1) JSON direct
    try:
        obj = json.loads(raw)
        if isinstance(obj, dict):
            return obj
    except Exception:
        pass

    # 2) TS-like minimaliste
    out: Dict[str, Dict[str, Any]] = {}

    course_blocks = list(re.finditer(r'"([^"]+)"\s*:\s*{', raw, flags=re.S))
    if not course_blocks:
        raise RuntimeError(
            "Mapping file: aucune clé de cours détectée.\n"
            'Format attendu: "course_key": { required: [...], recommended: [...] }\n'
            "Astuce: assure-toi que tes clés de cours sont entre guillemets doubles."
        )

    starts = [(m.group(1), m.start()) for m in course_blocks]

    for idx, (course_key, start_pos) in enumerate(starts):
        end_pos = starts[idx + 1][1] if idx + 1 < len(starts) else len(raw)
        block = raw[start_pos:end_pos]

        def extract_array(name: str) -> List[Dict[str, Any]]:
            m = re.search(rf"{name}\s*:\s*\[(.*?)\]\s*,?", block, flags=re.S)
            if not m:
                return []
            body = m.group(1)

            items: List[Dict[str, Any]] = []
            for om in re.finditer(r"\{(.*?)\}", body, flags=re.S):
                obj_txt = om.group(1)

                law_key_m = (
                    re.search(r'law_key\s*:\s*"([^"]+)"', obj_txt)
                    or re.search(r'"law_key"\s*:\s*"([^"]+)"', obj_txt)
                )
                if not law_key_m:
                    continue

                title_m = (
                    re.search(r'title\s*:\s*"([^"]+)"', obj_txt)
                    or re.search(r'"title"\s*:\s*"([^"]+)"', obj_txt)
                )
                jur_m = (
                    re.search(r'jurisdiction\s*:\s*"([^"]+)"', obj_txt)
                    or re.search(r'"jurisdiction"\s*:\s*"([^"]+)"', obj_txt)
                )

                items.append({
                    "law_key": law_key_m.group(1).strip(),
                    "title": title_m.group(1).strip() if title_m else None,
                    "jurisdiction": jur_m.group(1).strip() if jur_m else None,
                })
            return items

        notes_m = (
            re.search(r'notes\s*:\s*"([^"]*)"', block, flags=re.S)
            or re.search(r'"notes"\s*:\s*"([^"]*)"', block, flags=re.S)
        )

        out[course_key] = {
            "required": extract_array("required"),
            "recommended": extract_array("recommended"),
            "notes": notes_m.group(1) if notes_m else None,
        }

    return out


# ----------------------------
# UPSERT
# ----------------------------

def upsert_course_law_requirements(supabase, rows: List[Dict[str, Any]], batch_size: int = 500) -> None:
    """
    Ton schéma:
      - PK (course_slug, law_key)
      - canonical_code_id NOT NULL
      - priority CHECK(required/recommended)
      - status CHECK(to_ingest/ingested)
      - rank int
      - requirement_type nullable
    """
    if not rows:
        return

    for i in range(0, len(rows), batch_size):
        batch = rows[i:i + batch_size]
        supabase.table("course_law_requirements").upsert(
            batch,
            on_conflict="course_slug,law_key"
        ).execute()


# ----------------------------
# BUILD ROWS (ROBUST)
# ----------------------------

def build_rows(
    mapping: Dict[str, Dict[str, Any]],
    course_lookup: Dict[str, str],
    law_map: Dict[str, Dict[str, Any]],
    supabase,
    auto_create_laws: bool,
) -> Tuple[List[Dict[str, Any]], List[str], List[Tuple[str, str]], List[Tuple[str, str]]]:
    """
    Retourne:
      - rows (dédupliquées par (course_slug, law_key))
      - unresolved_courses
      - missing_laws (course_slug, law_key)
      - created_laws (course_slug, law_key)  # celles ajoutées à law_registry
    """
    # required gagne sur recommended si conflit dans un même cours
    weight = {"required": 2, "recommended": 1}

    rows_by_pair: Dict[Tuple[str, str], Dict[str, Any]] = {}
    unresolved_courses: List[str] = []
    missing_laws: List[Tuple[str, str]] = []
    created_laws: List[Tuple[str, str]] = []

    for course_key_raw, payload in mapping.items():
        ck_raw = (course_key_raw or "").strip()
        # 1) tentative directe
        course_slug = course_lookup.get(ck_raw)

        # 2) tentative normalisée
        if not course_slug:
            course_slug = course_lookup.get(normalize_course_key(ck_raw))

        if not course_slug:
            unresolved_courses.append(course_key_raw)
            continue

        for req_type in ("required", "recommended"):
            items = payload.get(req_type) or []
            for idx, it in enumerate(items, start=1):
                lk_raw = normalize_law_key(it.get("law_key"))
                if not lk_raw:
                    continue

                reg = resolve_law(lk_raw, law_map)

                if not reg and auto_create_laws:
                    # crée dans law_registry et recharge dans map locale
                    created = auto_create_law_registry_row(
                        supabase=supabase,
                        law_key=LAW_KEY_ALIASES.get(lk_raw, lk_raw),
                        title=it.get("title"),
                        jurisdiction=it.get("jurisdiction"),
                    )
                    law_map[created["law_key"]] = created
                    reg = created
                    created_laws.append((course_slug, created["law_key"]))

                if not reg:
                    missing_laws.append((course_slug, lk_raw))
                    continue

                canonical_code_id = (reg.get("canonical_code_id") or "").strip()
                if not canonical_code_id:
                    # sécurité: ne bloque pas tout, mais log
                    missing_laws.append((course_slug, reg["law_key"]))
                    continue

                lr_stat = (reg.get("status") or "").strip()
                status = "ingested" if lr_stat == "ingested" else "to_ingest"

                pair_key = (course_slug, reg["law_key"])

                new_row = {
                    "course_slug": course_slug,
                    "law_key": reg["law_key"],
                    "canonical_code_id": canonical_code_id,
                    "priority": req_type,             # colonne CHECK required/recommended
                    "rank": idx,                      # ordre dans la liste
                    "status": status,                 # to_ingest/ingested
                    "requirement_type": req_type,     # optionnel mais utile
                }

                existing = rows_by_pair.get(pair_key)
                if not existing:
                    rows_by_pair[pair_key] = new_row
                else:
                    # required > recommended
                    if weight[new_row["priority"]] > weight[existing["priority"]]:
                        rows_by_pair[pair_key] = new_row
                    # si même type, garde le meilleur rang (plus petit)
                    elif new_row["priority"] == existing["priority"] and new_row["rank"] < existing["rank"]:
                        rows_by_pair[pair_key] = new_row

    return list(rows_by_pair.values()), unresolved_courses, missing_laws, created_laws


# ----------------------------
# MAIN
# ----------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mapping", required=True, help="Chemin vers le fichier mapping (txt/json)")
    ap.add_argument("--dry-run", action="store_true", help="Ne fait pas l'upsert, affiche juste le résumé")
    ap.add_argument(
        "--no-auto-create-law-registry",
        action="store_true",
        help="Désactive la création automatique des lois manquantes dans law_registry.",
    )
    args = ap.parse_args()

    load_env()
    supabase = get_supabase()

    # charge mapping
    mapping_path = Path(args.mapping)
    if not mapping_path.is_file():
        # si on passe un chemin relatif bizarre, essaie depuis repo root
        repo_root = Path(__file__).resolve().parents[2]
        alt = repo_root / args.mapping.lstrip("\\/")  # enlève \scripts\... etc
        if alt.is_file():
            mapping_path = alt
        else:
            raise FileNotFoundError(f"Mapping introuvable: {args.mapping} (essayé aussi: {alt})")

    raw = mapping_path.read_text(encoding="utf-8", errors="replace")
    mapping = parse_mapping_file(raw)

    course_lookup, _existing_slugs = build_course_lookup(supabase)
    law_map = load_law_registry_map(supabase)

    auto_create_laws = not args.no_auto_create_law_registry

    rows, unresolved_courses, missing_laws, created_laws = build_rows(
        mapping=mapping,
        course_lookup=course_lookup,
        law_map=law_map,
        supabase=supabase,
        auto_create_laws=auto_create_laws,
    )

    # Résumé
    print(f"[SUMMARY] mapping_courses={len(mapping)}")
    print(f"[SUMMARY] rows_to_upsert={len(rows)}")
    print(f"[SUMMARY] unresolved_courses={len(unresolved_courses)}")
    print(f"[SUMMARY] missing_laws_skipped={len(missing_laws)}")
    print(f"[SUMMARY] auto_created_law_registry={len(created_laws)} (enabled={auto_create_laws})")

    if args.dry_run:
        print("[DRY-RUN] Aucun upsert exécuté.")
    else:
        upsert_course_law_requirements(supabase, rows)
        print("[OK] Upsert completed.")

    # Logs utiles
    if unresolved_courses:
        print("\n[WARN] Cours non résolus (ajoute un alias dans course_aliases ou corrige la clé):")
        for k in unresolved_courses[:100]:
            print(" -", k)
        if len(unresolved_courses) > 100:
            print(f" ... +{len(unresolved_courses)-100} autres")

    if missing_laws:
        print("\n[WARN] law_key absents de law_registry (SKIP si auto-create désactivé):")
        for cs, lk in missing_laws[:100]:
            print(f" - {cs}: {lk}")
        if len(missing_laws) > 100:
            print(f" ... +{len(missing_laws)-100} autres")

    if created_laws:
        print("\n[INFO] Lois créées dans law_registry (fallback canonical_code_id=law_key):")
        for cs, lk in created_laws[:100]:
            print(f" + {cs}: {lk}")
        if len(created_laws) > 100:
            print(f" ... +{len(created_laws)-100} autres")

    print("\n[DONE]")


if __name__ == "__main__":
    main()
