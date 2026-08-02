import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CardVault,
  CardVaultCorruptError,
  CardVaultExpiredError,
  CardVaultKeyLostError,
} from "./card-vault";
import {
  canonicalizePaymentOrigins,
  CardValidationError,
  validatePaymentCard,
} from "./card-validation";
import type {
  CardVaultStore,
  EncryptedCardRecord,
} from "./indexeddb-card-store";

const CARD = {
  alias: "work",
  cardholderName: "Ada Lovelace",
  pan: "4111 1111 1111 1111",
  expiryMonth: "12",
  expiryYear: "2099",
  cvv: "123",
};

afterEach(() => {
  vi.useRealTimers();
});

class MemoryCardVaultStore implements CardVaultStore {
  key: CryptoKey | undefined;
  cards: EncryptedCardRecord[] = [];
  origins: string[] = [];

  async getKey(): Promise<CryptoKey | undefined> {
    return this.key;
  }

  async addKey(key: CryptoKey): Promise<boolean> {
    if (this.key !== undefined) return false;
    this.key = key;
    return true;
  }

  async deleteKey(): Promise<void> {
    this.key = undefined;
  }

  async listCards(): Promise<EncryptedCardRecord[]> {
    return [...this.cards];
  }

  async getCard(alias: string): Promise<EncryptedCardRecord | undefined> {
    return this.cards.find((card) => card.alias === alias);
  }

  async putCard(record: EncryptedCardRecord): Promise<void> {
    this.cards = this.cards.filter(
      (card) => card.id !== record.id && card.alias !== record.alias,
    );
    this.cards.push(record);
  }

  async deleteCard(alias: string): Promise<void> {
    this.cards = this.cards.filter((card) => card.alias !== alias);
  }

  async getOrigins(): Promise<string[]> {
    return [...this.origins];
  }

  async putOrigins(origins: string[]): Promise<void> {
    this.origins = [...origins];
  }

  async clearVault(): Promise<void> {
    this.cards = [];
    this.key = undefined;
    this.origins = [];
  }
}

describe("payment-card validation", () => {
  it("normalizes valid enrollment and rejects invalid PAN, expiry, CVV, and aliases", () => {
    expect(validatePaymentCard(CARD, new Date("2026-08-02T00:00:00Z"))).toEqual({
      ...CARD,
      pan: "4111111111111111",
    });
    expect(() => validatePaymentCard({ ...CARD, pan: "4111111111111112" })).toThrow(
      CardValidationError,
    );
    expect(() => validatePaymentCard({ ...CARD, expiryYear: "2020" })).toThrow(
      CardValidationError,
    );
    expect(() => validatePaymentCard({ ...CARD, expiryYear: "99" })).toThrow(
      CardValidationError,
    );
    expect(() => validatePaymentCard({ ...CARD, cvv: "12" })).toThrow(CardValidationError);
    expect(() => validatePaymentCard({ ...CARD, alias: "card-1111" })).toThrow(
      CardValidationError,
    );
  });

  it("accepts only exact HTTPS origins and canonicalizes duplicates", () => {
    expect(
      canonicalizePaymentOrigins([
        "https://shop.example",
        "https://shop.example/",
        "https://pay.example:443",
      ]),
    ).toEqual(["https://pay.example", "https://shop.example"]);
    for (const origin of [
      "http://shop.example",
      "https://shop.example/pay",
      "https://*.example",
      "https://user@shop.example",
    ]) {
      expect(() => canonicalizePaymentOrigins([origin])).toThrow(CardValidationError);
    }
  });
});

describe("CardVault", () => {
  it("persists a non-extractable key, uses a fresh IV, and survives a new vault instance", async () => {
    const store = new MemoryCardVaultStore();
    const vault = new CardVault(store);
    await vault.save(CARD);
    const first = store.cards[0];
    expect(first).toBeDefined();
    expect(store.key?.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("raw", store.key!)).rejects.toThrow();

    await vault.save({ ...CARD, cardholderName: "Ada Byron" });
    const second = store.cards[0];
    expect(second?.id).toBe(first?.id);
    expect(new Uint8Array(second!.iv)).not.toEqual(new Uint8Array(first!.iv));
    const restored = new CardVault(store);
    await restored.setApprovedOrigins(["https://shop.example"]);
    await expect(
      restored.authorizePayment("work", "https://shop.example"),
    ).resolves.toMatchObject({
      card: {
        cardholderName: "Ada Byron",
        pan: "4111111111111111",
        cvv: "123",
      },
    });
  });

  it("authenticates the envelope, UUID-bound AAD, and ciphertext", async () => {
    const store = new MemoryCardVaultStore();
    const vault = new CardVault(store);
    await vault.save(CARD);
    await vault.setApprovedOrigins(["https://shop.example"]);
    const original = store.cards[0]!;

    store.cards[0] = { ...original, id: crypto.randomUUID() };
    await expect(
      vault.authorizePayment("work", "https://shop.example"),
    ).rejects.toBeInstanceOf(CardVaultCorruptError);

    const ciphertext = original.ciphertext.slice(0);
    new Uint8Array(ciphertext)[0]! ^= 1;
    store.cards[0] = { ...original, ciphertext };
    await expect(
      vault.authorizePayment("work", "https://shop.example"),
    ).rejects.toBeInstanceOf(CardVaultCorruptError);
  });

  it("refuses a stored card after its expiration month has passed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T00:00:00Z"));
    const store = new MemoryCardVaultStore();
    const vault = new CardVault(store);
    await vault.save({ ...CARD, expiryMonth: "08", expiryYear: "2026" });
    await vault.setApprovedOrigins(["https://shop.example"]);

    vi.setSystemTime(new Date("2026-09-01T00:00:00Z"));

    await expect(
      vault.authorizePayment("work", "https://shop.example"),
    ).rejects.toBeInstanceOf(CardVaultExpiredError);
  });

  it("fails closed on key loss and requires explicit deletion before recovery", async () => {
    const store = new MemoryCardVaultStore();
    const vault = new CardVault(store);
    await vault.save(CARD);
    await vault.setApprovedOrigins(["https://shop.example"]);
    await store.deleteKey();

    await expect(vault.summary()).rejects.toBeInstanceOf(CardVaultKeyLostError);
    await expect(
      vault.authorizePayment("work", "https://shop.example"),
    ).rejects.toBeInstanceOf(CardVaultKeyLostError);
    await expect(vault.save({ ...CARD, alias: "backup" })).rejects.toBeInstanceOf(
      CardVaultKeyLostError,
    );

    await vault.deleteAll();
    await expect(vault.save({ ...CARD, alias: "backup" })).resolves.toBeUndefined();
  });

  it("deletes records idempotently and clears records, key, and origins together", async () => {
    const store = new MemoryCardVaultStore();
    const vault = new CardVault(store);
    await vault.save(CARD);
    await vault.setApprovedOrigins(["https://shop.example"]);

    await vault.delete("missing");
    await vault.delete("work");
    await vault.delete("work");
    expect(await vault.summary()).toEqual({
      aliases: [],
      approvedOrigins: ["https://shop.example"],
    });

    await vault.save(CARD);
    await vault.deleteAll();
    expect(store.cards).toEqual([]);
    expect(store.key).toBeUndefined();
    expect(store.origins).toEqual([]);
  });

  it("serializes mutations so a vault clear cannot race an in-flight card write", async () => {
    const store = new MemoryCardVaultStore();
    const originalPut = store.putCard.bind(store);
    let releaseWrite!: () => void;
    const writeBlocked = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let markWriteStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => {
      markWriteStarted = resolve;
    });
    store.putCard = async (record) => {
      markWriteStarted();
      await writeBlocked;
      await originalPut(record);
    };
    const vault = new CardVault(store);

    const saving = vault.save(CARD);
    await writeStarted;
    const clearing = vault.deleteAll();
    releaseWrite();
    await Promise.all([saving, clearing]);

    expect(store.cards).toEqual([]);
    expect(store.key).toBeUndefined();
    expect(store.origins).toEqual([]);
  });

  it("revokes an authorized submission when a queued vault mutation wins first", async () => {
    const store = new MemoryCardVaultStore();
    const vault = new CardVault(store);
    await vault.save(CARD);
    await vault.setApprovedOrigins(["https://shop.example"]);
    const authorization = await vault.authorizePayment("work", "https://shop.example");
    expect(authorization).not.toBeNull();

    const deleting = vault.delete("work");
    const finalGate = vault.paymentAuthorizationStillValid(authorization!);

    await deleting;
    await expect(finalGate).resolves.toBe(false);
  });
});
