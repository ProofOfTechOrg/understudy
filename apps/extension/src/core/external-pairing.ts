const PAIRING_PAGE = "https://understudy.proofof.tech/dashboard/pair";

export function externalPairingOffer(
  message: unknown,
  sender: { url?: string },
): string | null {
  if (typeof sender.url !== "string" || sender.url !== PAIRING_PAGE) return null;
  if (typeof message !== "object" || message === null || Array.isArray(message)) {
    return null;
  }
  const record = message as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2 ||
    record.type !== "understudy_pair_offer" ||
    typeof record.offer !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(record.offer)
  ) {
    return null;
  }
  return record.offer;
}
