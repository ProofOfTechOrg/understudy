import { CardAliasSchema } from "@understudy/protocol";

export interface PaymentCardInput {
  alias: string;
  cardholderName: string;
  pan: string;
  expiryMonth: string;
  expiryYear: string;
  cvv: string;
}

declare const validatedPaymentCard: unique symbol;
export type ValidatedPaymentCard = PaymentCardInput & {
  readonly [validatedPaymentCard]: true;
};

export class CardValidationError extends Error {}

export function validatePaymentCard(
  input: PaymentCardInput,
  now = new Date(),
): ValidatedPaymentCard {
  const alias = input.alias.trim();
  if (!CardAliasSchema.safeParse(alias).success) {
    throw new CardValidationError(
      "Alias must be 1–64 characters using letters, numbers, dot, underscore, or hyphen.",
    );
  }
  const pan = input.pan.replace(/[\s-]/g, "");
  if (!/^\d{12,19}$/.test(pan) || !luhnValid(pan)) {
    throw new CardValidationError("Card number must be 12–19 digits with a valid checksum.");
  }
  if (aliasContainsCardDigits(alias, pan)) {
    throw new CardValidationError("Alias must not contain digits copied from the card number.");
  }
  const month = Number(input.expiryMonth);
  const year = normalizeYear(input.expiryYear);
  if (!Number.isInteger(month) || month < 1 || month > 12 || year === null) {
    throw new CardValidationError("Expiration must contain a valid month and year.");
  }
  const currentMonth = now.getUTCMonth() + 1;
  const currentYear = now.getUTCFullYear();
  if (paymentCardExpired(month, year, currentMonth, currentYear)) {
    throw new CardValidationError("Expiration must not be in the past.");
  }
  if (!/^\d{3,4}$/.test(input.cvv)) {
    throw new CardValidationError("CVV must contain 3 or 4 digits.");
  }
  const cardholderName = input.cardholderName.trim();
  if (cardholderName.length > 128) {
    throw new CardValidationError("Cardholder name must be at most 128 characters.");
  }
  return {
    alias,
    cardholderName,
    pan,
    expiryMonth: String(month).padStart(2, "0"),
    expiryYear: String(year),
    cvv: input.cvv,
  } as ValidatedPaymentCard;
}

export function storedPaymentCardExpired(
  expiryMonth: string,
  expiryYear: string,
  now = new Date(),
): boolean {
  return paymentCardExpired(
    Number(expiryMonth),
    Number(expiryYear),
    now.getUTCMonth() + 1,
    now.getUTCFullYear(),
  );
}

export function canonicalizePaymentOrigins(origins: readonly string[]): string[] {
  if (origins.length > 32) throw new CardValidationError("At most 32 origins are allowed.");
  const result = origins.map((value) => {
    if (value !== value.trim() || value.includes("*") || value.length > 2048) {
      throw new CardValidationError("Payment origins must be exact HTTPS origins.");
    }
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new CardValidationError("Payment origins must be valid HTTPS origins.");
    }
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      (url.pathname !== "" && url.pathname !== "/") ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      throw new CardValidationError("Payment origins must be exact HTTPS origins.");
    }
    return url.origin;
  });
  return [...new Set(result)].sort();
}

export function luhnValid(pan: string): boolean {
  let sum = 0;
  let double = false;
  for (let index = pan.length - 1; index >= 0; index -= 1) {
    const digit = Number(pan[index]);
    if (!Number.isInteger(digit)) return false;
    const value = double ? digit * 2 : digit;
    sum += value > 9 ? value - 9 : value;
    double = !double;
  }
  return sum % 10 === 0;
}

function paymentCardExpired(
  month: number,
  year: number,
  currentMonth: number,
  currentYear: number,
): boolean {
  return year < currentYear || (year === currentYear && month < currentMonth);
}

function normalizeYear(value: string): number | null {
  return /^\d{4}$/.test(value) ? Number(value) : null;
}

function aliasContainsCardDigits(alias: string, pan: string): boolean {
  const aliasDigitRuns = alias.match(/\d{4,}/g) ?? [];
  return aliasDigitRuns.some((run) => pan.includes(run));
}
