export class RequestDeadlineError extends Error {
  constructor() {
    super("request deadline exceeded");
    this.name = "RequestDeadlineError";
  }
}

export async function withRequestDeadline<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new RequestDeadlineError());
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

export async function readBoundedJson(
  response: Response,
  signal: AbortSignal,
  maxBytes: number,
): Promise<unknown> {
  // Unit-test response doubles may expose only json(); real Fetch Responses
  // always own the body/header surface exercised by the bounded reader below.
  const body = (response as unknown as { body?: ReadableStream<Uint8Array> | null }).body;
  if (body === undefined) return response.json() as Promise<unknown>;
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    /^\d+$/.test(declaredLength) &&
    Number(declaredLength) > maxBytes
  ) {
    throw new Error("response body exceeds limit");
  }
  if (body === null) throw new Error("response body is empty");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => {
    void reader.cancel(new RequestDeadlineError()).catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new RequestDeadlineError();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel("response body exceeds limit").catch(() => {});
        throw new Error("response body exceeds limit");
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  const completeBody = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    completeBody.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(completeBody)) as unknown;
  } finally {
    completeBody.fill(0);
  }
}
