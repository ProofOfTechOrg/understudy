/**
 * The OTP email seam. A seam (not an inline env.EMAIL.send) because the
 * vitest workers pool does not emulate the send_email binding — tests drive
 * OTP through the directory RPC instead — and because the failure contract
 * matters: a send failure must stay silent (the request-code route answers
 * identically either way) and the code must never reach a log line.
 */

import type { Env } from "../types";

const FROM = { email: "sign-in@proofof.tech", name: "Understudy" };

export async function sendOtpEmail(env: Env, to: string, code: string): Promise<boolean> {
  if (env.EMAIL === undefined) return false;
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
