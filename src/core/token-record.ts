import { InvalidTokenRecordError } from "./errors";
import type { TokenRecord } from "./types";

export function assertTokenRecord(
  value: unknown,
  context = "Token record",
): asserts value is TokenRecord {
  const fields: string[] = [];

  if (!isRecord(value)) {
    throw new InvalidTokenRecordError(`${context}: expected an object`, ["record"]);
  }

  if (typeof value.accessToken !== "string" || value.accessToken.trim() === "") {
    fields.push("accessToken is missing");
  }
  if (
    value.refreshToken !== undefined &&
    (typeof value.refreshToken !== "string" || value.refreshToken.trim() === "")
  ) {
    fields.push("refreshToken must be a non-empty string when present");
  }
  if (
    value.expiresAt !== undefined &&
    (typeof value.expiresAt !== "number" || !Number.isFinite(value.expiresAt))
  ) {
    fields.push("expiresAt must be a finite number when present");
  }
  if (value.tokenType !== undefined && typeof value.tokenType !== "string") {
    fields.push("tokenType must be a string when present");
  }
  if (
    value.scopes !== undefined &&
    (!Array.isArray(value.scopes) ||
      value.scopes.some((scope) => typeof scope !== "string"))
  ) {
    fields.push("scopes must be an array of strings when present");
  }
  if (value.metadata !== undefined && !isRecord(value.metadata)) {
    fields.push("metadata must be an object when present");
  }

  if (fields.length > 0) {
    throw new InvalidTokenRecordError(`${context}: ${fields.join(", ")}`, fields);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
