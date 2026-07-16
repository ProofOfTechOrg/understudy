/**
 * Vault secret resolution for fill_secret (M-007).
 *
 * DL-004 no-leak invariant: this module resolves an opaque secretRef to
 * plaintext and returns it - nothing else. It performs no dispatch (imports
 * neither session.ts nor the coordinator) and writes the plaintext to no
 * log, no state, and no error string. The only caller is SessionAgent.
 * fillSecret (M-004, DO-side): it awaits resolveSecret(createVault(this.env),
 * cmd.secretRef) and immediately dispatches the resulting keystrokes via the
 * coordinator, so plaintext exists only transiently inside that Durable
 * Object and never reaches the Worker/route, the model, or any durable
 * surface (setState, audit, Event response).
 *
 * At-rest posture: the VaultBinding handed in is vault.ts's decrypting
 * layer over the KV namespace - KV itself holds only AES-256-GCM envelopes
 * (see vault.ts), so a KV read-back at rest yields ciphertext without the
 * VAULT_MASTER_KEY Worker secret. A per-tenant external KMS remains a
 * possible future swap behind this same VaultBinding.get seam.
 */

import type { VaultBinding } from "./types";

export class SecretResolutionError extends Error {}

export async function resolveSecret(vault: VaultBinding, secretRef: string): Promise<string> {
  const value = await vault.get(secretRef);
  if (value == null) {
    throw new SecretResolutionError("secret ref could not be resolved");
  }
  return value;
}
