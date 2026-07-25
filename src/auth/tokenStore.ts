/**
 * In-memory token store for operator-supplied API credentials.
 *
 * Tokens are held in MODULE-SCOPED MEMORY ONLY. They are never written to
 * localStorage, sessionStorage, cookies, or the URL. They exist only for the
 * lifetime of the current page session and are lost on reload.
 *
 * This replaces the previous build-time injection of auth tokens via Vite
 * define(), which baked secrets into the compiled frontend bundle.
 */

let _adminToken: string | null = null;
let _traderToken: string | null = null;

/**
 * Update the stored tokens. Only the keys present in `input` are modified;
 * the other token is left untouched.
 */
export function setTokens(input: { adminToken?: string; traderToken?: string }): void {
  if (input.adminToken !== undefined) {
    _adminToken = input.adminToken || null;
  }
  if (input.traderToken !== undefined) {
    _traderToken = input.traderToken || null;
  }
}

/** Returns the admin token, or `null` if not set. */
export function getAdminToken(): string | null {
  return _adminToken;
}

/** Returns the trader token, or `null` if not set. */
export function getTraderToken(): string | null {
  return _traderToken;
}

/** Clears both stored tokens (resets to `null`). */
export function clearTokens(): void {
  _adminToken = null;
  _traderToken = null;
}
