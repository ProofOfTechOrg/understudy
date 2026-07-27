import {
  COMMAND_HTTP_BODY_MAX_BYTES,
  UnattendedSessionRequestSchema,
  type UnattendedSessionRequest,
} from "@understudy/protocol";
import type { z } from "zod";
import { hashProfileStateKey } from "./auth";
import type { Env } from "./types";

export class RequestBodyError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 413 = 400,
    readonly category: "syntax" | "schema" | "size" = "syntax",
  ) {
    super(message);
  }
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

function isLoopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "[::1]" ||
    normalized.endsWith(".localhost")
  );
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
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new RequestBodyError("invalid allowed origin");
    }
    if (
      url.username !== "" ||
      url.password !== "" ||
      (url.pathname !== "" && url.pathname !== "/") ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      throw new RequestBodyError("allowed origin must not contain credentials, path, query, or fragment");
    }
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
      throw new RequestBodyError("allowed origin must use HTTPS");
    }
    canonical.add(url.origin);
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

function stableJson(value: unknown): string {
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
