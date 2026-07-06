/**
 * Thrown when a provider is rate-limited (HTTP 429). Carries the server's suggested wait.
 * scope distinguishes a congested per-model upstream pool ("upstream" — switching models
 * helps) from an account-wide free-tier quota ("account" — switching free models is futile).
 */
export class RateLimitError extends Error {
  constructor(
    public retryAfterSeconds: number,
    message: string,
    public scope: "upstream" | "account" = "upstream",
    /** Untouched response body, kept so misclassifications are debuggable from the raw text. */
    public raw: string = ""
  ) {
    super(message);
    this.name = "RateLimitError";
  }
}

/** Classify a 429 body: account-wide free-tier quota vs per-model upstream congestion. */
export function classifyRateLimit(rawBody: string): "upstream" | "account" {
  return /free-models-per-day|per-day|daily limit|free usage limit|requests per day/i.test(rawBody)
    ? "account"
    : "upstream";
}
