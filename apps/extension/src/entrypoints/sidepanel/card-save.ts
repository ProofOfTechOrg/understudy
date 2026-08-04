import type {
  CardVaultSaveResultMsg,
  SaveCardMsg,
} from "../../messaging";
import type { PaymentCardInput } from "../../payment/card-validation";

interface PendingSave {
  resolve: () => void;
  reject: (cause: Error) => void;
}

export class CardSaveRequests {
  private readonly pending = new Map<string, PendingSave>();

  constructor(
    private readonly postMessage: (message: SaveCardMsg) => void,
    private readonly createRequestId: () => string = () => crypto.randomUUID(),
  ) {}

  save(card: PaymentCardInput): Promise<void> {
    const requestId = this.createRequestId();
    if (this.pending.has(requestId)) {
      return Promise.reject(new Error("Could not create a unique card-save request."));
    }

    return new Promise<void>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      try {
        this.postMessage({ type: "saveCard", requestId, card });
      } catch (cause) {
        this.pending.delete(requestId);
        reject(
          cause instanceof Error
            ? cause
            : new Error("Could not send the card to the background service."),
        );
      }
    });
  }

  settle(result: CardVaultSaveResultMsg): boolean {
    const pending = this.pending.get(result.requestId);
    if (pending === undefined) return false;
    this.pending.delete(result.requestId);
    if (result.ok) {
      pending.resolve();
    } else {
      pending.reject(new Error(result.error));
    }
    return true;
  }

  rejectAll(message: string): void {
    for (const pending of this.pending.values()) {
      pending.reject(new Error(message));
    }
    this.pending.clear();
  }
}

export async function commitCardEnrollment(
  card: PaymentCardInput,
  save: (card: PaymentCardInput) => Promise<void>,
  reset: () => void,
): Promise<void> {
  await save(card);
  reset();
}
