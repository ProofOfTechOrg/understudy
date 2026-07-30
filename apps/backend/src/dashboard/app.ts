/**
 * The OAuthProvider's defaultHandler: /dashboard pages and the /oauth/authorize
 * consent screen. This stage ships the routing shell only — the account,
 * pairing, and consent pages land with the dashboard PR. Until then every
 * dashboard path answers 404 so nothing user-facing exists half-built.
 */

import { Hono } from "hono";
import type { Env } from "../types";

export const dashboardApp = new Hono<{ Bindings: Env }>();

dashboardApp.all("*", (c) => {
  c.header("Cache-Control", "no-store");
  return c.text("not found", 404);
});
