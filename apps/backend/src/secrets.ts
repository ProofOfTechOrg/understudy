/**
 * Vault secret resolution for fill_secret (M-007).
 *
 * DL-004 no-leak invariant: this module resolves an opaque secretRef to
 * plaintext and returns it - nothing else. It performs no dispatch (imports
 * neither session.ts nor the coordinator) and writes the plaintext to no
 * log, no state, and no error string. The only caller is SessionAgent.
 * fillSecret (M-004, DO-side): it awaits resolveSecret(this.env.VAULT,
 * cmd.secretRef) and immediately dispatches the resulting keystrokes via the
 * coordinator, so plaintext exists only transiently inside that Durable
 * Object and never reaches the Worker/route, the model, or any durable
 * surface (setState, audit, Event response).
 *
 * Pre-production security gate: the concrete VAULT binding wired in
 * wrangler.jsonc is a KV namespace (see types.ts's VaultBinding doc), and KV
 * values are readable back at rest. That is acceptable for dev, where no
 * real credential is stored, but a stronger backend (per-tenant KMS, or a
 * Secrets-Store-via-API binding) MUST be swapped in behind this same
 * VaultBinding.get seam before any real credential is stored.
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
