/**
 * Server-rendered account pages (D7): forms via hono/html (auto-escaping), one
 * style block, plain POST/redirect, and three client-side behaviors under a
 * per-response CSP nonce: copy buttons and the pairing-offer countdown.
 */

import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import type { McpTokenRecord } from "../account-directory";
import { MCP_URL } from "../canonical";

type Fragment = HtmlEscapedString | Promise<HtmlEscapedString>;

const STYLE = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { font: 15px/1.5 system-ui, sans-serif; margin: 0; background: Canvas; color: CanvasText; }
main { max-width: 780px; margin: 0 auto; padding: 24px 16px 64px; }
h1 { font-size: 22px; margin: 18px 0; }
h2 { font-size: 16px; margin: 0 0 10px; }
.card { border: 1px solid color-mix(in srgb, CanvasText 18%, Canvas); border-radius: 10px; padding: 16px; margin: 14px 0; }
label { display: block; margin: 8px 0 4px; font-weight: 600; font-size: 13px; }
input, textarea, select { width: 100%; padding: 8px; border: 1px solid color-mix(in srgb, CanvasText 25%, Canvas); border-radius: 6px; background: Canvas; color: CanvasText; font: inherit; }
textarea { font-family: ui-monospace, monospace; font-size: 13px; }
button { padding: 8px 14px; border-radius: 6px; border: 1px solid color-mix(in srgb, CanvasText 30%, Canvas); background: color-mix(in srgb, CanvasText 8%, Canvas); color: CanvasText; font: inherit; cursor: pointer; margin-top: 8px; }
button.primary { background: #2563eb; border-color: #2563eb; color: #fff; }
button.danger { border-color: #b91c1c; color: #b91c1c; background: transparent; }
button.inline { margin: 0 0 0 8px; padding: 2px 8px; font-size: 12px; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid color-mix(in srgb, CanvasText 12%, Canvas); vertical-align: top; }
code, pre { font-family: ui-monospace, monospace; font-size: 13px; }
pre { background: color-mix(in srgb, CanvasText 6%, Canvas); padding: 10px; border-radius: 6px; overflow-x: auto; }
.muted { color: color-mix(in srgb, CanvasText 60%, Canvas); font-size: 13px; }
.error { color: #b91c1c; font-weight: 600; }
.pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; border: 1px solid color-mix(in srgb, CanvasText 25%, Canvas); }
.topbar { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
form.inline-form { display: inline; }
footer { max-width: 780px; margin: -44px auto 0; padding: 0 16px 24px; color: color-mix(in srgb, CanvasText 60%, Canvas); font-size: 13px; }
footer a { color: inherit; }
.policy-list li { margin: 8px 0; }
`;

/** Copy buttons + countdown; loaded on every page, wired by data attributes. */
const BASE_JS = `
for (const button of document.querySelectorAll("[data-copy]")) {
  button.addEventListener("click", async () => {
    const target = document.getElementById(button.getAttribute("data-copy"));
    if (!target) return;
    await navigator.clipboard.writeText(target.textContent.trim());
    const label = button.textContent; button.textContent = "Copied";
    setTimeout(() => { button.textContent = label; }, 1200);
  });
}
const countdown = document.querySelector("[data-expires]");
if (countdown) {
  const expiresAt = Number(countdown.getAttribute("data-expires"));
  const tick = () => {
    const left = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
    countdown.textContent = left > 0
      ? "Expires in " + Math.floor(left / 60) + ":" + String(left % 60).padStart(2, "0")
      : "Expired — generate a new offer.";
    if (left > 0) setTimeout(tick, 1000);
  };
  tick();
}
const pairing = document.getElementById("pairing-offer");
if (pairing) {
  const offer = pairing.getAttribute("data-offer");
  const extensionId = pairing.getAttribute("data-extension-id");
  const status = document.getElementById("pairing-status");
  pairing.removeAttribute("data-offer");
  if (offer && extensionId && globalThis.chrome?.runtime?.sendMessage) {
    chrome.runtime.sendMessage(
      extensionId,
      { type: "understudy_pair_offer", offer },
      (reply) => {
        if (!status) return;
        status.textContent = chrome.runtime.lastError || reply?.ok !== true
          ? "The extension did not accept the offer. Confirm it is installed, then generate a new offer."
          : "This browser is paired. You can close this page.";
      },
    );
  } else if (status) {
    status.textContent = "The Understudy extension is not installed. Install it, then generate a new offer.";
  }
}
`;

export function layout(
  title: string,
  nonce: string,
  body: Fragment,
): Fragment {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${title}</title>
<style>${raw(STYLE)}</style>
</head>
<body>
<main>${body}</main>
<footer><a href="/privacy">Privacy</a> · <a href="https://github.com/ProofOfTechOrg/understudy/issues">Support</a></footer>
<script nonce="${nonce}">${raw(BASE_JS)}</script>
</body>
</html>`;
}

export function privacyPage(): Fragment {
  return html`<h1>Understudy privacy policy</h1>
<p class="muted">Effective July 31, 2026. This policy covers the Understudy Beta Chrome extension and the hosted Understudy service.</p>

<div class="card">
  <h2>Single purpose</h2>
  <p>Understudy pairs Chrome with the hosted service so an AI client you authorize can operate tabs on sites and origins you allow. Understudy uses browser data only to provide, secure, maintain, and measure that browser-control service.</p>
</div>

<div class="card">
  <h2>Data Understudy handles</h2>
  <p>The extension and service may handle the following data when an authorized client requests browser work:</p>
  <ul class="policy-list">
    <li>Page URLs and titles, website content, accessibility trees, screenshots, and dialog text</li>
    <li>Requested form, input, click, keyboard, scrolling, and navigation actions</li>
    <li>Browser and extension metadata, allowed origins, device and session identifiers, hosting status, errors, and command results</li>
    <li>Account email, session and device credentials, API credentials, and one-time pairing offers used to authenticate requested actions</li>
  </ul>
  <p>Command payloads and results may remain in per-session service state for execution, retry, acknowledgement, and recovery. They are not necessarily transient.</p>
</div>

<div class="card">
  <h2>Local extension storage</h2>
  <p>The extension stores device credentials, profile configuration, and locally encrypted payment-card records in extension-owned storage. Card plaintext, ciphertext, and encryption keys are not sent to the service. Browser-session storage may contain lease assignments, owned-window identifiers, recovery state, write-journal status, and pending dialog records.</p>
  <p>The extension does not persist command bodies, typed text, secret plaintext, secret references, screenshots, accessibility trees, or general navigation history in local extension storage. A pending dialog record includes the page URL where the dialog appeared until the service acknowledges that record.</p>
</div>

<div class="card">
  <h2>Use and disclosure</h2>
  <p>Understudy transmits validated control data between your authorized AI client, the hosted service, and your paired browser. The service uses infrastructure providers, including Cloudflare, to operate this functionality. Data may also be disclosed when required by law or necessary to investigate security abuse.</p>
  <p>Understudy does not sell user data, use it for advertising, or transfer it for personalized, retargeted, or interest-based advertising. Understudy does not load or execute remotely hosted code in the extension. HTTP and WebSocket messages carry data and commands validated by the bundled extension code.</p>
  <p>Understudy’s use of information received from Chrome APIs complies with the Chrome Web Store User Data Policy, including its Limited Use requirements.</p>
</div>

<div class="card">
  <h2>Security and control</h2>
  <p>The Chrome Web Store build connects to the hosted service over HTTPS and secure WebSockets (WSS). Device credentials are sent only over secure transport. You can stop hosting in the extension, revoke a paired browser in the dashboard, revoke API credentials, or close browser sessions.</p>
  <p>Understudy limits human access to user data to consented support, security investigation, legal compliance, or aggregated and anonymized internal operations.</p>
</div>

<div class="card">
  <h2>Retention during beta</h2>
  <p>During beta, Understudy retains account, device, security, and per-session records for as long as needed to operate, retry, recover, secure, and evaluate the service. The production retention schedule is not yet fixed. Closing sessions, revoking browsers or credentials, and stopping hosting limit future processing but may not immediately remove records needed for security, recovery, or legal obligations.</p>
</div>

<div class="card">
  <h2>Support and privacy requests</h2>
  <p>Use the <a href="https://github.com/ProofOfTechOrg/understudy/issues">public support tracker</a> for product bugs. Do not post credentials, pairing offers, page content, screenshots, personal data, or other sensitive information in a public GitHub issue.</p>
</div>`;
}

export function loginPage(next: string): Fragment {
  return html`<h1>Understudy</h1>
<div class="card">
  <h2>Sign in</h2>
  <form method="post" action="/dashboard/auth/request-code">
    <label for="email">Email</label>
    <input id="email" name="email" type="email" required autocomplete="email" />
    <input type="hidden" name="next" value="${next}" />
    <button class="primary" type="submit">Email me a sign-in code</button>
  </form>
  <p class="muted">We create your account on first sign-in. No passwords.</p>
</div>`;
}

export function verifyPage(options: {
  challengeId: string;
  email: string;
  next: string;
  error?: string;
}): Fragment {
  return html`<h1>Understudy</h1>
<div class="card">
  <h2>Enter your code</h2>
  <p class="muted">If ${options.email} works, a 6-digit code is on its way. It expires in 10 minutes.</p>
  ${options.error === undefined ? "" : html`<p class="error">${options.error}</p>`}
  <form method="post" action="/dashboard/auth/verify">
    <label for="code">Code</label>
    <input id="code" name="code" inputmode="numeric" pattern="[0-9]{6}" required autocomplete="one-time-code" />
    <input type="hidden" name="challengeId" value="${options.challengeId}" />
    <input type="hidden" name="email" value="${options.email}" />
    <input type="hidden" name="next" value="${options.next}" />
    <button class="primary" type="submit">Sign in</button>
  </form>
</div>`;
}

export interface HomeDevice {
  deviceId: string;
  label: string | null;
  status: string;
  used: number | null;
  capacity: number | null;
  lastSeenAt: string | null;
}

export interface HomeData {
  email: string;
  csrf: string;
  origins: string[];
  devices: HomeDevice[];
  tokens: McpTokenRecord[];
  grants: Array<{
    grantId: string;
    clientId: string;
    label: string;
    deviceId: string | null;
  }>;
  notice?: string;
}

function connectCard(): Fragment {
  const cli = `claude mcp add --transport http understudy ${MCP_URL} \\
  --header "Authorization: Bearer <YOUR-TOKEN>"`;
  const json = `{ "mcpServers": { "understudy": {
  "type": "http", "url": "${MCP_URL}",
  "headers": { "Authorization": "Bearer <YOUR-TOKEN>" } } } }`;
  const remote = `{ "mcpServers": { "understudy": {
  "command": "npx",
  "args": ["-y", "mcp-remote", "${MCP_URL}",
           "--header", "Authorization: Bearer <YOUR-TOKEN>"] } } }`;
  return html`<div class="card">
  <h2>Connect your AI client</h2>
  <p><strong>ChatGPT</strong>: copy <code id="mcp-chatgpt">${MCP_URL}</code>
    <button class="inline" type="button" data-copy="mcp-chatgpt">Copy</button>, then
    <a href="https://chatgpt.com/plugins" target="_blank" rel="noreferrer">open ChatGPT Plugins</a>.</p>
  <p><strong>Claude</strong>: copy <code id="mcp-claude">${MCP_URL}</code>
    <button class="inline" type="button" data-copy="mcp-claude">Copy</button>, then
    <a href="https://claude.ai/new" target="_blank" rel="noreferrer">open Claude</a> and choose
    <strong>Customize</strong> → <strong>Connectors</strong>.</p>
  <p class="muted">Replace <code>&lt;YOUR-TOKEN&gt;</code> with an API token from the card below.</p>
  <p><strong>Claude Code</strong> <button class="inline" type="button" data-copy="connect-cli">Copy</button></p>
  <pre id="connect-cli">${cli}</pre>
  <p><strong>JSON config (Cursor and friends)</strong> <button class="inline" type="button" data-copy="connect-json">Copy</button></p>
  <pre id="connect-json">${json}</pre>
  <p><strong>Clients without native remote MCP</strong> <button class="inline" type="button" data-copy="connect-remote">Copy</button></p>
  <pre id="connect-remote">${remote}</pre>
  <p class="muted">Hosted clients use OAuth and require selecting one paired browser during consent.</p>
</div>`;
}

export function homePage(data: HomeData): Fragment {
  const deviceRows =
    data.devices.length === 0
      ? html`<tr><td colspan="4" class="muted">No browsers paired yet.</td></tr>`
      : data.devices.map(
          (device) => html`<tr>
  <td><code>${device.label ?? device.deviceId.slice(0, 8)}</code></td>
  <td><span class="pill">${device.status.replace(/_/g, " ")}</span>
      ${device.used !== null && device.capacity !== null
        ? html`<span class="muted">${device.used}/${device.capacity} sessions</span>`
        : ""}</td>
  <td class="muted">${device.lastSeenAt ?? "never connected"}</td>
  <td><form class="inline-form" method="post" action="/dashboard/devices/revoke">
    <input type="hidden" name="csrf" value="${data.csrf}" />
    <input type="hidden" name="deviceId" value="${device.deviceId}" />
    <button class="danger" type="submit">Revoke</button>
  </form></td>
</tr>`,
        );

  const tokenRows =
    data.tokens.length === 0
      ? html`<tr><td colspan="3" class="muted">No API tokens yet.</td></tr>`
      : data.tokens.map(
          (token) => html`<tr>
  <td><code>${token.tokenId}</code> ${token.label === null ? "" : html`— ${token.label}`}<br /><span class="muted">${token.deviceLabel ?? token.deviceId.slice(0, 8)}</span></td>
  <td class="muted">${token.lastUsedAt === null ? "never used" : new Date(token.lastUsedAt).toISOString()}</td>
  <td><form class="inline-form" method="post" action="/dashboard/tokens/revoke">
    <input type="hidden" name="csrf" value="${data.csrf}" />
    <input type="hidden" name="tokenId" value="${token.tokenId}" />
    <button class="danger" type="submit">Revoke</button>
  </form></td>
</tr>`,
        );

  const grantRows =
    data.grants.length === 0
      ? html`<tr><td colspan="3" class="muted">No OAuth connections yet.</td></tr>`
      : data.grants.map(
          (grant) => html`<tr>
  <td>${grant.label}<br /><code>${grant.clientId}</code></td>
  <td class="muted">${grant.deviceId === null ? "legacy unbound" : grant.deviceId.slice(0, 8)}</td>
  <td><form class="inline-form" method="post" action="/dashboard/oauth/revoke">
    <input type="hidden" name="csrf" value="${data.csrf}" />
    <input type="hidden" name="grantId" value="${grant.grantId}" />
    <button class="danger" type="submit">Revoke</button>
  </form></td>
</tr>`,
        );

  return html`<div class="topbar">
  <h1>Understudy</h1>
  <div>
    <span class="muted">${data.email}</span>
    <form class="inline-form" method="post" action="/dashboard/auth/logout">
      <input type="hidden" name="csrf" value="${data.csrf}" />
      <button class="inline" type="submit">Sign out</button>
    </form>
  </div>
</div>
${data.notice === undefined ? "" : html`<p class="muted">${data.notice}</p>`}

<div class="card" id="browsers">
  <h2>Paired browsers</h2>
  <table><tr><th>Browser</th><th>Status</th><th>Last seen</th><th></th></tr>${deviceRows}</table>
  <p class="muted">Revoking immediately invalidates this browser and every API or OAuth credential bound to it; the extension shows why it stopped.</p>
</div>

<div class="card" id="origins">
  <h2>Allowed origins</h2>
  <p class="muted">The sites paired browsers may be driven on, one exact HTTPS origin per line (up to 32). Changes apply to every paired browser. Removed origins are fenced immediately; added origins become usable after the extension acknowledges the new policy.</p>
  <form method="post" action="/dashboard/origins">
    <input type="hidden" name="csrf" value="${data.csrf}" />
    <textarea name="origins" rows="4" placeholder="https://example.com">${data.origins.join("\n")}</textarea>
    <button class="primary" type="submit">Save origins</button>
  </form>
</div>

<div class="card">
  <h2>Pair a browser</h2>
  <p class="muted">Install the Understudy extension in Chrome, then send it a one-time pairing offer. An empty origin policy is allowed, but the browser cannot open sessions until you add an origin.</p>
  <form method="post" action="/dashboard/pair">
    <input type="hidden" name="csrf" value="${data.csrf}" />
    <button class="primary" type="submit">Pair this browser</button>
  </form>
</div>

${connectCard()}

<div class="card">
  <h2>OAuth connections</h2>
  <table><tr><th>Client</th><th>Browser</th><th></th></tr>${grantRows}</table>
</div>

<div class="card">
  <h2>API tokens</h2>
  <table><tr><th>Token</th><th>Last used</th><th></th></tr>${tokenRows}</table>
  <form method="post" action="/dashboard/tokens/create">
    <input type="hidden" name="csrf" value="${data.csrf}" />
    <label for="token-label">Label</label>
    <input id="token-label" name="label" maxlength="128" placeholder="laptop" />
    <label for="token-device">Browser</label>
    <select id="token-device" name="deviceId" required>
      ${data.devices.map(
        (device) => html`<option value="${device.deviceId}">${device.label ?? device.deviceId.slice(0, 8)}</option>`,
      )}
    </select>
    <button class="primary" type="submit">Create token</button>
  </form>
  <p class="muted">Tokens are shown once at creation and stored only as digests.</p>
</div>`;
}

export function pairingOfferPage(
  csrf: string,
  offer: string,
  expiresAt: number,
  extensionId: string,
): Fragment {
  return html`<h1>Understudy</h1>
<div class="card" id="pairing-offer" data-offer="${offer}" data-extension-id="${extensionId}">
  <h2>Pair this browser</h2>
  <p id="pairing-status">Sending a one-time offer to the installed extension…</p>
  <p class="muted" data-expires="${String(expiresAt)}">Expires in 10:00</p>
  <p class="muted">The offer is delivered directly to the extension and never placed in a URL, browser history, or referrer.</p>
  <form method="post" action="/dashboard/pair">
    <input type="hidden" name="csrf" value="${csrf}" />
    <button type="submit">Send a new offer</button>
  </form>
  <p><a href="/dashboard">Back to dashboard</a></p>
</div>`;
}

export function tokenRevealPage(token: string, label: string | null): Fragment {
  return html`<h1>Understudy</h1>
<div class="card">
  <h2>API token created${label === null ? "" : html` — ${label}`}</h2>
  <p><code id="new-token">${token}</code>
     <button class="inline" type="button" data-copy="new-token">Copy</button></p>
  <p class="error">This is the only time the token is shown. Store it in your MCP client config now.</p>
  <p><a href="/dashboard">Back to dashboard</a></p>
</div>`;
}

export function messagePage(title: string, message: string): Fragment {
  return html`<h1>Understudy</h1>
<div class="card">
  <h2>${title}</h2>
  <p>${message}</p>
  <p><a href="/dashboard">Back to dashboard</a></p>
</div>`;
}

export function consentPage(options: {
  clientName: string;
  redirectOrigin: string;
  email: string;
  csrf: string;
  authreq: string;
  sig: string;
  devices: Array<{ deviceId: string; label: string | null }>;
}): Fragment {
  return html`<h1>Understudy</h1>
<div class="card">
  <h2>Authorize ${options.clientName}?</h2>
  <p><strong>${options.clientName}</strong> (redirecting to ${options.redirectOrigin}) wants to
     drive your paired browser as <strong>${options.email}</strong>:</p>
  <ul><li>Open and control browser sessions on your allowed origins (scope: <code>mcp</code>)</li></ul>
  <form method="post" action="/oauth/authorize">
    <input type="hidden" name="csrf" value="${options.csrf}" />
    <input type="hidden" name="authreq" value="${options.authreq}" />
    <input type="hidden" name="sig" value="${options.sig}" />
    <label for="oauth-device">Browser</label>
    <select id="oauth-device" name="deviceId" required>
      ${options.devices.map(
        (device) => html`<option value="${device.deviceId}">${device.label ?? device.deviceId.slice(0, 8)}</option>`,
      )}
    </select>
    <button class="primary" name="decision" value="approve" type="submit">Authorize</button>
    <button name="decision" value="deny" type="submit">Deny</button>
  </form>
</div>`;
}
