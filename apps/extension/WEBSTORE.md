<!-- Content type: Reference -->

# Submit Understudy Beta to the Chrome Web Store

This reference contains the exact dashboard copy, disclosures, reviewer flow, and asset paths for the first unlisted Understudy Beta submission. Do not submit until the hosted privacy URL returns `200`.

## Block submission until the privacy page is live

The submission is blocked until this command succeeds:

```bash
curl --fail --show-error --silent \
  https://understudy.proofof.tech/privacy > /dev/null
```

The code in this repository does not deploy the backend or upload the extension.

## Upload the package

Build and inspect the store package from the repository root:

```bash
pnpm --filter @understudy/extension build:store
pnpm --filter @understudy/extension zip:store
zipinfo -1 apps/extension/.output/understudyextension-0.1.2-chrome-store.zip
```

Upload `apps/extension/.output/understudyextension-0.1.2-chrome-store.zip`. Confirm `manifest.json` is at the archive root before uploading.

## Enter distribution settings

- **Payments**: Free
- **Contains in-app purchases**: No
- **Visibility**: Unlisted
- **Regions**: All regions

These payment declarations describe the current beta, which has no billing flow. An unlisted item does not appear in Chrome Web Store search, but anyone with its listing URL can install it. Unlisted items receive the same policy review as public items.

To introduce paid hosted-service plans later:

1. Keep the extension installation free. Charge for a separate Understudy hosted-service subscription, not for extension copies that users installed during the free beta.
2. Change **Contains in-app purchases** to **Yes** before enabling paid access.
3. Update the listing with the subscription requirement, price, trial terms, and cancellation path.
4. Add the required business or physical address to the developer account.
5. Update the privacy declarations if the billing flow handles new data, then submit the changes for review.

## Enter store listing details

- **Language**: English
- **Category**: Productivity → Tools
- **Title**: Understudy Beta
- **Short description**: BETA: Pair Chrome with Understudy so your authorized AI client can operate tabs on sites you allow.
- **Official URL**: Select the verified `https://proofoftech.org/` entry. Leave this optional field blank if the dashboard does not offer it.
- **Homepage URL**: `https://understudy.proofof.tech/dashboard`
- **Support URL**: `https://github.com/ProofOfTechOrg/understudy/issues`
- **Privacy policy URL**: `https://understudy.proofof.tech/privacy`
- **Mature content**: No
- **Promotional video**: Leave blank
- **Marquee promo tile**: Leave blank

Use this detailed description:

```text
THIS EXTENSION IS FOR BETA TESTING.

Understudy Beta pairs a dedicated Chrome profile with the hosted Understudy service. After you approve a one-time pairing code, an AI client you authorize can open and operate controlled tabs on the website origins you allow.

Understudy Beta is currently available at no charge for testing. Hosted-service plans and pricing may be introduced after the beta.

The side panel shows pairing and connection status, controlled-tab capacity, an emergency Stop hosting control, and a local troubleshooting log. The Chrome Web Store build connects only to https://understudy.proofof.tech.

Understudy does not choose tasks or approve actions. Your connected AI client requests browser actions, while you control the paired browser, allowed origins, API credentials, and revocation controls.

This beta can handle page URLs and titles, website content, accessibility trees, screenshots, dialogs, requested input actions, browser metadata, status, errors, and command results when needed to perform authorized browser work. Review the privacy policy before pairing.

Use a dedicated Chrome profile for beta testing. Controlled tabs in one profile share that profile’s cookies and browser storage.
```

## Upload graphic assets

Upload these files:

- **Store icon, 128 × 128 PNG**: `public/icon-128.png`
- **Small promo tile, 440 × 280 PNG**: `store-assets/small-promo-440x280.png`
- **First-run screenshot, 1280 × 800 PNG**: `store-assets/screenshot-first-run-1280x800.png`

The vector source is `store-assets/understudy-mark.svg`. Do not add a connected-state screenshot unless it was captured from a real paired profile.

## Enter the single-purpose statement

Use this text:

```text
Pair Chrome with the hosted Understudy service so an AI client the user authorizes can operate controlled tabs only on website origins the user allows.
```

## Justify each permission

Use these permission justifications:

- **debugger**: Understudy attaches the Chrome DevTools Protocol only to extension-created controlled tabs. It uses that connection to read the requested page state, take screenshots, handle dialogs, and perform authorized navigation and input actions. This is the extension’s core browser-control function.
- **storage**: Understudy stores pairing configuration and device credentials in restricted extension storage. Browser-session storage holds lease, recovery, acknowledgement, and emergency-stop state needed to avoid duplicate actions and recover safely from Manifest V3 service-worker suspension.
- **alarms**: Understudy uses a 30-second alarm as a Manifest V3 wake-up backstop for connection recovery and confirmed cleanup of controlled tabs. It does not use alarms for advertising, tracking, or unrelated background work.
- **sidePanel**: Understudy uses Chrome’s side panel for pairing, hosted connection status, controlled-tab capacity, emergency stop, troubleshooting, privacy, and support.
- **Host permission, `https://understudy.proofof.tech/*`**: The store build uses this single origin to redeem pairing codes, request short-lived connection tickets, and exchange validated control and session data with the hosted Understudy service over HTTPS and secure WebSockets.

The package intentionally does not request `tabs` or `activeTab`.

## Declare remote code

Select **No, I am not using remote code**.

Use this explanation if the dashboard presents a text field:

```text
All executable extension code is bundled in the uploaded Manifest V3 package. Understudy receives validated data and browser-control commands over HTTPS and secure WebSockets, but it does not download or execute JavaScript, WebAssembly, or other code from a remote source.
```

## Select data-use categories conservatively

Select these categories:

- **Personally identifiable information**: Account email and persistent device or session identifiers are handled by the paired hosted service.
- **Authentication information**: Pairing codes, device credentials, API credentials, browser authentication state, and requested credential-fill actions may be handled.
- **Web history**: Controlled-tab URLs and titles are handled to report and operate the requested page.
- **User activity**: Requested clicks, keyboard input, form input, scrolling, navigation, and dialog actions are handled.
- **Website content**: Page content, accessibility trees, screenshots, dialogs, and command results are handled.
- **Personal communications**: Controlled website content or requested input may include communications when the authorized client operates a communications site.

Do not select health, financial, payment, or location categories unless the submitted beta intentionally adds a feature that collects those categories outside the general website-content handling disclosed above.

Certify every limited-use statement only after confirming the privacy policy and package behavior still match these disclosures. Understudy does not sell data, use data for advertising, or allow routine human review of user data.

## Enter reviewer test instructions

Complete the optional **Test instructions** tab because pairing and external-client setup are not self-evident. The reviewer does not need a shared account.

- **Username**: Leave blank. Enter `Not required` if the field requires a value.
- **Password**: Leave blank. Enter `Not required` if the field requires a value.
- **Other instructions**: Paste the following text.

```text
No pre-provisioned credentials are required. Understudy uses passwordless email sign-in.

1. Install the extension and click its toolbar icon. The Understudy side panel opens.
2. Leave the extension unpaired. It must remain idle without localhost or other failed connection attempts.
3. Select Open dashboard and enter any email address you can access. Enter the 6-digit one-time code delivered to that address.
4. Add https://example.com under Allowed origins and generate a browser pairing code.
5. Enter the code in the extension. The panel shows Connecting, then Connected.
6. Create an API token in the dashboard. Configure a Model Context Protocol (MCP) client for https://understudy.proofof.tech/mcp.
7. Ask the client to open https://example.com. Chrome creates a controlled tab, and the panel shows 1 / 2 controlled tabs.
8. Select Stop hosting and confirm. The controlled session ends, and the panel shows Paused.
9. Generate a fresh pairing code to resume. Pairing codes are single-use.

Chrome’s debugger banner is process-wide. Dismissing it in any Chrome window can detach a controlled tab. The banner does not identify which tab is controlled.
```

Do not provide a shared application programming interface (API) token, pairing code, mailbox password, or personal login. Reviewers generate temporary credentials during testing.

## Complete the manual release checks

Before uploading:

1. Run every command in the automated verification section of `RUNBOOK.md`.
2. Complete the store-build Chrome acceptance flow in `RUNBOOK.md`.
3. Confirm the privacy and support links open the intended public pages.
4. Confirm the screenshot matches the uploaded build.
5. Confirm the hosted privacy URL returns `200`.

Production deployment and the Chrome Web Store upload remain manual operations.
