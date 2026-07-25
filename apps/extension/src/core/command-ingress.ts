export interface StartedCommand {
  completion: Promise<unknown>;
}

export class CommandIngress {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly executions = new Set<Promise<unknown>>();

  enqueue(start: () => Promise<StartedCommand | undefined>): Promise<void> {
    return this.serialize(async () => {
      const started = await start();
      if (started === undefined) return;

      const completion = started.completion;
      this.executions.add(completion);
      void completion
        .finally(() => {
          this.executions.delete(completion);
        })
        .catch(() => {});
    });
  }

  barrier(run: () => Promise<void>): Promise<void> {
    return this.serialize(async () => {
      await Promise.allSettled([...this.executions]);
      await run();
    });
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
