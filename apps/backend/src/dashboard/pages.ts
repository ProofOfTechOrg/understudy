/**
 * Server-rendered dashboard pages (D7): five pages of forms via hono/html
 * (auto-escaping), one style block, plain POST/redirect, and exactly three
 * client-side behaviors under a per-response CSP nonce — copy buttons, the
 * pairing-code countdown, and the vault-upload sealer (whose derivation must
 * stay in lockstep with vault-upload.ts).
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
input, textarea { width: 100%; padding: 8px; border: 1px solid color-mix(in srgb, CanvasText 25%, Canvas); border-radius: 6px; background: Canvas; color: CanvasText; font: inherit; }
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
.bigcode { font-size: 30px; letter-spacing: 6px; font-weight: 700; font-family: ui-monospace, monospace; }
.pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; border: 1px solid color-mix(in srgb, CanvasText 25%, Canvas); }
.topbar { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
form.inline-form { display: inline; }
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
      : "Expired — generate a new code.";
    if (left > 0) setTimeout(tick, 1000);
  };
  tick();
}
`;

/**
 * Client half of the vault upload. The visible secret input deliberately has
 * NO name attribute: with JavaScript disabled the form posts only empty
 * hidden fields, so plaintext can never ride the wire by accident.
 * Derivation mirrors vault-upload.ts exactly (ECDH P-256 → HKDF-SHA256,
 * empty salt, info "understudy-vault-upload-v1" → AES-256-GCM).
 */
export const VAULT_UPLOAD_JS = `
const vaultForm = document.getElementById("vault-form");
if (vaultForm) {
  const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
  vaultForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const secretInput = document.getElementById("vault-plaintext");
    const jwk = JSON.parse(vaultForm.getAttribute("data-upload-key"));
    const value = secretInput.value;
    if (value.length === 0) return;
    const serverKey = await crypto.subtle.importKey(
      "jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, false, []);
    const ephemeral = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const shared = await crypto.subtle.deriveBits(
      { name: "ECDH", public: serverKey }, ephemeral.privateKey, 256);
    const hkdf = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
    const aes = await crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0),
        info: new TextEncoder().encode("understudy-vault-upload-v1") },
      hkdf, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv }, aes, new TextEncoder().encode(value));
    vaultForm.elements.epk.value = b64u(await crypto.subtle.exportKey("raw", ephemeral.publicKey));
    vaultForm.elements.iv.value = b64u(iv);
    vaultForm.elements.ct.value = b64u(ciphertext);
    secretInput.value = "";
    vaultForm.submit();
  });
}
`;

export function layout(
  title: string,
  nonce: string,
  body: Fragment,
  extraJs = "",
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
<script nonce="${nonce}">${raw(BASE_JS + extraJs)}</script>
</body>
</html>`;
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
  tenantId: string;
  csrf: string;
  origins: string[];
  devices: HomeDevice[];
  tokens: McpTokenRecord[];
  secretNames: string[];
  uploadKeyJson: string;
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
  <p class="muted">Replace <code>&lt;YOUR-TOKEN&gt;</code> with an API token from the card below.</p>
  <p><strong>Claude Code</strong> <button class="inline" type="button" data-copy="connect-cli">Copy</button></p>
  <pre id="connect-cli">${cli}</pre>
  <p><strong>JSON config (Cursor and friends)</strong> <button class="inline" type="button" data-copy="connect-json">Copy</button></p>
  <pre id="connect-json">${json}</pre>
  <p><strong>Clients without native remote MCP</strong> <button class="inline" type="button" data-copy="connect-remote">Copy</button></p>
  <pre id="connect-remote">${remote}</pre>
  <p class="muted">claude.ai and ChatGPT connectors: paste the URL alone — you'll sign in via OAuth.</p>
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
  <td><code>${token.tokenId}</code> ${token.label === null ? "" : html`— ${token.label}`}</td>
  <td class="muted">${token.lastUsedAt === null ? "never used" : new Date(token.lastUsedAt).toISOString()}</td>
  <td><form class="inline-form" method="post" action="/dashboard/tokens/revoke">
    <input type="hidden" name="csrf" value="${data.csrf}" />
    <input type="hidden" name="tokenId" value="${token.tokenId}" />
    <button class="danger" type="submit">Revoke</button>
  </form></td>
</tr>`,
        );

  const canPair = data.origins.length > 0;

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

<div class="card">
  <h2>Paired browsers</h2>
  <table><tr><th>Browser</th><th>Status</th><th>Last seen</th><th></th></tr>${deviceRows}</table>
  <p class="muted">Revoking takes effect within about two minutes; the extension shows why it stopped.</p>
</div>

<div class="card">
  <h2>Pair a browser</h2>
  <p class="muted">Install the Understudy extension in Chrome, then paste a one-time code into its side panel.</p>
  <form method="post" action="/dashboard/pair">
    <input type="hidden" name="csrf" value="${data.csrf}" />
    <button class="primary" type="submit" ${canPair ? "" : raw("disabled")}>Generate pairing code</button>
  </form>
  ${canPair
    ? ""
    : html`<p class="muted">Add at least one allowed origin below first — a paired browser needs to know which sites it may drive.</p>`}
</div>

${connectCard()}

<div class="card">
  <h2>Allowed origins</h2>
  <p class="muted">The sites a paired browser may be driven on, one https origin per line (up to 32). New pairings snapshot this list; changing it later means pairing again.</p>
  <form method="post" action="/dashboard/origins">
    <input type="hidden" name="csrf" value="${data.csrf}" />
    <textarea name="origins" rows="4" placeholder="https://example.com">${data.origins.join("\n")}</textarea>
    <button class="primary" type="submit">Save origins</button>
  </form>
</div>

<div class="card">
  <h2>API tokens</h2>
  <table><tr><th>Token</th><th>Last used</th><th></th></tr>${tokenRows}</table>
  <form method="post" action="/dashboard/tokens/create">
    <input type="hidden" name="csrf" value="${data.csrf}" />
    <label for="token-label">Label</label>
    <input id="token-label" name="label" maxlength="128" placeholder="laptop" />
    <button class="primary" type="submit">Create token</button>
  </form>
  <p class="muted">Tokens are shown once at creation and stored only as digests.</p>
</div>

<div class="card">
  <h2>Vault secrets</h2>
  <p class="muted">
    Named secrets your AI client can ask the browser to type without ever seeing the value
    (the <code>browser_fill_secret</code> tool).
    Stored: ${data.secretNames.length === 0 ? html`<em>none</em>` : data.secretNames.map((name) => html`<code>${name}</code> `)}
  </p>
  <form id="vault-form" method="post" action="/dashboard/vault/put" data-upload-key="${data.uploadKeyJson}">
    <input type="hidden" name="csrf" value="${data.csrf}" />
    <input type="hidden" name="epk" value="" />
    <input type="hidden" name="iv" value="" />
    <input type="hidden" name="ct" value="" />
    <label for="vault-name">Name</label>
    <input id="vault-name" name="name" required maxlength="200" pattern="[A-Za-z0-9][A-Za-z0-9._-]*" placeholder="github-password" />
    <label for="vault-plaintext">Value</label>
    <input id="vault-plaintext" type="password" autocomplete="off" required />
    <button class="primary" type="submit">Encrypt &amp; save</button>
  </form>
  <p class="muted">
    Encrypted in your browser to the service's upload key before it is sent, so the plaintext
    never appears in a request body or log. The service still decrypts it server-side to type it
    into pages — this protects against accidental exposure, not against the service itself.
    Prefer sealing offline? <code>GET /dashboard/vault/pubkey</code> serves the same public key.
  </p>
</div>`;
}

export function pairingCodePage(csrf: string, code: string, expiresAt: number): Fragment {
  const display = `${code.slice(0, 4)}-${code.slice(4)}`;
  return html`<h1>Understudy</h1>
<div class="card">
  <h2>Pairing code</h2>
  <p><span class="bigcode" id="pairing-code">${display}</span>
     <button class="inline" type="button" data-copy="pairing-code">Copy</button></p>
  <p class="muted" data-expires="${String(expiresAt)}">Expires in 10:00</p>
  <p>Paste it into the Understudy extension's side panel ("Pair with your account").
     The code works once; the browser appears above within one heartbeat of pairing.</p>
  <form method="post" action="/dashboard/pair">
    <input type="hidden" name="csrf" value="${csrf}" />
    <button type="submit">Generate a new code</button>
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
    <button class="primary" name="decision" value="approve" type="submit">Authorize</button>
    <button name="decision" value="deny" type="submit">Deny</button>
  </form>
</div>`;
}

