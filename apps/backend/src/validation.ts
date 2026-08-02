import {
  COMMAND_HTTP_BODY_MAX_BYTES,
  UnattendedSessionRequestSchema,
  type UnattendedSessionRequest,
} from "@understudy/protocol";
import type { z } from "zod";
import { hashProfileStateKey } from "./auth";
import { canonicalOrigin } from "./origin-policy";
import type { Env } from "./types";

export { isLoopback } from "./origin-policy";

export class RequestBodyError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 413 = 400,
    readonly category: "syntax" | "schema" | "size" = "syntax",
  ) {
    super(message);
  }
}

/**
 * True when the request carries no meaningful body.
 *
 * `request.body === null` alone is NOT sufficient to detect "the caller sent no
 * body". That holds only for a Request constructed in-process; the moment a
 * request crosses the wire it is real HTTP, and every client — curl, undici,
 * and a Worker subrequest to a public hostname alike — sends `Content-Length:
 * 0`, which arrives as an empty but non-null stream. Attended session creation
 * is defined as "no body", so the empty stream has to count as one, or the
 * attended path is unreachable from anywhere except this Worker's own tests.
 *
 * Consumes the body when one is present, so the caller must use the returned
 * text rather than re-reading the request.
 */
export async function readBoundedBodyText(
  request: Request,
  maxBytes = COMMAND_HTTP_BODY_MAX_BYTES,
): Promise<string> {
  if (request.body === null) return "";
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new RequestBodyError("invalid content-length");
    }
    if (length > maxBytes) throw new RequestBodyError("request body too large", 413, "size");
    if (length === 0) return "";
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new RequestBodyError("request body too large", 413, "size");
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) return "";

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new RequestBodyError("invalid body");
  }
}

/** Parses text already read off the wire, so the body is consumed exactly once. */
export function parseStrictJsonText<T extends z.ZodType>(text: string, schema: T): z.infer<T> {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new RequestBodyError("invalid body");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new RequestBodyError("invalid body", 400, "schema");
  return parsed.data;
}

export async function parseBoundedStrictJson<T extends z.ZodType>(
  request: Request,
  schema: T,
  maxBytes = COMMAND_HTTP_BODY_MAX_BYTES,
): Promise<z.infer<T>> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new RequestBodyError("invalid content-length");
    }
    if (length > maxBytes) throw new RequestBodyError("request body too large", 413, "size");
  }

  const reader = request.body?.getReader();
  if (reader === undefined) throw new RequestBodyError("invalid body");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new RequestBodyError("request body too large", 413, "size");
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    ) as unknown;
  } catch {
    throw new RequestBodyError("invalid body");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new RequestBodyError("invalid body", 400, "schema");
  return parsed.data;
}

export function canonicalizeOrigins(origins: readonly string[]): string[] {
  const canonical = new Set<string>();
  for (const raw of origins) {
    if (raw !== raw.trim()) throw new RequestBodyError("invalid allowed origin");
    if (raw.includes("*")) throw new RequestBodyError("wildcard origins are not allowed");
    if (raw.includes("?") || raw.includes("#")) {
      throw new RequestBodyError("allowed origin must not contain query or fragment");
    }
    if (/^[a-z][a-z0-9+.-]*:\/\/[^/]*@/i.test(raw)) {
      throw new RequestBodyError("allowed origin must not contain credentials");
    }
    const normalized = canonicalOrigin(raw);
    if (normalized === null) {
      throw new RequestBodyError("allowed origin must use HTTPS");
    }
    canonical.add(normalized);
  }
  return [...canonical].sort();
}

export interface CanonicalUnattendedRequest
  extends Omit<UnattendedSessionRequest, "allowedOrigins" | "profileStateKey"> {
  allowedOrigins: string[];
  profileStateHash: string;
  fingerprint: string;
}

export async function canonicalizeUnattendedRequest(
  value: unknown,
  tenantId: string,
  env: Env,
): Promise<CanonicalUnattendedRequest> {
  const request = UnattendedSessionRequestSchema.parse(value);
  const allowedOrigins = canonicalizeOrigins(request.allowedOrigins);
  const profileStateHash = await hashProfileStateKey(tenantId, request.profileStateKey, env);
  const fingerprint = await sha256Hex(
    JSON.stringify({
      mode: request.mode,
      deviceId: request.deviceId?.toLowerCase() ?? null,
      allowedOrigins,
      profileStateHash,
    }),
  );
  return {
    mode: "unattended",
    ...(request.deviceId === undefined ? {} : { deviceId: request.deviceId.toLowerCase() }),
    allowedOrigins,
    profileStateHash,
    fingerprint,
  };
}

export async function requestFingerprint(command: unknown, dryRun: boolean): Promise<string> {
  return sha256Hex(stableJson({ command, dryRun }));
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
