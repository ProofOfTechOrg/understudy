/**
 * The OTP email seam. A seam (not an inline env.EMAIL.send) so a per-send
 * failure stays silent — the request-code route answers identically whether
 * the address exists, is rate-limited, or bounced, and the code must never
 * reach a log line. The vitest workers pool DOES emulate send_email, so the
 * happy path is exercised there; only the binding-absent branch is not.
 *
 * The two failure modes are treated differently: a PER-SEND throw is silent
 * (it may carry the address/code and is an anti-enumeration concern), but a
 * MISSING binding is a global misconfiguration with no address attached, so
 * it emits a content-free telemetry signal — otherwise a de-onboarded domain
 * or a dropped binding would silently break every sign-in with no signal.
 */

import { emitTelemetry } from "../telemetry";
import type { Env } from "../types";

const FROM = { email: "sign-in@proofof.tech", name: "Understudy" };

export async function sendOtpEmail(env: Env, to: string, code: string): Promise<boolean> {
  if (env.EMAIL === undefined) {
    await emitTelemetry(env, { event: "authentication", outcome: "otp_email_unconfigured" });
    return false;
  }
  try {
    await env.EMAIL.send({
      to,
      from: FROM,
      subject: "Your Understudy sign-in code",
      text:
        `Your Understudy sign-in code is ${code}\n\n` +
        `It expires in 10 minutes and works once. ` +
        `If you did not request it, ignore this email.`,
      html:
        `<p>Your Understudy sign-in code is</p>` +
        `<p style="font-size:24px;font-weight:700;letter-spacing:4px">${code}</p>` +
        `<p>It expires in 10 minutes and works once. ` +
        `If you did not request it, ignore this email.</p>`,
    });
    return true;
  } catch {
    // Never log: the failure class is visible in Email Sending analytics,
    // and any richer report here risks carrying the code with it.
    return false;
  }
}
