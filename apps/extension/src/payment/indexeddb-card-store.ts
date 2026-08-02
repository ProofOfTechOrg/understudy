const CARD_VAULT_DATABASE = "understudy-payment-card-vault";
const CARD_VAULT_DATABASE_VERSION = 2;

export interface EncryptedCardRecord {
  id: string;
  alias: string;
  schemaVersion: 1;
  purpose: "payment-card";
  iv: ArrayBuffer;
  ciphertext: ArrayBuffer;
}

export interface CardVaultStore {
  getKey(): Promise<CryptoKey | undefined>;
  addKey(key: CryptoKey): Promise<boolean>;
  listCards(): Promise<EncryptedCardRecord[]>;
  getCard(alias: string): Promise<EncryptedCardRecord | undefined>;
  putCard(record: EncryptedCardRecord): Promise<void>;
  deleteCard(alias: string): Promise<void>;
  getOrigins(): Promise<string[]>;
  putOrigins(origins: string[]): Promise<void>;
  clearVault(): Promise<void>;
}

export class IndexedDbCardVaultStore implements CardVaultStore {
  private database: Promise<IDBDatabase> | null = null;

  async getKey(): Promise<CryptoKey | undefined> {
    const record = await this.get<{ id: string; key: CryptoKey }>("keys", "payment-card-key");
    return record?.key;
  }

  async addKey(key: CryptoKey): Promise<boolean> {
    try {
      await this.request("keys", "readwrite", (store) =>
        store.add({ id: "payment-card-key", key }),
      );
      return true;
    } catch (error) {
      if (error instanceof DOMException && error.name === "ConstraintError") return false;
      throw error;
    }
  }

  async listCards(): Promise<EncryptedCardRecord[]> {
    const records = await this.request<EncryptedCardRecord[]>(
      "cards",
      "readonly",
      (store) => store.getAll(),
    );
    return records.sort((left, right) => left.alias.localeCompare(right.alias));
  }

  getCard(alias: string): Promise<EncryptedCardRecord | undefined> {
    return this.request<EncryptedCardRecord | undefined>(
      "cards",
      "readonly",
      (store) => store.index("alias").get(alias),
    );
  }

  async putCard(record: EncryptedCardRecord): Promise<void> {
    const database = await this.open();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("cards", "readwrite");
      const store = transaction.objectStore("cards");
      store.put(record);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("card write failed"));
      transaction.onabort = () => reject(transaction.error ?? new Error("card write aborted"));
    });
  }

  async deleteCard(alias: string): Promise<void> {
    const record = await this.getCard(alias);
    if (record === undefined) return;
    await this.request("cards", "readwrite", (store) => store.delete(record.id));
  }

  async getOrigins(): Promise<string[]> {
    const record = await this.get<{ id: string; origins: string[] }>(
      "settings",
      "payment-origins",
    );
    return Array.isArray(record?.origins) ? [...record.origins] : [];
  }

  async putOrigins(origins: string[]): Promise<void> {
    await this.request("settings", "readwrite", (store) =>
      store.put({ id: "payment-origins", origins: [...origins] }),
    );
  }

  async clearVault(): Promise<void> {
    const database = await this.open();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(["cards", "keys", "settings"], "readwrite");
      transaction.objectStore("cards").clear();
      transaction.objectStore("keys").delete("payment-card-key");
      transaction.objectStore("settings").delete("payment-origins");
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("vault clear failed"));
      transaction.onabort = () => reject(transaction.error ?? new Error("vault clear aborted"));
    });
  }

  private get<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
    return this.request<T | undefined>(store, "readonly", (objectStore) =>
      objectStore.get(key),
    );
  }

  private async request<T = unknown>(
    storeName: string,
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const database = await this.open();
    return new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(storeName, mode);
      const request = operation(transaction.objectStore(storeName));
      let result!: T;
      request.onsuccess = () => {
        result = request.result;
      };
      request.onerror = () => reject(request.error ?? new Error("vault database request failed"));
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error ?? new Error("vault transaction failed"));
      transaction.onabort = () => reject(transaction.error ?? new Error("vault transaction aborted"));
    });
  }

  private open(): Promise<IDBDatabase> {
    if (this.database !== null) return this.database;
    let opening!: Promise<IDBDatabase>;
    opening = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(CARD_VAULT_DATABASE, CARD_VAULT_DATABASE_VERSION);
      let settled = false;
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains("keys")) {
          database.createObjectStore("keys", { keyPath: "id" });
        }
        if (!database.objectStoreNames.contains("cards")) {
          const cards = database.createObjectStore("cards", { keyPath: "id" });
          cards.createIndex("alias", "alias", { unique: true });
        }
        if (!database.objectStoreNames.contains("settings")) {
          database.createObjectStore("settings", { keyPath: "id" });
        }
        const metadata = database.objectStoreNames.contains("metadata")
          ? request.transaction!.objectStore("metadata")
          : database.createObjectStore("metadata", { keyPath: "id" });
        metadata.put({ id: "schema", version: CARD_VAULT_DATABASE_VERSION });
      };
      request.onsuccess = () => {
        const database = request.result;
        if (settled) {
          database.close();
          return;
        }
        database.onversionchange = () => {
          database.close();
          if (this.database === opening) this.database = null;
        };
        const transaction = database.transaction("metadata", "readonly");
        const schema = transaction.objectStore("metadata").get("schema");
        transaction.oncomplete = () => {
          if (
            typeof schema.result !== "object" ||
            schema.result === null ||
            (schema.result as { version?: unknown }).version !== CARD_VAULT_DATABASE_VERSION
          ) {
            database.close();
            fail(new Error("vault database schema is invalid"));
            return;
          }
          settled = true;
          resolve(database);
        };
        transaction.onerror = () => {
          database.close();
          fail(transaction.error ?? new Error("vault database schema check failed"));
        };
      };
      request.onerror = () => fail(request.error ?? new Error("vault database unavailable"));
      request.onblocked = () => fail(new Error("vault database upgrade blocked"));
    });
    this.database = opening;
    void opening.catch(() => {
      if (this.database === opening) this.database = null;
    });
    return opening;
  }
}
