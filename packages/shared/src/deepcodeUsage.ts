import * as Predicate from "effect/Predicate";

export interface DeepCodeBalance {
  readonly is_available: boolean;
  readonly balance_infos: readonly {
    readonly currency: "USD" | "CNY";
    readonly total_balance: string;
    readonly granted_balance: string;
    readonly topped_up_balance: string;
  }[];
}

const isAmount = (value: unknown): value is string =>
  typeof value === "string" && /^-?\d{1,20}(?:\.\d{1,8})?$/.test(value);

/** DeepSeek reports credit, without a quota denominator or a reset window. */
export function parseDeepCodeBalance(raw: unknown): DeepCodeBalance | null {
  if (
    !Predicate.isObject(raw) ||
    typeof raw.is_available !== "boolean" ||
    !Array.isArray(raw.balance_infos) ||
    raw.balance_infos.length > 2
  )
    return null;
  const balances: DeepCodeBalance["balance_infos"][number][] = [];
  for (const value of raw.balance_infos) {
    if (
      !Predicate.isObject(value) ||
      (value.currency !== "USD" && value.currency !== "CNY") ||
      !isAmount(value.total_balance) ||
      !isAmount(value.granted_balance) ||
      !isAmount(value.topped_up_balance) ||
      balances.some((row) => row.currency === value.currency)
    )
      return null;
    balances.push({
      currency: value.currency,
      total_balance: value.total_balance,
      granted_balance: value.granted_balance,
      topped_up_balance: value.topped_up_balance,
    });
  }
  return { is_available: raw.is_available, balance_infos: balances };
}

export function formatDeepCodeCredit(amount: string, currency: "USD" | "CNY"): string {
  const trimmed = amount.includes(".") ? amount.replace(/0+$/, "").replace(/\.$/, "") : amount;
  return `${currency === "USD" ? "$" : "¥"}${trimmed}`;
}

export function deepCodeUsageWindows(raw: unknown) {
  const balance = parseDeepCodeBalance(raw);
  if (!balance) return [];
  return [
    ...balance.balance_infos.map((row) => ({
      key: `balance-${row.currency}`,
      label: `${row.currency} credit`,
      usedPercent: null,
      resetAt: null,
      detail: formatDeepCodeCredit(row.total_balance, row.currency),
      description: `${formatDeepCodeCredit(row.granted_balance, row.currency)} granted · ${formatDeepCodeCredit(row.topped_up_balance, row.currency)} topped up`,
    })),
    {
      key: "billing",
      label: "API access",
      usedPercent: null,
      resetAt: null,
      detail: balance.is_available ? "Available" : "Insufficient credit",
      description:
        "DeepSeek reports remaining credit, not a percentage quota. Project-specific keys may use a different balance.",
    },
  ];
}
