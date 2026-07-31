export class RetryableStartupGate {
  private startup: Promise<void> | null = null;

  constructor(private readonly start: () => Promise<void>) {}

  wait(): Promise<void> {
    if (this.startup !== null) return this.startup;
    const attempt = this.start();
    const retryable = attempt.catch((cause: unknown) => {
      if (this.startup === retryable) this.startup = null;
      throw cause;
    });
    this.startup = retryable;
    return retryable;
  }
}
