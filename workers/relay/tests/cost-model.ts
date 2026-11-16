/**
 * The quota relay's cost model (P4-S3), recorded in docs/relay-cost-model.md. Prices are
 * Cloudflare's Workers Paid list prices as of 2026-11-14; the plan's $5.00 a month base already
 * covers the included amounts, so the budget below is the base plus no overage.
 *   https://developers.cloudflare.com/workers/platform/pricing/
 *   https://developers.cloudflare.com/durable-objects/platform/pricing/
 *   https://developers.cloudflare.com/analytics/analytics-engine/pricing/
 */
export const PRICES = {
  basePerMonth: 5.0,
  workerRequests: { included: 10_000_000, perMillion: 0.3 },
  durableObjectRequests: { included: 1_000_000, perMillion: 0.15 },
  analyticsDataPoints: { included: 10_000_000, perMillion: 0.25 },
} as const;

/** The recorded monthly budget for the whole relay Worker, quota relay included. */
export const MONTHLY_BUDGET_USD = 5.0;

export interface MonthlyUsage {
  workerRequests: number;
  durableObjectRequests: number;
  analyticsDataPoints: number;
}

function overage(used: number, price: { included: number; perMillion: number }): number {
  return (Math.max(0, used - price.included) / 1_000_000) * price.perMillion;
}

/** Dollars a month for `usage`, base plan included. */
export function monthlyCost(usage: MonthlyUsage): number {
  return (
    PRICES.basePerMonth +
    overage(usage.workerRequests, PRICES.workerRequests) +
    overage(usage.durableObjectRequests, PRICES.durableObjectRequests) +
    overage(usage.analyticsDataPoints, PRICES.analyticsDataPoints)
  );
}
