const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * Validate a webhook destination without making a network request.
 * HTTPS is required for remote destinations; HTTP is limited to loopback
 * development endpoints.
 */
export function validateWebhookUrl(input: string): string {
  const value = input.trim();
  if (!value) throw new Error("Webhook URL must not be empty; use null to clear it.");

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Webhook URL must be a valid URL.");
  }

  if (parsed.username || parsed.password) {
    throw new Error("Webhook URL must not include username or password credentials.");
  }

  if (parsed.protocol === "https:") return value;

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (parsed.protocol === "http:" && LOOPBACK_HOSTS.has(hostname)) return value;

  throw new Error("Webhook URL must use https; http is allowed only for localhost or loopback development.");
}
