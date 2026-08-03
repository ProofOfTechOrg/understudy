const PRODUCTION_ORIGIN = "https://understudy.proofof.tech";

export const SERVICE_ORIGIN =
  typeof __UNDERSTUDY_SERVICE_ORIGIN__ === "string"
    ? __UNDERSTUDY_SERVICE_ORIGIN__
    : PRODUCTION_ORIGIN;

export const DASHBOARD_URL = `${SERVICE_ORIGIN}/dashboard`;
export const PRIVACY_URL = `${SERVICE_ORIGIN}/privacy`;
