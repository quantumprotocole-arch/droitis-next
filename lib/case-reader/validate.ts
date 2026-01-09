import Ajv from "ajv";
import { loadCaseReaderSchema } from "./schema";

const ajv = new Ajv({ allErrors: true, strict: false });

const schema = loadCaseReaderSchema();
const validateFn = ajv.compile(schema);

export function validateCaseReaderOutput(data: unknown): {
  ok: boolean;
  errors?: unknown;
} {
  const ok = validateFn(data) as boolean;
  return ok ? { ok: true } : { ok: false, errors: validateFn.errors };
}
