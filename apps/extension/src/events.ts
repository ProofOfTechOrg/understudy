import type { Event } from "@understudy/protocol";

export function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  return String(cause);
}

export function actionError(commandId: string, error: string): Event {
  return { type: "action_result", commandId, ok: false, error };
}
