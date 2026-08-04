const DEADLINE_REACHED = Symbol("deadline-reached");

export async function settleBeforeDeadline<T>(
  task: () => Promise<T>,
  remainingMs: number,
  onDeadline: () => Promise<void>,
): Promise<T | null> {
  if (remainingMs <= 0) {
    await onDeadline();
    return null;
  }
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<typeof DEADLINE_REACHED>((resolve) => {
    timer = setTimeout(() => resolve(DEADLINE_REACHED), remainingMs);
  });
  const result = await Promise.race([task(), deadline]);
  clearTimeout(timer!);
  if (result !== DEADLINE_REACHED) return result;
  await onDeadline();
  return null;
}
