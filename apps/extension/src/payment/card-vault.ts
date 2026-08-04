import { CardAliasSchema } from "@understudy/protocol";
import {
  canonicalizePaymentOrigins,
  luhnValid,
  storedPaymentCardExpired,
  validatePaymentCard,
  type PaymentCardInput,
  type ValidatedPaymentCard,
} from "./card-validation";
import type { CardVaultStore, EncryptedCardRecord } from "./indexeddb-card-store";

const RECORD_SCHEMA_VERSION = 1 as const;
const RECORD_PURPOSE = "payment-card" as const;

export class CardVaultCorruptError extends Error {}
export class CardVaultExpiredError extends Error {}
export class CardVaultKeyLostError extends Error {}

interface CardVaultSummary {
  aliases: string[];
  approvedOrigins: string[];
}

export interface CardPaymentAuthorization {
  alias: string;
  origin: string;
  revision: number;
  card: ValidatedPaymentCard;
}

export class CardVault {
  private operationTail: Promise<void> = Promise.resolve();
  private authorizationRevision = 0;

  constructor(private readonly store: CardVaultStore) {}

  summary(): Promise<CardVaultSummary> {
    return this.exclusive(() => this.readSummary());
  }

  save(input: PaymentCardInput): Promise<void> {
    return this.exclusive(async () => {
      await this.saveCard(input);
      this.authorizationRevision += 1;
    });
  }

  delete(alias: string): Promise<void> {
    return this.exclusive(async () => {
      await this.store.deleteCard(alias);
      this.authorizationRevision += 1;
    });
  }

  deleteAll(): Promise<void> {
    return this.exclusive(async () => {
      await this.store.clearVault();
      this.authorizationRevision += 1;
    });
  }

  setApprovedOrigins(origins: readonly string[]): Promise<string[]> {
    return this.exclusive(async () => {
      const canonical = canonicalizePaymentOrigins(origins);
      await this.store.putOrigins(canonical);
      this.authorizationRevision += 1;
      return canonical;
    });
  }

  authorizePayment(
    alias: string,
    origin: string,
  ): Promise<CardPaymentAuthorization | null> {
    return this.exclusive(async () => {
      const approvedOrigins = canonicalizePaymentOrigins(await this.store.getOrigins());
      if (!approvedOrigins.includes(origin)) return null;
      const card = await this.readCard(alias);
      return card === null
        ? null
        : { alias, origin, revision: this.authorizationRevision, card };
    });
  }

  paymentAuthorizationStillValid(
    authorization: Pick<CardPaymentAuthorization, "alias" | "origin" | "revision">,
  ): Promise<boolean> {
    return this.exclusive(async () => {
      if (authorization.revision !== this.authorizationRevision) return false;
      const [record, origins] = await Promise.all([
        this.store.getCard(authorization.alias),
        this.store.getOrigins(),
      ]);
      return (
        record !== undefined &&
        canonicalizePaymentOrigins(origins).includes(authorization.origin)
      );
    });
  }

  private async readSummary(): Promise<CardVaultSummary> {
    const [cards, approvedOrigins] = await Promise.all([
      this.store.listCards(),
      this.store.getOrigins(),
    ]);
    if (cards.length > 0 && (await this.store.getKey()) === undefined) {
      throw new CardVaultKeyLostError("The local card key is missing; delete and recreate the vault.");
    }
    for (const card of cards) validateRecord(card);
    return {
      aliases: cards.map((card) => card.alias).sort(),
      approvedOrigins: canonicalizePaymentOrigins(approvedOrigins),
    };
  }

  private async saveCard(input: PaymentCardInput): Promise<void> {
    const card = validatePaymentCard(input);
    const previous = await this.store.getCard(card.alias);
    const id = previous?.id ?? crypto.randomUUID();
    const key = await this.keyForWrite();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const aad = recordAad(id);
    const plaintext = new TextEncoder().encode(JSON.stringify(card));
    let ciphertext: ArrayBuffer;
    try {
      ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: toArrayBuffer(iv), additionalData: aad },
        key,
        plaintext,
      );
    } finally {
      plaintext.fill(0);
    }
    await this.store.putCard(
      {
        id,
        alias: card.alias,
        schemaVersion: RECORD_SCHEMA_VERSION,
        purpose: RECORD_PURPOSE,
        iv: iv.buffer.slice(iv.byteOffset, iv.byteOffset + iv.byteLength),
        ciphertext,
      },
    );
  }

  private async readCard(alias: string): Promise<ValidatedPaymentCard | null> {
    const record = await this.store.getCard(alias);
    if (record === undefined) return null;
    validateRecord(record);
    const key = await this.store.getKey();
    if (key === undefined) {
      throw new CardVaultKeyLostError("The local card key is missing; delete and recreate the vault.");
    }
    let plaintext: ArrayBuffer;
    try {
      plaintext = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: record.iv,
          additionalData: recordAad(record.id),
        },
        key,
        record.ciphertext,
      );
    } catch {
      throw new CardVaultCorruptError("The encrypted card record failed authentication.");
    }
    const bytes = new Uint8Array(plaintext);
    try {
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
      if (!isStoredCard(parsed) || parsed.alias !== record.alias) {
        throw new CardVaultCorruptError("The encrypted card record has an invalid schema.");
      }
      if (storedPaymentCardExpired(parsed.expiryMonth, parsed.expiryYear)) {
        throw new CardVaultExpiredError("The local card has expired.");
      }
      return parsed;
    } finally {
      bytes.fill(0);
    }
  }

  private async keyForWrite(): Promise<CryptoKey> {
    const existing = await this.store.getKey();
    if (existing !== undefined) return existing;
    if ((await this.store.listCards()).length > 0) {
      throw new CardVaultKeyLostError("The local card key is missing; delete and recreate the vault.");
    }
    const generated = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    if (await this.store.addKey(generated)) return generated;
    const raced = await this.store.getKey();
    if (raced === undefined) throw new Error("The local card key could not be persisted.");
    return raced;
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function recordAad(id: string): ArrayBuffer {
  return toArrayBuffer(
    new TextEncoder().encode(
      JSON.stringify({ schemaVersion: RECORD_SCHEMA_VERSION, id, purpose: RECORD_PURPOSE }),
    ),
  );
}

function validateRecord(record: EncryptedCardRecord): void {
  if (
    record.schemaVersion !== RECORD_SCHEMA_VERSION ||
    record.purpose !== RECORD_PURPOSE ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.id) ||
    !(record.iv instanceof ArrayBuffer) ||
    record.iv.byteLength !== 12 ||
    !(record.ciphertext instanceof ArrayBuffer) ||
    record.ciphertext.byteLength < 17
  ) {
    throw new CardVaultCorruptError("The encrypted card record has an invalid envelope.");
  }
}

function isStoredCard(value: unknown): value is ValidatedPaymentCard {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const card = value as Partial<ValidatedPaymentCard>;
  return (
    typeof card.alias === "string" && CardAliasSchema.safeParse(card.alias).success &&
    typeof card.cardholderName === "string" && card.cardholderName.length <= 128 &&
    typeof card.pan === "string" && /^\d{12,19}$/.test(card.pan) && luhnValid(card.pan) &&
    typeof card.expiryMonth === "string" && /^(?:0[1-9]|1[0-2])$/.test(card.expiryMonth) &&
    typeof card.expiryYear === "string" && /^\d{4}$/.test(card.expiryYear) &&
    typeof card.cvv === "string" && /^\d{3,4}$/.test(card.cvv) &&
    Object.keys(card).length === 6
  );
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
