import { describe, expect, it, vi } from "vitest";
import type { PaymentCardInput } from "../../payment/card-validation";
import { CardSaveRequests, commitCardEnrollment } from "./card-save";

const CARD: PaymentCardInput = {
  alias: "travel-card",
  cardholderName: "Test User",
  pan: "4111111111111111",
  expiryMonth: "12",
  expiryYear: "2030",
  cvv: "123",
};

describe("CardSaveRequests", () => {
  it("resolves only after the matching background acknowledgement", async () => {
    const postMessage = vi.fn();
    const requests = new CardSaveRequests(postMessage, () => "request-1");
    const save = requests.save(CARD);

    expect(postMessage).toHaveBeenCalledWith({
      type: "saveCard",
      requestId: "request-1",
      card: CARD,
    });
    expect(requests.settle({
      type: "cardVaultSaveResult",
      requestId: "another-request",
      ok: true,
    })).toBe(false);

    expect(requests.settle({
      type: "cardVaultSaveResult",
      requestId: "request-1",
      ok: true,
    })).toBe(true);
    await expect(save).resolves.toBeUndefined();
  });

  it("rejects a failed save and every request interrupted by a disconnect", async () => {
    let nextRequest = 0;
    const requests = new CardSaveRequests(
      vi.fn(),
      () => `request-${++nextRequest}`,
    );
    const failed = requests.save(CARD);
    const interrupted = requests.save(CARD);

    requests.settle({
      type: "cardVaultSaveResult",
      requestId: "request-1",
      ok: false,
      error: "The local card-vault operation failed.",
    });
    requests.rejectAll("The background service disconnected before the card was saved.");

    await expect(failed).rejects.toThrow("card-vault operation failed");
    await expect(interrupted).rejects.toThrow("background service disconnected");
  });
});

describe("commitCardEnrollment", () => {
  it("clears form state after a successful commit", async () => {
    const reset = vi.fn();

    await commitCardEnrollment(CARD, vi.fn().mockResolvedValue(undefined), reset);

    expect(reset).toHaveBeenCalledOnce();
  });

  it("preserves form state when persistence fails", async () => {
    const reset = vi.fn();

    await expect(
      commitCardEnrollment(
        CARD,
        vi.fn().mockRejectedValue(new Error("save failed")),
        reset,
      ),
    ).rejects.toThrow("save failed");

    expect(reset).not.toHaveBeenCalled();
  });
});
