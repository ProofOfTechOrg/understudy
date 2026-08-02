# Deferred work

## API-credential vault

Understudy 0.2.0 deliberately removes the cloud secret vault and generic
`fill_secret` capability. The extension-local payment-card vault is not an
API-credential vault and must not be generalized into one.

A future API-credential feature requires a separate design and security review
before implementation. The review starts from these constraints:

- Use separate IndexedDB records and a separate object store from payment
  cards. Do not overload the card schema, aliases, key-purpose AAD, handlers, or
  UI.
- Support only reviewed, service-specific adapters. Each adapter fixes the
  service identity, exact destination origin, credential type, injection point,
  and permitted operation.
- Do not expose generic header injection, form/ref injection, arbitrary fetch,
  arbitrary DOM/runtime evaluation, or a plaintext-returning API.
- Do not share a plaintext API, decrypted value type, generic executor, or
  message shape with the card vault.
- Keep plaintext, ciphertext, key material, masked values, and recovery data
  inside the extension boundary. Define key loss, corruption, deletion,
  migration, update, and uninstall behavior explicitly.
- Preserve the intersection of backend-authoritative device/session policy and
  a local exact-origin approval. Revocation and policy narrowing must fence
  active use.
- Specify page-derived output suppression and fixed result enums for each
  adapter. Do not infer remote success from an untrusted page.
- Threat-model the controlling agent, approved service origin, extension/update
  authority, operating system, logs, crash reports, sync, backups, clipboard,
  downloads, network tooling, and other extensions.
- Add adversarial unit and real-Chrome tests proving no credential marker
  appears outside the adapter and approved destination.

Out of scope until that design is accepted: password storage, bearer tokens,
API keys, OAuth refresh tokens, SSH keys, arbitrary login automation, and
migration from any retired cloud-vault data.
