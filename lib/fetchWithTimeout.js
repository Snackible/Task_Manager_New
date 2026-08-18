// A single slow or hung upstream request (a cold-starting Apps Script
// deployment, a stalled Google API call) shouldn't be able to block the
// whole dashboard indefinitely — plain fetch() has no timeout of its own.
//
// Set generously above what a real (working) fetch needs, even for a large
// sheet — a bulk getDataRange().getValues() call in Code.gs is one round
// trip regardless of row count, and in practice a healthy deployment has
// responded well under 10s. This is a safety net for genuinely broken/hung
// sources (a stale deployment, a dead URL), not a data-size budget.
const DEFAULT_TIMEOUT_MS = 15000;

export async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms: ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
