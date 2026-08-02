<!-- Content type: Conceptual decision record and normative requirements -->

# Should Understudy store payment cards in the extension?

This document answers whether Understudy can keep payment-card details on a user’s device without exposing them to the Understudy service. It records the current code evidence, the confirmed secret-disclosure defect, the Payment Card Industry Data Security Standard (PCI DSS) and UAE regulatory analysis, the selected architecture, and the requirements that must pass before any payment feature ships.

## Document status and goal

This document is the security and compliance baseline for a proposed local payment executor. It does not authorize production card handling or represent a PCI scope attestation.

| Field | Value |
|---|---|
| Status | Proposed architecture; implementation not started |
| Audience | Understudy, Perflo, parking-worker, security, compliance, and payment-provider engineers |
| Goal | Decide whether to build the feature and define a design that prevents Understudy’s cloud service and agents from learning payment credentials |
| Repository baseline | `dev` at `857e0e3ebb8312be3e260e7339968f602703afdf` |
| Analysis date | 2026-08-02 |
| Primary jurisdiction considered | United Arab Emirates |
| Current finding count | One confirmed High-severity secret-disclosure defect |

The reader should be able to evaluate and implement the design using only this repository and this document. Reconfirm all source anchors before editing because line numbers describe the baseline commit.

## Decision

Do not add saved cards to the current general-purpose Understudy extension.

Use this architecture order:

1. Ask Perflo or the payment service provider (PSP) to execute or tokenize the payment without exposing a primary account number (PAN) to Understudy
2. Use PSP-hosted fields or a merchant-scoped reusable token
3. If neither option exists, build a separate local payment executor with the controls in this document
4. Do not use the existing server vault, existing `fill_secret` command, or a cloud browser for card data

A local vault can remove the largest cloud cardholder-data exposure. It may also support the PCI SSC consumer-device scope exclusion. Encryption, local storage, and the absence of an export method do not establish that boundary on their own.

The decisive issue is runtime authority. Any code that can decrypt a card can disclose its plaintext. Understudy’s backend currently controls an extension with broad Chrome DevTools Protocol (CDP) capabilities, including Accessibility, Document Object Model (DOM), Input, Network, Page, Runtime, and Storage. The payment design must remove the cloud service and general agent from the decrypt-and-fill decision.

## Confidence

The code and Web Crypto conclusions are verified. External scope and licensing conclusions depend on the final product facts and written decisions from the responsible organizations.

| Claim | Confidence | Basis |
|---|---|---|
| The current backend decrypts vault secrets and sends plaintext to the extension | High | Verified source trace in `apps/backend/src/session.ts` |
| The current secret-fill tool can return a vault value through an accessibility snapshot | High | Verified source trace, existing unit fixture, 154 passing extension tests, and independent review |
| A non-extractable WebCrypto key does not stop authorized extension code from decrypting | High | Web Crypto API semantics |
| A virtual PAN remains within PCI DSS unless the payment brand determines a specific restriction changes its treatment | High | PCI SSC FAQs 1285 and 1286 |
| A strictly consumer-controlled local environment may sit outside Understudy’s PCI DSS assessment | Moderate | PCI SSC FAQ 1283 applies only if all stated facts remain true |
| Understudy’s backend remains in PCI scope because it can affect the payment executor | Moderate | Scope depends on the final authority boundary and the acquirer’s or Qualified Security Assessor’s determination |
| UAE Payment Initiation Service licensing applies to this feature | Unknown | Product facts and contractual roles need UAE regulatory counsel and Central Bank confirmation |

## Terms

This document uses these terms:

- **Cardholder data (CHD)**: the PAN plus any associated cardholder data covered by PCI DSS
- **Sensitive authentication data (SAD)**: authentication data such as the card verification value (CVV, CVC, CID) that PCI DSS restricts more severely
- **Cardholder-data environment (CDE)**: systems that store, process, transmit, or can affect the security of CHD
- **Payment service provider (PSP)**: the regulated or contracted provider that processes the merchant payment
- **Qualified Security Assessor (QSA)**: a PCI-qualified assessor who can evaluate the implementation and scope
- **Payment intent**: an immutable, expiring description of one proposed payment
- **Local policy**: payment authority configured and stored on the user’s device, which the backend cannot broaden
- **Sensitive mode**: a fail-closed extension state in which payment plaintext may exist and all general observation and control channels are disabled
- **Payment executor**: the dedicated local component that validates a payment intent, decrypts or obtains a transaction credential, and submits it to an approved checkout

The words MUST, MUST NOT, REQUIRED, SHOULD, SHOULD NOT, and MAY express normative requirements.

## Scope and assumptions

The analysis covers these surfaces:

- The Manifest V3 Understudy extension
- The Cloudflare backend and Durable Object session authority
- The shared protocol and MCP tools
- Existing vault secret storage and fill behavior
- A proposed extension-local card vault
- Perflo-minted virtual cards and transaction controls
- A Parkin or PSP-hosted checkout opened by a parking worker
- An external iPhone request that starts the parking workflow without carrying card data

The design assumes:

- The person installing the executor is the cardholder or has valid authority to use the card
- The executor runs in a browser profile controlled by that person
- The parking request contains parking details but no payment credential
- Perflo, the issuer, or the PSP remains responsible for issuer-side card systems
- Parkin or its PSP publishes stable checkout origins and a supported automation or hosted-payment contract
- Transport uses authenticated HTTPS and WebSocket Secure (WSS) connections

The following remain outside this decision:

- Defending against an administrator or malware with full control of the user’s operating system
- Proving that a compromised approved merchant never steals data entered into its own checkout
- Selecting Parkin-specific DOM selectors before Parkin or its PSP documents the checkout contract
- Determining Understudy’s UAE licensing classification without counsel or Central Bank confirmation
- Treating this document as a substitute for a QSA, acquirer, payment-brand, issuer, or regulator decision

## Current architecture

Understudy is a remote browser-execution service. The backend authenticates callers, provisions sessions, and sends protocol commands over WSS. The installed extension drives extension-owned tabs with `chrome.debugger` and CDP.

The current trust path is:

```text
authenticated agent or API caller
  -> Understudy backend and session authority
  -> extension service worker
  -> CDP session attached to an extension-owned tab
  -> merchant or other allowed page
```

The backend is the command authority after the extension accepts a device or session ticket. Commands are schema-validated and write operations use prepare, grant, and result fencing. Those controls prevent selected concurrency and retry failures. They do not prevent an authorized command source from choosing an unsafe secret destination or observing the page after a fill.

### Relevant components

| Component | Current responsibility | Payment relevance |
|---|---|---|
| `packages/protocol` | Command, event, control-frame, and status schemas | Defines `fill_secret`; needs a separate payment contract |
| `apps/backend/src/mcp/tools.ts` | Agent-facing browser tools | Currently claims secret values never reach tool results |
| `apps/backend/src/session.ts` | Session admission, write lifecycle, vault resolution | Currently decrypts secrets into plaintext commands |
| `apps/backend/src/vault.ts` | Server-side encrypted secret storage | Must not store or decrypt payment cards under the selected design |
| `apps/extension/src/core/profile-client.ts` | Device policy and server provisioning | Must enforce a local policy that the server cannot broaden |
| `apps/extension/src/core/session-runtime.ts` | Session WSS and write lifecycle | General runtime must not receive payment plaintext |
| `apps/extension/src/core/router.ts` | Protocol command dispatch | Must not route card data through ordinary `type` |
| `apps/extension/src/driver/cdp.ts` | Page observation and mutation | Current screenshot, accessibility, and input capabilities create export paths |
| `apps/extension/src/driver/a11y.ts` | Accessibility-tree serialization | Currently serializes ordinary textbox values |
| Side panel | Pairing, status, and local controls | A separate payment UI may collect enrollment and approval data |

## Current secret flow does not meet the payment goal

The protocol exposes only an opaque `secretRef` to the caller, but the backend resolves it. The server then changes the command into ordinary text before sending it to the extension.

```text
caller sends fill_secret(secretRef)
  -> backend verifies tenant namespace
  -> backend decrypts the secret from KV
  -> backend creates type(text: plaintext)
  -> WSS transmits plaintext to the extension
  -> CDP inserts plaintext into the page
```

The relevant branch in `apps/backend/src/session.ts` is:

```typescript
const resolution = await resolveBeforeDeadline(
  resolveSecret(createVault(this.env), command.secretRef),
  readyDeadlineAt,
);

const secret = resolution.value;
grantedCommand = {
  type: "type",
  commandId: command.commandId,
  ref: command.ref,
  text: secret,
  submit: command.submit,
};
```

This flow places plaintext in the Cloudflare Worker runtime, a WSS frame, extension memory, a CDP command, and the destination page. It cannot support the claim that Understudy’s service never asks for, receives, processes, or transmits card details.

## Confirmed current defect: secret fill is a decryption oracle

The existing MCP description says that `browser_fill_secret` never returns a secret value. The code does not enforce that property.

### Severity and impact

| Field | Assessment |
|---|---|
| ID | `SEC-001` |
| Severity | High |
| Confidence | High |
| Attacker | An authenticated tenant agent or MCP caller that can use browser and vault tools |
| Impact | Disclosure of complete vault plaintext, including passwords or API keys |
| Tenant boundary | Not bypassed; the defect breaks the intended model-to-secret isolation inside one tenant |

### Verified attack sequence

An authorized caller can recover a secret with this sequence:

1. Call `browser_list_secrets` and select a returned name
2. Open an allowed page that contains an ordinary text input
3. Call `browser_snapshot` and obtain the text input’s ref
4. Call `browser_fill_secret` with that ref and the selected secret name
5. Call `browser_snapshot` again
6. Read the secret from the textbox’s serialized accessibility value

The code path is:

```text
browser_fill_secret(ref, name)
  -> backend resolves name to plaintext
  -> extension Input.insertText writes plaintext to ref
  -> browser_snapshot captures Accessibility.getFullAXTree
  -> buildA11ySnapshot copies node.value
  -> renderTree returns value in the MCP result
```

The second snapshot does not reuse the fill ref. Ref generations and at-most-once write fencing therefore do not block the attack.

The existing `apps/extension/src/driver/a11y.test.ts` fixture explicitly verifies that a textbox’s `value` survives snapshot construction. The full extension test run completed with 154 passing tests.

### Root cause

`browser_fill_secret` accepts any agent-selected ref. It does not bind the secret to an exact origin, intended field, or credential purpose. The runtime also retains every normal observation channel after the fill.

### Required remediation before payment work

Payment work MUST NOT start until the current secret boundary no longer claims a property it cannot enforce. The repair MUST address the whole class:

- Remove caller-selected arbitrary refs from secret release
- Bind every saved secret to exact approved origins and a purpose
- Let trusted local code locate and validate destination fields
- Prevent all page-derived output after release until the sensitive context is destroyed
- Add regression tests covering accessibility, screenshots, dialogs, URLs, titles, tabs, errors, logs, and command journals

Redacting only accessibility values is insufficient. A page can copy plaintext into a label, dialog, URL, title, canvas, screenshot, error, or network request.

## Threat model for a local card vault

The payment design must resist threats from every system that can influence local decryption or observe the checkout.

### Threat actors and required defenses

| Threat actor | Capability | Required defense |
|---|---|---|
| Malicious authorized agent | Chooses commands and sees tool results | No arbitrary secret refs; local policy; no page-derived output during or after payment |
| Compromised Understudy backend | Provisions sessions, chooses commands, and can broaden server-side policy | Extension-enforced immutable local policy; transaction caps; no generic payment commands |
| Cross-tenant attacker | Attempts to use another tenant’s card alias or intent | Unpredictable local aliases, tenant and device binding, signed intents, replay protection |
| Compromised merchant page | Reads values entered into its DOM or submits a modified amount | Exact origin and frame validation, local amount verification, issuer-enforced merchant and amount limits |
| Third-party checkout script | Executes inside or around the merchant checkout | PSP-hosted fields, exact frame allowlist, content and redirect controls, no unsupported checkout |
| Malicious extension update | Can invoke the local decryption API | Hardened release authority, reproducible builds, update transparency, rapid revocation; a separate executor limits blast radius |
| Compromised dependency or build | Adds code that exports plaintext | Locked dependencies, release-age policy, review, software bill of materials (SBOM), provenance, reproducible build checks |
| Browser-profile theft | Copies encrypted storage and browser state | Non-extractable keys, OS-backed wrapping where available, auto-lock, no sync, no recoverable server backup |
| Local malware or administrator | Controls browser process or operating system | Outside the guaranteed boundary; user notice and issuer limits reduce loss |
| Network attacker | Alters intents or checkout traffic | TLS, signed intents, exact origin checks, certificate validation supplied by the browser |
| Replay attacker | Reuses a valid payment intent | Nonce, expiry, device binding, local spent-intent journal, issuer one-time credential |

### Security goals

The implementation MUST establish these properties:

- Understudy’s backend never receives PAN, expiry, CVV, the vault key, decrypted card fields, or a recoverable backup
- General agents never receive card plaintext or a command primitive that can reveal it
- A compromised backend cannot authorize a merchant, origin, amount, or daily limit beyond the user’s local policy
- A payment credential cannot be reused outside its approved transaction constraints
- Page-derived data cannot return to the agent after a payment credential enters the page
- Every accepted payment maps to one locally authorized payment intent
- A crash, restart, update, revocation, or timeout returns the executor to a locked state

### Explicit non-goals

The implementation cannot guarantee:

- Confidentiality from code that the user installs and authorizes to decrypt unless the user independently verifies that code
- Confidentiality from a compromised approved merchant or PSP that legitimately receives the credential
- Protection from an operating-system administrator or malware with equivalent privilege
- PCI scope exclusion without written confirmation from the acquirer, payment brands, or a QSA

## Why local encryption is necessary but insufficient

The proposed storage shape is better than the current backend vault because it removes cloud plaintext and network transport. It does not remove runtime authority.

### What a non-extractable key protects

A Web Crypto `CryptoKey` generated with `extractable: false` prevents `exportKey` and `wrapKey` from returning raw key material. This reduces the value of a copied IndexedDB record and prevents an accidental raw-key export API.

### What it does not protect

Any extension context that receives the `CryptoKey` and has `decrypt` usage can ask Web Crypto to decrypt ciphertext. The caller then receives plaintext. A malicious service worker, side panel, dependency, update, or exposed decrypt-and-fill command does not need the raw key.

The [Web Crypto API specification](https://www.w3.org/TR/WebCryptoAPI/) separates raw-key extraction from permitted cryptographic operations. It also warns that hostile script can direct operations using a key even when it cannot export the key.

### Storage choice

Use IndexedDB for the dedicated executor. Do not use `localStorage`, which is unavailable to a Manifest V3 service worker. Chrome documents the extension storage choices in [Storage and cookies](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies). Do not use `chrome.storage.sync`, cloud backup, application backup, analytics storage, or server recovery for payment credentials.

Understudy already calls `chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })`. Keep an equivalent restriction for any extension storage area. Treat it as an access-control hardening measure, not a cryptographic boundary. [Chrome’s storage documentation](https://developer.chrome.com/docs/extensions/reference/api/storage) states that `storage.local` persists until extension removal and is exposed to content scripts unless the extension restricts access.

### Unattended use tradeoff

An executor that pays while the person is absent must keep or regain decryption authority without per-transaction user presence. That capability increases the effect of a compromised extension runtime.

Support unattended payment only when all of these controls apply:

- The person created an explicit local preauthorization policy
- The policy names the merchant, vehicle, maximum transaction amount, daily amount, and expiry
- The extension verifies every intent against that policy
- Perflo or the issuer independently enforces a transaction-specific or merchant-specific card limit
- The executor uses a single-use payment credential when available
- The payment tab emits no page-derived content to the agent

Local encryption does not substitute for these authorization controls.

## PCI DSS analysis

PCI DSS is an industry standard enforced through payment-brand and acquirer relationships. It is not, by itself, a statute. Its scope and validation method still create contractual and commercial obligations.

### Consumer-device scope reduction

[PCI SSC FAQ 1283](https://www.pcisecuritystandards.org/faqs/1283/) supports a real scope-reduction argument. The consumer environment can sit outside the developer’s PCI DSS assessment when:

- The consumer is also the cardholder
- The device handles only that cardholder’s own data entry
- The software is used only by that cardholder with the cardholder’s own credentials

The same FAQ states that payment-software development remains subject to applicable secure-development controls. It also states that the developer environment enters scope if the developer stores, processes, or transmits payment data on the consumer’s behalf.

The local executor must preserve every factual condition behind this exception. Cloud backup, remote plaintext processing, support access, debug export, or a remotely controlled generic decrypt primitive can invalidate the intended boundary.

### Encryption does not remove scope by itself

[PCI SSC FAQ 1086](https://www.pcisecuritystandards.org/faqs/1086/) states that strong encryption makes data unreadable but does not, by itself, remove encrypted cardholder data from PCI DSS scope. Systems that can encrypt, decrypt, or manage keys remain relevant to the CDE.

[PCI SSC FAQ 1233](https://www.pcisecuritystandards.org/faqs/1233/) allows a third-party service provider that holds only ciphertext and has no decryption capability to consider that data out of scope under stated conditions. The cleanest Understudy design goes further: the backend receives neither ciphertext nor keys.

### Virtual and single-use PANs

Perflo’s cards are virtual, but virtual form does not remove PCI scope. [PCI SSC FAQ 1286](https://www.pcisecuritystandards.org/faqs/1286/) states that PCI DSS applies to electronic-only PANs for participating payment brands.

A one-time PAN is not automatically out of scope. [PCI SSC FAQ 1285](https://www.pcisecuritystandards.org/faqs/1285/) states that treatment depends on payment-brand restrictions. Obtain the issuer’s and payment brand’s written position before relying on a single-use property for scope reduction.

Transaction and daily limits remain valuable risk controls. They cap loss; they do not convert a PAN into non-card data.

### CVV storage prohibition

The executor MUST NOT persist CVV, CVC, CID, or any equivalent card verification code.

[PCI SSC FAQ 1280](https://www.pcisecuritystandards.org/faqs/1280/) prohibits retaining verification codes after authorization, including for future or concierge-style transactions and even when encrypted. Customer consent does not permit retention.

[PCI SSC FAQ 1574](https://www.pcisecuritystandards.org/faqs/1574/) applies the prohibition to organization-provided consumer software and password-vault-like functionality. A narrow exception exists for issuers and legitimate issuer-support functions. Perflo’s issuer role does not make Understudy an issuer.

If a checkout requires CVV, use one of these paths:

1. Perflo or the issuer executes the payment without exposing CVV to Understudy
2. Perflo supplies a transaction-scoped credential directly to the local executor and the executor destroys it immediately after that authorization attempt
3. The person enters CVV for that transaction in extension-owned UI, and the executor never persists it

The third option does not support fully unattended payment.

### Secure software lifecycle

PCI SSC recommends using its [Secure Software Standard and Secure Software Lifecycle](https://www.pcisecuritystandards.org/standards/secure-software/) as a baseline for software that accepts payment data. Understudy should apply those controls even if a QSA excludes the consumer device from the formal PCI DSS assessment.

### Required PCI decisions before implementation

Obtain written answers to these questions:

- Which entity is the merchant of record for the parking transaction?
- Which entity’s acquirer relationship governs validation?
- Does the acquirer agree that Understudy’s backend never stores, processes, transmits, or can affect CHD under the final architecture?
- Does the QSA agree that PCI SSC FAQ 1283 applies to the installed executor?
- Does the payment brand treat Perflo’s transaction-specific PAN as single-use for PCI scope?
- Which PCI Secure Software requirements apply to the extension and its development environment?
- Which Self-Assessment Questionnaire (SAQ), Report on Compliance, or Attestation of Compliance applies to each party?

No production card data may enter the executor until these answers are recorded.

## UAE legal and regulatory analysis

The United Arab Emirates is the primary jurisdiction because the target parking flow uses Parkin and the operating context is Dubai. Product counsel must resolve applicability before launch.

### UAE Personal Data Protection Law

The [UAE government’s data-protection summary](https://u.ae/en/about-the-uae/digital-uae/data/data-protection-laws.) identifies Federal Decree-Law No. 45 of 2021 Regarding the Protection of Personal Data as the federal Personal Data Protection Law (PDPL). It covers electronic processing inside and outside the UAE in stated circumstances, requires governance and security, grants data-subject rights, and regulates cross-border transfers.

Treat card aliases, last four digits, transaction metadata, vehicle data, device identifiers, parking locations, and receipts as personal data when they identify or can be linked to a person. The architecture MUST provide:

- A documented lawful basis and purpose for each data element
- Data minimization and a retention schedule
- An accurate privacy notice before enrollment
- Local deletion and account-closure behavior
- Processes for access, correction, restriction, and deletion requests where applicable
- Controller and processor role allocation between Understudy, Perflo, the parking worker, Parkin, and the PSP
- A cross-border transfer assessment for every backend destination
- Security-incident classification and notification procedures

Keeping PAN outside the backend reduces exposure. It does not remove privacy obligations for aliases, payment events, receipts, device data, or parking history.

### UAE payment-services regulation

The Central Bank of the UAE (CBUAE) [Retail Payment Services and Card Schemes Regulation](https://rulebook.centralbank.ae/en/rulebook/312-retail-payment-services-and-card-schemes-regulation) regulates listed retail payment services and card schemes. Its definition of a [Payment Initiation Service](https://rulebook.centralbank.ae/en/rulebook/article-1-definitions-52) covers initiating a payment order at a user’s request against an account held at another PSP.

The regulation includes a [technical-service-provider exclusion](https://rulebook.centralbank.ae/en/rulebook/exclusions), but that exclusion expressly does not cover Payment Initiation or Payment Account Information Services. A browser automation label therefore does not resolve classification.

Obtain a written UAE regulatory opinion on whether Understudy, the parking worker, or Perflo performs Payment Initiation Services. If Understudy falls into that category, the regulation’s licensing, contractual, security, consent, liability, and insurance requirements may apply.

For a regulated Payment Initiation Service, [Article 17](https://rulebook.centralbank.ae/en/rulebook/article-17-contractual-arrangements) requires explicit user consent, protects personalized security credentials, prohibits requesting or storing sensitive payment data, restricts data use to the requested service, and prohibits changing the amount, payee, or another transaction feature. These controls align with the local intent and policy requirements below.

### Consumer protection and unauthorized transactions

CBUAE’s [Consumer Protection Standards](https://rulebook.centralbank.ae/en/rulebook/consumer-protection-standards) govern licensed financial institutions and include secure validation, unauthorized-transaction reporting, investigation, card blocking, and refund procedures. Understudy may not be the regulated institution, but Perflo’s or the issuer’s duties affect the integration contract and incident workflow.

The product contract and interface MUST identify:

- How the person consents to each payment or preauthorization policy
- How the person revokes unattended authority
- How the person reports an unauthorized payment
- Which party blocks the card or payment credential
- Which party investigates and communicates status
- Which transaction record acts as evidence without retaining card data

### Conditional laws outside the UAE

If the service targets or monitors people outside the UAE, assess the laws of those markets before launch. This includes the European Union General Data Protection Regulation, the United Kingdom General Data Protection Regulation, and applicable United States state privacy and breach laws.

Do not claim global compliance from a UAE and PCI review. Maintain a jurisdiction launch matrix and block unsupported markets.

## Architecture options considered

The selected order minimizes the number of systems that can access payment credentials.

| Option | Backend sees PAN | General agent sees PAN | Main risk | Decision |
|---|---:|---:|---|---|
| Perflo or issuer executes payment | No | No | External capability and commercial dependency | Preferred |
| PSP hosted fields or merchant token | No | No | Merchant and PSP integration dependency | Preferred |
| Separate local payment executor | No | No by design | Local runtime and update-chain trust | Conditional fallback |
| Local vault inside current Understudy extension | No at rest | Recoverable through current command and observation surfaces | General debugger is a decryption oracle | Rejected |
| Existing Understudy server vault | Yes | Intended no, but currently recoverable | Cloud plaintext and confirmed observation defect | Rejected |
| Browserbase or another cloud browser | Cloud executor handles PAN | Depends on implementation | Cloud CDE and third-party scope | Rejected for the stated goal |
| Save PAN and CVV in encrypted IndexedDB | No at rest | Runtime can decrypt | CVV retention prohibition and runtime compromise | Prohibited |

### Rejected shortcuts

Do not implement any of these shortcuts:

- Add a local `fill_secret(ref)` handler and leave other commands unchanged
- Store the key beside ciphertext and call the feature “zero knowledge”
- Disable screenshots but retain accessibility, dialogs, URLs, titles, logs, or generic CDP access
- Redact only known card input values
- Trust a backend-supplied allowlist without checking a locally saved policy
- Rely on a virtual card’s daily limit as the only authorization control
- Treat a virtual or single-use PAN as automatically outside PCI DSS
- Store CVV because it is encrypted, user-approved, or issuer-generated
- Let the parking worker embed payment credentials in a URL
- Resume a general agent session in the same tab after inserting card data

### Why Browserbase’s Stripe example does not meet this goal

The [Browserbase agentic credit card automation quickstart](https://docs.browserbase.com/integrations/stripe/quickstart) demonstrates a different risk decision. Its sample expands a Stripe Issuing card’s number and CVC into the application process, logs the assembled `cardInfo`, passes payment information into Stagehand instructions, and fills the fields in a Browserbase cloud session.

That example does not preserve the requirement that the automation service never handles card data. The page does not state the PCI scope determination or controls that make Browserbase or its customers comfortable with the design. Product documentation and the availability of virtual-card spending controls do not establish that the same architecture is suitable for Understudy.

Understudy would need to accept a cloud CDE, third-party service-provider scope, card-data logging risk, and corresponding contracts if it copied that model. This document rejects those tradeoffs because the stated goal is to keep card data out of Understudy’s service.

## Target architecture

The fallback architecture separates planning from payment execution. The parking worker may prepare parking details, but only the local executor may obtain and submit payment credentials.

```text
iPhone request
  -> parking worker validates parking details and obtains quote
  -> backend creates bounded payment intent without card data
  -> local payment executor verifies local policy and intent
  -> executor obtains or decrypts transaction credential locally
  -> executor opens an isolated approved checkout
  -> executor submits payment in sensitive mode
  -> executor destroys the payment context and closes the tab
  -> parking worker confirms parking independently
  -> backend receives structured status without page content or card data
```

### Trust boundary

The backend MAY request a payment. It MUST NOT authorize one beyond the local policy.

The local executor MUST independently decide:

- Whether the merchant is allowed
- Whether the top-level and frame origins are allowed
- Whether the vehicle, zone, duration, amount, and currency match local policy
- Whether the intent is fresh and unused
- Whether interactive approval or unattended preauthorization applies
- Whether Perflo’s issuer-side limits match the transaction
- Whether checkout integrity remains valid through submission

### Payment result

The executor MUST NOT return a screenshot, accessibility tree, URL, title, DOM text, dialog, or browser error after payment begins. It MAY return only a structured result generated by trusted local code:

```typescript
type PaymentResult =
  | { status: "approved"; intentId: string; providerRef?: string }
  | { status: "declined"; intentId: string; reasonCode: string }
  | { status: "unknown"; intentId: string };
```

The `providerRef` MUST match a strict non-card pattern. It MUST NOT contain a PAN fragment beyond approved last-four display, a URL, arbitrary page text, or a provider error body.

## Requirements for Perflo

The cleanest design requires Perflo to expose a payment capability that remains inside a user-controlled or issuer-controlled environment.

### Required capability order

Perflo SHOULD provide one of these capabilities, in order:

1. Execute an approved merchant payment and return status without exposing PAN
2. Return a merchant-scoped PSP token through a local user-bound channel
3. Mint a transaction-specific virtual card with exact amount, currency, merchant, expiry, and one-use limits
4. Deliver PAN and any transaction authentication data directly to the local executor, never through Understudy’s service

### Required Perflo controls

The Perflo integration MUST support:

- Device-bound user authentication using an approved browser or local-agent flow
- A scope limited to the required payment or virtual-card operation
- Direct communication between Perflo and the local executor
- No card data in redirects, URL query strings, referrers, logs, analytics, or Understudy callbacks
- Transaction-specific amount and currency limits
- Merchant or merchant-category restrictions when the issuer supports them
- Short expiry and one-use enforcement
- Immediate revocation
- A non-card transaction-status API
- Idempotency and replay protection
- Auditable proof of the issuer-enforced constraints
- Written PCI responsibility and incident-response allocation

If Perflo can only return reusable card details, the executor MUST treat that option as the fallback local-vault design. Perflo’s virtual-card label does not change PCI treatment by itself.

### Information required from Perflo

Do not finalize implementation until Perflo answers:

- Can Perflo execute a Parkin payment directly?
- Can Perflo tokenize a card for Parkin or its PSP?
- Can a local browser extension or local agent authenticate without routing credentials through Understudy?
- Can Perflo mint a card for one merchant and one exact amount?
- Can Perflo set per-transaction, per-session, and daily limits?
- Is the card single-use at the payment-brand level?
- Does the card require a static CVV, dynamic CVV, 3-D Secure challenge, or another authentication step?
- Can Perflo provide a transaction-specific credential without allowing Understudy to retain CVV?
- Which party is the issuer and which PCI attestation covers the issuing API?
- Which logs, support tools, and administrators can access card data?
- How are unauthorized transactions blocked, investigated, and reimbursed?

## Requirements for the parking worker and Parkin checkout

The parking worker coordinates parking. It MUST NOT become a card vault or a generic remote browser controller during payment.

### Parking worker requirements

The parking worker MUST:

- Accept the external iPhone request without card data
- Validate vehicle, zone, duration, and quote before creating an intent
- Create a checkout URL containing parking details only
- Never put PAN, expiry, CVV, card alias, vault identifier, or authorization token in a URL
- Bind the intent to the quoted amount and currency
- Use a nonce and short expiry
- Confirm parking through a supported Parkin API or an independent status check after payment
- Treat `unknown` as unresolved and reconcile before retrying
- Never retry a payment with a new intent until it proves the previous attempt did not succeed

### Parkin and PSP requirements

Before automation, obtain and pin:

- Exact top-level checkout origins
- Exact payment-frame origins
- Every redirect origin used for authentication or 3-D Secure
- The supported success and failure contract
- The amount, currency, merchant, and reference fields that the executor must verify
- Whether hosted fields or tokenization exists
- Whether automation complies with Parkin’s and the PSP’s contractual terms
- A change-notification or versioning mechanism for checkout changes

Do not automate an unsupported checkout whose scripts or origins can change without notice.

## Normative data requirements

The executor must minimize every stored or transmitted data class before applying encryption or access controls.

### Data classification

Classify data before implementation:

| Data | Classification | Storage rule |
|---|---|---|
| PAN | CHD | Local encrypted vault only under fallback design |
| Expiry | CHD when stored with PAN | Same vault record as PAN |
| Cardholder name | CHD when stored with PAN | Store only if checkout requires it |
| CVV, CVC, CID | SAD | Never persist |
| Card alias | Sensitive identifier | Local and backend may store only if it cannot reveal or authorize the card alone |
| Last four digits | Display metadata | Local display; backend only when contract and privacy purpose require it |
| Payment intent | Sensitive transaction data | Backend and local storage with strict retention |
| Parking details | Personal and location data | Minimize and retain under documented purpose |
| Receipt and provider reference | Transaction record | Store without PAN, arbitrary page text, or sensitive authentication data |

### Collection and display

The executor MUST collect card enrollment in extension-owned UI. It MUST NOT collect card data in a content script, web page controlled by Understudy’s backend, externally hosted form, support tool, log console, or MCP conversation.

The UI MUST:

- Mask PAN except during initial entry and explicit local reveal
- Show only the last four digits after enrollment
- Disable copy and export by default
- Explain where the card is stored and that no recovery exists
- Explain unattended-payment limits before enabling them
- Require explicit confirmation before deleting a card
- Remove the local record and wrapped keys when deletion succeeds

### Retention

The executor MUST define retention by data type. It MUST delete:

- CVV immediately after the one authorization attempt, whether approved, declined, unknown, or crashed
- Decrypted PAN and expiry immediately after local insertion
- Sensitive payment-tab state when the payment ends or becomes unknown
- Expired and consumed intents after the reconciliation window
- Vault records when the person deletes the card or uninstalls the payment executor

The backend MUST NOT retain page artifacts from a payment tab because none may leave the executor.

## Normative vault and key requirements

Vault controls protect stored data and constrain normal execution. They do not make a compromised decrypting runtime trustworthy.

### Cryptography

The local vault MUST:

- Use the browser Web Crypto API
- Use an authenticated-encryption mode such as AES-256-GCM
- Generate a unique random 96-bit nonce for every encryption under one key
- Never reuse an AES-GCM key and nonce pair
- Bind record version, card identifier, and local policy identifier as additional authenticated data
- Generate keys with `extractable: false`
- Limit key usages to the required operations
- Validate ciphertext version and lengths before decryption
- Fail closed on any authentication or parsing error

Cryptographic agility MUST use an explicit versioned envelope. Do not implement a generic algorithm negotiation surface.

### Key lifecycle

The executor MUST:

- Generate the vault key locally
- Keep the key out of `storage.sync`, server backup, logs, telemetry, exports, and support tooling
- Lock after browser restart, extension update, device revocation, re-pairing, emergency stop, inactivity timeout, or integrity failure
- Destroy in-memory plaintext and key references on lock
- Support local card deletion without retaining a recovery copy
- Document that losing the local key makes the card record unrecoverable

The executor SHOULD use operating-system or hardware-backed user-presence wrapping when the platform can provide a verifiable implementation. A native companion expands the security scope and requires its own audit, update policy, and signing controls.

### Isolation

The payment vault MUST run in a separate extension or separately signed local component from the general Understudy debugger host. It MUST NOT expose a plaintext-returning message, port, RPC, content-script, external-message, native-message, or debugging API.

If product constraints force one extension package, payment code MUST run in an isolated context with a narrow message schema and no reference to the general session WebSocket. This weaker alternative requires written QSA and security approval.

## Normative payment-intent requirements

The backend may request a payment only with a bounded intent. It MUST NOT send card fields or a destination element ref.

An intent schema SHOULD contain:

```typescript
type PaymentIntent = {
  version: 1;
  intentId: string;
  deviceId: string;
  merchantId: "parkin-ae";
  amountMinor: number;
  currency: "AED";
  vehicleRef: string;
  zoneRef: string;
  parkingDurationMinutes: number;
  checkoutOrigin: string;
  paymentFrameOrigins: string[];
  createdAt: string;
  expiresAt: string;
  nonce: string;
  signature: string;
};
```

The final schema MUST use bounded strings, bounded arrays, canonical origin serialization, safe integer amounts in minor units, and a strict version discriminator.

### Intent validation

The executor MUST reject an intent unless:

- Its signature is valid
- Its schema and version are supported
- `intentId` and `nonce` are unused on this device
- `deviceId` matches the local device
- Current time falls within a short allowed window
- Amount is a positive safe integer
- Currency matches local policy
- Merchant, vehicle, zone, duration, and amount fall within local policy
- Checkout and frame origins exactly match local policy
- Required issuer-side card limits are active
- The approval or preauthorization remains valid

A backend signature prevents network alteration and cross-service forgery. It does not authorize the backend to exceed local policy. The local policy remains authoritative.

### Replay and idempotency

The executor MUST persist a local state for every accepted intent:

```typescript
type PaymentIntentState =
  | "accepted"
  | "executing"
  | "approved"
  | "declined"
  | "unknown";
```

An `approved`, `declined`, or `unknown` intent MUST NOT execute again. Reconciliation may change `unknown` to `approved` or `declined`, but it MUST NOT silently create a new charge.

## Normative local-policy requirements

The person MUST create or approve local policy in the payment executor. The backend may request a subset; it MUST NOT change the policy.

The policy MUST support:

- Exact merchant identifier
- Exact checkout and frame origins
- Allowed currency
- Maximum amount per transaction
- Maximum daily amount and transaction count
- Vehicle and optional zone restrictions
- Policy expiry
- Interactive approval or unattended preauthorization mode
- Required Perflo or issuer controls
- Immediate local disable and card deletion

The extension currently reports its saved `originPolicy` to the backend, while a later server `provision` frame supplies `allowedOrigins` to `SessionManager`. The extension does not independently check that the provisioned origins remain a subset of its saved policy. The payment executor MUST perform this check locally for every intent and every navigation.

## Normative checkout-isolation requirements

The executor MUST create a new isolated payment tab or profile. It MUST never adopt an existing person-controlled tab.

Before credential release, it MUST verify:

- The exact top-level origin
- Every ancestor and payment-frame origin
- The merchant identity
- The displayed amount and currency
- The vehicle, zone, duration, and reference when displayed
- The absence of an unapproved redirect, popup, or frame
- The issuer-side card constraint status

The executor MUST select payment fields itself. The backend, agent, parking worker, and checkout page MUST NOT supply a reusable DOM or accessibility ref for secret release.

Field identification MUST use a versioned merchant adapter with strict semantic checks. A generic “find card-looking fields” algorithm is prohibited.

### Page trust limitation

The approved checkout becomes an intended recipient of card data. Same-page JavaScript may read ordinary input values. The executor cannot make a compromised merchant safe by hiding an export API.

Prefer PSP-hosted, cross-origin fields where the merchant page cannot read PAN. Pin the PSP frame origins and reject any unexpected frame tree.

## Normative sensitive-mode requirements

Sensitive mode begins before any card credential is decrypted or fetched. It ends only after the payment context is destroyed.

During sensitive mode, the executor MUST reject or suppress:

- Accessibility snapshots
- Screenshots or video
- DOM snapshots
- Generic CDP Runtime evaluation
- Network response-body capture
- Console and exception forwarding
- Dialog text and default prompts
- URL, title, referrer, and tab metadata export
- Generic click, type, key, scroll, and navigate commands from the agent
- Clipboard operations
- Downloads
- Extension logs that include page or command data
- Crash reports containing memory or page state
- Analytics and telemetry beyond fixed enumerated counters

Do not resume general agent control in the tainted tab. Close the tab and destroy its runtime after an approved, declined, or unknown result.

The executor MUST return `unknown` when it cannot prove whether submission occurred. It MUST reconcile through a trusted provider or parking-status API before allowing another intent.

## Normative backend requirements

Understudy’s backend MUST remain card-blind:

- No PAN, expiry, cardholder name, CVV, ciphertext, key, wrapped key, or recoverable backup
- No endpoint for card enrollment, retrieval, export, recovery, support access, or migration
- No card data in WSS frames, Durable Object state, KV, D1, Analytics Engine, logs, traces, errors, or alerts
- No general command that asks the payment executor to decrypt or fill an arbitrary target
- No page artifacts from a payment tab
- No remotely broadened local policy
- No payment retry without reconciliation

The backend MAY store:

- Opaque intent identifiers
- Opaque local card aliases that cannot reveal or authorize the card
- Merchant, amount, currency, parking reference, structured status, and timestamps under a documented retention policy
- A strictly formatted provider reference that contains no card data

Backend logs MUST use enumerated reason codes. They MUST NOT include raw request bodies, provider error bodies, URLs, page content, or arbitrary exception strings from the payment executor.

## Normative agent and API requirements

The agent API MUST expose a payment request, not card primitives.

Allowed surface:

```text
request_parking_payment(
  vehicle_ref,
  zone_ref,
  duration_minutes,
  quoted_amount_minor,
  currency,
  idempotency_key
)
```

Prohibited surfaces include:

- `list_cards` returning anything beyond local aliases and masked display metadata
- `get_card`
- `export_card`
- `decrypt_secret`
- `fill_payment_field(ref, card_alias)`
- `screenshot_payment`
- `snapshot_payment`
- Arbitrary checkout URLs
- Card data passed through prompts, MCP resources, tool results, or model context

An agent result MUST contain only structured payment status and opaque references.

## Normative update and supply-chain requirements

The party that can update the extension can ship code that decrypts stored cards. Update governance therefore affects both security and PCI scope.

The payment executor MUST use:

- Manifest V3 with no remote hosted code
- A minimal permission set
- A separate signing and publisher account from the general automation extension where practical
- Hardware-backed multifactor authentication for publisher and release accounts
- Two-person release approval
- Reproducible build comparison against the published artifact
- Source and artifact provenance
- A software bill of materials
- Locked dependencies and the repository’s minimum release-age policy
- Dependency and secret scanning
- Static analysis and tested Content Security Policy
- A documented emergency revoke and forced-lock path
- A public or customer-visible security contact and response target

Every release that changes vault, policy, intent, origin, checkout, update, logging, or message code requires an independent security review.

## Normative privacy requirements

The product MUST publish an accurate privacy notice before enrollment. It MUST distinguish local-only card data from backend transaction metadata.

The notice and internal data inventory MUST state:

- Which card fields stay local
- Which transaction and parking fields reach Understudy, Perflo, Parkin, and the PSP
- Retention periods
- Cross-border processing locations
- Deletion behavior
- The absence or presence of backup and recovery
- Support access boundaries
- Incident-notification channels
- The legal entities acting as controller or processor

Do not describe the system as “zero knowledge” unless an independent review confirms that neither the service, update authority, support path, nor command architecture can cause plaintext disclosure. “Backend does not receive card data during normal operation” is narrower and may still be inaccurate if the backend can command the executor to reveal it.

## Normative incident-response requirements

Before production, assign owners and run exercises for:

- Suspected extension compromise
- Publisher-account compromise
- Leaked or replayed payment intent
- Unauthorized payment
- Merchant or PSP checkout compromise
- Perflo card-control failure
- Lost device or browser profile
- Card deletion failure
- Backend receipt of suspected card data
- Unknown payment outcome

The response system MUST support:

- Immediate local vault lock
- Remote disable that cannot unlock or export the vault
- Perflo card revocation
- Blocking new payment intents
- Preserving non-card forensic evidence
- Detecting and purging accidental card data from logs and storage
- User notification and support routing
- Regulatory, acquirer, issuer, and payment-brand escalation under the applicable plan

Do not collect sensitive page artifacts “for debugging” during an incident.

## Implementation map

The fallback design should use existing Understudy patterns without extending the unsafe secret path.

### Reuse

Reuse these patterns:

- Strict Zod protocol schemas in `packages/protocol/src/index.ts`
- Prepare, grant, result, and unknown-outcome semantics in `apps/backend/src/session.ts`
- Bounded WSS parsing in `apps/extension/src/core/ws-client.ts`
- Serialized command admission in `apps/extension/src/core/command-ingress.ts`
- Local emergency stop and device revocation handling in `apps/extension/src/core/profile-client.ts`
- Origin canonicalization patterns in backend validation code
- The repository’s release-age dependency policy and release provenance

Do not reuse these implementations for cards:

- Server vault decryption in `apps/backend/src/vault.ts` and `apps/backend/src/secrets.ts`
- Backend `fill_secret` conversion in `apps/backend/src/session.ts`
- Agent-selected refs in `browser_fill_secret`
- Ordinary `CdpSession.type`
- General session snapshots, screenshots, dialogs, URLs, or tab metadata

### Proposed package boundary

Create a separate payment-executor package or extension. Its dependencies on Understudy SHOULD point inward only to narrow shared value types and validation utilities. The general browser host MUST NOT import the vault implementation.

Suggested components:

- `vault-store`: IndexedDB schema, encryption envelope, key lifecycle, deletion
- `local-policy`: immutable local authorization and usage counters
- `intent-verifier`: schema, signature, device binding, expiry, replay journal
- `merchant-adapters/parkin`: exact origin, frame, field, and result contract
- `sensitive-runtime`: isolated checkout lifecycle and output suppression
- `perflo-client`: direct local authentication, card controls, token or transaction credential
- `payment-ui`: enrollment, approval, preauthorization, revoke, delete
- `payment-result`: fixed structured status only

The final file paths depend on whether the executor remains in this repository. Do not place vault code in `apps/extension/src/core/router.ts` as another generic command case.

## Implementation sequence and release gates

The work must proceed in this order:

### Gate 0: External feasibility

Before coding:

- Obtain Perflo’s answers and choose the highest-ranked supported capability
- Obtain Parkin or PSP checkout origins and integration contract
- Obtain QSA and acquirer scope guidance
- Obtain UAE regulatory classification advice
- Record responsibility for unauthorized transactions and incidents

Done means every answer is written and no critical ownership question remains open.

### Gate 1: Repair the current secret boundary

Fix `SEC-001` across every observation path. Do not add card features as the fix.

Done means an independent test cannot recover a vault secret through ordinary fields, accessibility, screenshots, dialogs, URLs, titles, tabs, errors, logs, or command results.

### Gate 2: Build local policy and intent verification without card data

Implement policy, signatures, expiry, replay protection, state transitions, and issuer-control checks with synthetic credentials.

Done means a compromised test backend cannot broaden merchant, origin, amount, vehicle, duration, or daily limits.

### Gate 3: Build the isolated checkout with synthetic cards

Implement the merchant adapter and sensitive-mode lifecycle using PSP test credentials only.

Done means no page-derived artifact leaves the executor from credential release through tab destruction.

### Gate 4: Build and audit the local vault if still required

Implement enrollment, encryption, lock, deletion, and crash behavior. Use test PANs only.

Done means independent reviewers approve cryptography, architecture, and QA, and no server or general extension surface can invoke decryption.

### Gate 5: Complete compliance and operational evidence

Complete QSA review, privacy assessment, UAE regulatory decision, incident exercises, support training, release hardening, and provider responsibility documents.

Done means every normative requirement maps to an owner, test, or signed external decision.

### Gate 6: Limited canary

Use one test merchant or approved low-limit account. Apply issuer-enforced limits below the maximum expected parking charge.

Done means reconciliation, failure, revocation, update, crash, and unknown-outcome exercises all pass without card data reaching Understudy’s service.

## Required tests

The test plan must prove negative properties, not only successful payment.

### Vault tests

- Ciphertext changes when encrypting the same record twice
- AES-GCM nonce never repeats under one key
- Modified ciphertext, nonce, version, or additional authenticated data fails closed
- Non-extractable key export fails
- Restart, update, revoke, stop, re-pair, and timeout lock the vault
- Deletion removes ciphertext, keys, indexes, cached display data, and pending operations
- No sync or backup API receives a vault record

### Intent and policy tests

- Reject invalid signature, unknown version, stale time, future time outside tolerance, wrong device, reused nonce, and reused intent
- Reject amount overflow, negative amount, currency mismatch, merchant mismatch, vehicle mismatch, zone mismatch, duration mismatch, and origin mismatch
- Reject every server request that exceeds local per-transaction, daily, or count limits
- Preserve `unknown` across restart and prevent duplicate execution
- Prove that a backend-controlled signature cannot override local policy

### Origin and checkout tests

- Reject look-alike hosts, subdomain confusion, username-in-URL forms, non-HTTPS URLs, ports, fragments, and encoded origin tricks
- Reject an unexpected top-level redirect
- Reject an unexpected same-process or out-of-process iframe
- Reject popup and opener changes
- Reject amount or currency changes between intent and checkout
- Reject payment-field changes outside the versioned merchant adapter
- Reject 3-D Secure origins that were not approved before execution

### Exfiltration tests

After a synthetic credential fill, attempt every channel:

- Accessibility snapshot
- Screenshot
- Dialog message and default prompt
- URL, fragment, query, referrer, and title
- Tab metadata
- Console and exception
- Network request and response capture
- DOM snapshot and Runtime evaluation
- Clipboard and download
- Error and crash report
- Extension and backend log
- WSS frame and command journal
- Analytics and telemetry

Done means no synthetic PAN or marker appears outside the isolated executor process or approved PSP endpoint.

### Authorization and abuse tests

- Malicious agent chooses a normal textbox as the target
- Compromised backend broadens `allowedOrigins`
- Backend swaps merchant, amount, currency, vehicle, zone, duration, or card alias
- Backend races two intents against one card limit
- Attacker replays an approved, declined, or unknown intent
- Merchant page reflects the credential into every page surface
- Extension update occurs while an intent is executing
- Browser crashes after submit but before result
- Perflo returns a card without the promised limit
- Parkin confirms parking after the local executor reports `unknown`

### Supply-chain tests

- Published artifact matches the reproducible build
- Manifest contains no unexpected permission, host, content script, or externally connectable surface
- Bundle contains no remote-code loader, dynamic script URL, or eval-like path
- Dependency lock and SBOM match the release
- Publisher and signing-account recovery exercise succeeds
- Emergency disable locks existing vaults without exposing card data

## Verification commands

Run repository checks from the Understudy root:

```bash
pnpm build
pnpm typecheck
pnpm test
```

Run focused extension checks during payment work:

```bash
pnpm --filter @understudy/extension typecheck
pnpm --filter @understudy/extension test
pnpm --filter @understudy/extension build:store
```

Add a dedicated executor command set before implementation. The final continuous-integration gate MUST run unit, integration, real-Chromium, reproducible-build, and static security checks.

Passing existing tests is not evidence that the payment boundary is safe. The current 154-test extension run passes while `SEC-001` remains exploitable.

## Acceptance criteria

The feature may enter production only when every item is true:

- Perflo or PSP capability choice is recorded
- No saved or transient CVV exists after an authorization attempt
- Understudy’s backend receives no PAN, expiry, CVV, vault ciphertext, or vault key
- The general agent has no decrypt, arbitrary-fill, snapshot, or page-artifact path into the executor
- Local policy cannot be broadened remotely
- Payment intent prevents merchant, amount, currency, vehicle, zone, duration, and replay substitution
- Perflo or the issuer independently enforces the promised transaction controls
- Sensitive mode blocks every tested exfiltration channel
- Payment tabs are destroyed and never return to general agent control
- Unknown outcomes reconcile before any retry
- Current `SEC-001` is fixed and independently verified
- Cryptography, architecture, and QA review lanes are clean
- QSA and acquirer provide written scope guidance
- UAE counsel records the payment-services classification
- Privacy data map, notice, retention, deletion, and incident procedures are complete
- Release, publisher, dependency, and emergency-revoke controls are tested
- Canary evidence contains no card data and no duplicate charge

## Open decisions

These decisions block a final implementation plan:

| Decision | Owner | Required evidence |
|---|---|---|
| Perflo executes, tokenizes, or returns a local transaction card | Perflo and Understudy | API contract and security architecture |
| CVV-free or transaction-only authentication path | Perflo or issuer | Written issuer behavior and test flow |
| Parkin checkout and frame origins | Parkin or PSP | Supported integration contract |
| Merchant-of-record and acquirer relationship | Business and payments counsel | Executed agreements |
| PCI scope and validation method | Acquirer and QSA | Written scope determination |
| UAE Payment Initiation Service classification | UAE regulatory counsel or CBUAE | Written opinion or regulator response |
| Separate executor packaging and update ownership | Understudy security | Architecture decision record |
| Interactive approval versus unattended preauthorization | Product and risk | Local policy, issuer limits, and loss model |
| Receipt and reconciliation source | Parking worker and Parkin | Status API contract |

## Appendix: Current-state source anchors

The snippets below prove the current behavior at the baseline commit. Read each file again before editing.

### Protocol accepts an arbitrary ref for `fill_secret`

File: `packages/protocol/src/index.ts`, `CommandSchema`

```typescript
strictObject({
  type: z.literal("fill_secret"),
  ...CommandBase,
  ref: RefSchema,
  secretRef: z.string().min(1).max(512),
  submit: z.boolean().optional(),
}),
```

Target behavior: payment requests contain an intent and opaque local alias. They never contain a DOM or accessibility ref.

### Backend decrypts and converts the secret to ordinary text

File: `apps/backend/src/session.ts`, `dispatchV2`

```typescript
const secret = resolution.value;
grantedCommand = {
  type: "type",
  commandId: command.commandId,
  ref: command.ref,
  text: secret,
  submit: command.submit,
};
```

Target behavior: the backend never resolves payment credentials. The dedicated local executor handles the intent without using the general `type` command.

### Extension routes ordinary text without a payment boundary

File: `apps/extension/src/core/router.ts`, `routeCommandUnchecked`

```typescript
case "type": {
  const { ref, text, submit } = cmd;
  return await withSession(
    session,
    cmd.commandId,
    (s) => s.type(cmd.commandId, ref, text, submit),
  );
}
```

Target behavior: no card plaintext enters this router or `Command` union.

### Accessibility snapshots include node values

File: `apps/extension/src/driver/a11y.ts`, `buildA11ySnapshot`

```typescript
const value = axString(node.value);
if (value !== undefined) {
  if (utf8ByteLength(value) > 4 * 1024) {
    throw new Error("a11y value exceeds 4096 bytes");
  }
  self.value = value;
}
```

Target behavior: the payment executor emits no accessibility tree after sensitive data enters the checkout.

### MCP rendering returns accessibility values

File: `apps/backend/src/mcp/outcomes.ts`, `renderTree`

```typescript
const value =
  node.value === undefined
    ? ""
    : ` value=${JSON.stringify(node.value)}`;
lines.push(
  `${indent}- ${node.role}${name}${value} [ref=${node.ref}]`,
);
```

Target behavior: payment results use a fixed structured schema and never contain page-derived text.

### Server provisioning becomes the local session policy

File: `apps/extension/src/core/session-manager.ts`, `provision`

```typescript
const assignment: ManagedAssignment = {
  sessionId: input.sessionId,
  leaseId: input.leaseId,
  leaseEpoch: input.leaseEpoch,
  browserEpoch: input.browserEpoch,
  allowedOrigins: input.allowedOrigins,
  tabId: tab.id,
  windowId: createdWindow.id,
};
```

The backend checks that requested origins are a subset of enrolled device policy. The extension does not repeat that check before accepting the provisioned policy.

Target behavior: the payment executor verifies every intent and navigation against its own locally stored policy.

### Local storage already restricts content-script access

File: `apps/extension/src/core/profile-client.ts`, `restrictLocalStorage`

```typescript
const area = browser.storage.local as Browser.storage.StorageArea & {
  setAccessLevel?: (options: {
    accessLevel: "TRUSTED_CONTEXTS";
  }) => Promise<void>;
};
await area.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" });
```

Reuse this access restriction. Do not treat it as protection from trusted extension contexts or from code with decryption authority.

## References

Primary sources used in this analysis:

- [PCI SSC FAQ 1086: encrypted cardholder data and PCI DSS scope](https://www.pcisecuritystandards.org/faqs/1086/)
- [PCI SSC FAQ 1233: encrypted cardholder data held by third-party service providers](https://www.pcisecuritystandards.org/faqs/1233/)
- [PCI SSC FAQ 1280: card verification codes for card-on-file and recurring transactions](https://www.pcisecuritystandards.org/faqs/1280/)
- [PCI SSC FAQ 1283: payment software on a consumer device](https://www.pcisecuritystandards.org/faqs/1283/)
- [PCI SSC FAQ 1285: one-time and single-use PANs](https://www.pcisecuritystandards.org/faqs/1285/)
- [PCI SSC FAQ 1286: virtual PANs](https://www.pcisecuritystandards.org/faqs/1286/)
- [PCI SSC FAQ 1574: consumer software and card verification-code storage](https://www.pcisecuritystandards.org/faqs/1574/)
- [PCI Secure Software Standard](https://www.pcisecuritystandards.org/standards/secure-software/)
- [Chrome extension storage API](https://developer.chrome.com/docs/extensions/reference/api/storage)
- [Chrome extension storage and cookies](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies)
- [Chrome debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger)
- [Web Cryptography API](https://www.w3.org/TR/WebCryptoAPI/)
- [Browserbase agentic credit card automation quickstart](https://docs.browserbase.com/integrations/stripe/quickstart)
- [UAE government summary of data-protection laws](https://u.ae/en/about-the-uae/digital-uae/data/data-protection-laws.)
- [CBUAE Retail Payment Services and Card Schemes Regulation](https://rulebook.centralbank.ae/en/rulebook/312-retail-payment-services-and-card-schemes-regulation)
- [CBUAE definition of Payment Initiation Service](https://rulebook.centralbank.ae/en/rulebook/article-1-definitions-52)
- [CBUAE payment-services exclusions](https://rulebook.centralbank.ae/en/rulebook/exclusions)
- [CBUAE Article 17 contractual arrangements](https://rulebook.centralbank.ae/en/rulebook/article-17-contractual-arrangements)
- [CBUAE Consumer Protection Standards](https://rulebook.centralbank.ae/en/rulebook/consumer-protection-standards)

## Document plan and maintenance

This page has one job: decide the architecture and define the release conditions for local payment execution. Update it whenever code, merchant origins, Perflo capabilities, payment roles, PCI guidance, UAE regulation, or the update model changes.

The content plan is:

1. Record verified current behavior and defects
2. Define the legal, PCI, privacy, and threat boundaries
3. Select the safest feasible architecture
4. Express implementation requirements and prohibited shortcuts
5. Define tests, external decisions, and release gates

Open questions remain in the “Open decisions” section. The owner of each decision must update this document with evidence before the corresponding gate closes.
