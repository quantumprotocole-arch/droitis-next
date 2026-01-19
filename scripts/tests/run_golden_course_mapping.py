import os
import json
import sys
from dotenv import load_dotenv
from supabase import create_client

def load_env():
    load_dotenv(".env")
    load_dotenv(".env.local")
    load_dotenv()

def get_supabase():
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        raise RuntimeError("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env/.env.local")
    return create_client(url, key)

def main():
    if len(sys.argv) < 2:
        print("Usage: python scripts/tests/run_golden_course_mapping.py tests/golden_courses.json")
        sys.exit(2)

    path = sys.argv[1]
    raw = open(path, "r", encoding="utf-8").read()
    golden = json.loads(raw)

    load_env()
    supabase = get_supabase()

    failures = []

    for g in golden:
        course_slug = g["course_slug"]
        must_have = set(g.get("must_have_code_ids", []))

        # mapped laws for course
        rows = (
            supabase.table("course_law_requirements")
            .select("law_key, canonical_code_id")
            .eq("course_slug", course_slug)
            .execute()
            .data
        ) or []

        mapped_codes = {r["canonical_code_id"] for r in rows if r.get("canonical_code_id")}
        missing_codes = sorted(list(must_have - mapped_codes))
        if missing_codes:
            failures.append(f"[{course_slug}] missing canonical_code_id(s): {missing_codes}")

        # check ingested content exists in legal_vectors for each mapped canonical_code_id
        for code_id in sorted(mapped_codes):
            cnt = (
                supabase.table("legal_vectors")
                .select("id", count="exact")
                .eq("code_id", code_id)
                .limit(1)
                .execute()
                .count
            )
            if not cnt or cnt == 0:
                failures.append(f"[{course_slug}] code_id={code_id} has 0 rows in legal_vectors")

    if failures:
        print("\n[FAILED] Golden tests failed:")
        for f in failures:
            print(" -", f)
        sys.exit(1)

    print("[OK] Golden tests passed.")
    sys.exit(0)

if __name__ == "__main__":
    main()
