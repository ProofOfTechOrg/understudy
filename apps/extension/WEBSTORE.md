<!-- Content type: Reference -->

# Submit Understudy 0.2.0 to the Chrome Web Store

Build and inspect the store artifact before upload:

```bash
pnpm --filter @understudy/extension build:store
pnpm --filter @understudy/extension zip:store
zipinfo -1 apps/extension/.output/understudyextension-0.2.0-chrome-store.zip
curl --fail --silent --show-error https://understudy.proofof.tech/privacy >/dev/null
```

Confirm `manifest.json` is at the archive root. Distribution is unlisted, free,
all regions, category Productivity → Tools.

## Listing copy

**Title:** Understudy Beta

**Short description:** Pair Chrome with Understudy so an authorized AI client
can operate controlled tabs on exact origins you allow.

**Detailed description:**

```text
UNDERSTUDY IS BETA SOFTWARE.

Understudy pairs a dedicated Chrome profile with the hosted Understudy service. An AI client you authorize can open and operate extension-owned tabs only on exact website origins you allow.

Pairing is approved directly between the Understudy dashboard and the installed extension. The side panel shows device and policy state, controlled-window inventory, connection recovery, an emergency stop, and a local troubleshooting log.

The optional payment-card vault is stored only in this extension's local IndexedDB. Card fields are encrypted with a non-extractable local key and are never sent to the Understudy backend. Card submission requires both the dashboard origin policy and a separate local payment-origin approval. After card data is inserted, Understudy reports only that the outcome is unknown and closes the controlled tab.

Understudy does not choose tasks or approve actions. Your connected AI client selects page elements and requests actions. You control pairing, allowed origins, local cards, API or OAuth connections, and device revocation.

For ordinary browser work the service may handle controlled-tab URLs and titles, website content, accessibility trees, screenshots, dialogs, requested input actions, browser metadata, status, errors, and command results. From payment sensitive-mode entry onward those observation channels are suppressed.

Use a dedicated Chrome profile. Controlled tabs in one profile share that profile's cookies and browser storage. Chrome's debugger banner is process-wide and cannot be suppressed by an extension.
```

Homepage: `https://understudy.proofof.tech/dashboard`

Support: `https://github.com/ProofOfTechOrg/understudy/issues`

Privacy: `https://understudy.proofof.tech/privacy`

Single purpose:

```text
Pair Chrome with Understudy so an AI client the user authorizes can operate extension-owned tabs only on website origins the user allows, including optional submission of locally encrypted cards on separately approved payment origins.
```

## Permissions

- `debugger`: attach CDP only to extension-owned controlled tabs for requested
  page observation and actions.
- `storage`: retain the device credential and policy state, the physical-window
  and recovery registry, and the encrypted local card vault with its
  non-extractable key.
- `alarms`: provide a Manifest V3 wake-up backstop for connection recovery,
  policy/inventory reconciliation, and exact controlled-window cleanup.
- `sidePanel`: pair, show connection and policy state, stop hosting, and manage
  local cards and payment origins.
- `https://understudy.proofof.tech/*`: receive direct one-time pairing offers,
  request short-lived connect tickets, and exchange validated control/session
  frames over HTTPS and WSS.

The package requests neither `tabs` nor `activeTab`. Select **No remote code**:
all executable code is bundled; remote commands are validated data, not code.

## Data-use declarations

Declare, conservatively:

- Personally identifiable information
- Authentication information
- Financial and payment information
- Web history
- User activity
- Website content
- Personal communications

The local card vault handles payment information even though its plaintext,
ciphertext, and key do not cross the extension boundary. Do not claim that
local-only storage removes the category. Confirm the privacy policy states that
Understudy does not sell data, use it for advertising, or permit routine human
review.

## Reviewer flow

Do not provide a shared API token, pairing offer, mailbox password, card, or
personal login. The reviewer uses temporary data.

```text
1. Install the extension and open its side panel. While unpaired it remains idle.
2. Open the dashboard from the panel and sign in with an email address you control.
3. Add https://example.com to the default origins.
4. Choose Pair this browser. The installed extension receives and redeems the one-time offer directly; no code is copied.
5. Create a browser-bound API token or connect an OAuth-capable MCP client to https://understudy.proofoftech/mcp and select this device at consent.
6. Ask the client to open https://example.com. The panel reports one controlled window.
7. Add a synthetic test card in the side panel and approve https://example.com as a payment origin. Card details stay in local encrypted extension storage.
8. Delete the card. Choose Stop hosting and confirm that the controlled window closes.
9. Revoke the device in the dashboard. Existing API and OAuth access for that device fails immediately.

Chrome's debugger banner is process-wide. Dismissing it can detach a controlled tab and does not identify which tab is controlled.
```

Upload only after the full automated gate and the real-Chrome acceptance flow
in `RUNBOOK.md` pass. Store submission is a manual external mutation.
