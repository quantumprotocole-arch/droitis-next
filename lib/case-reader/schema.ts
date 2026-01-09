import fs from "node:fs";
import path from "node:path";

export function loadCaseReaderSchema(): unknown {
  const p = path.join(process.cwd(), "schemas", "case-reader-v2.schema.json");
  const raw = fs.readFileSync(p, "utf-8");
  return JSON.parse(raw);
}
