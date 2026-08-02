export function isLoopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "[::1]" ||
    normalized.endsWith(".localhost")
  );
}

export function canonicalOrigin(value: string): string | null {
  if (
    value !== value.trim() ||
    value.includes("*") ||
    value.includes("?") ||
    value.includes("#") ||
    /^[a-z][a-z0-9+.-]*:\/\/[^/]*@/i.test(value)
  ) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.username !== "" ||
    url.password !== "" ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname)))
  ) {
    return null;
  }
  return url.origin;
}

export function isCanonicalOrigin(value: unknown): value is string {
  return typeof value === "string" && canonicalOrigin(value) === value;
}
