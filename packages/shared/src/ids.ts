/**
 * Pseudonymous identifiers.
 *
 * Participant codes look like `WK-7F3K-Q9XM-4`:
 *  - prefix `WK`
 *  - 8 random Crockford-base32 characters (40 bits of entropy)
 *  - 1 check character (weighted sum mod 32) that catches typos when a
 *    participant reads their code back years later.
 *
 * Crockford base32 omits I, L, O and U, so codes are easy to read aloud and
 * to type. Decoding is forgiving: lowercase, spaces, dashes, O→0 and I/L→1.
 */

export const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_BODY_LEN = 8;
const CHECK_WEIGHTS = [1, 3, 5, 7, 9, 11, 13, 15];
export const PARTICIPANT_CODE_PREFIX = "WK";
export const PARTICIPANT_CODE_PATTERN = /^WK-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]$/;

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

/** Uniform random string over the Crockford alphabet (rejection-free: 256 % 32 === 0). */
export function randomCrockford(len: number): string {
  const bytes = randomBytes(len);
  let s = "";
  for (const b of bytes) s += CROCKFORD[b % 32];
  return s;
}

function checkChar(body: string): string {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const v = CROCKFORD.indexOf(body[i]!);
    if (v < 0) throw new Error(`invalid character ${body[i]}`);
    sum += v * CHECK_WEIGHTS[i % CHECK_WEIGHTS.length]!;
  }
  return CROCKFORD[sum % 32]!;
}

/** Generate a fresh participant code, e.g. `WK-7F3K-Q9XM-4`. */
export function generateParticipantCode(): string {
  const body = randomCrockford(CODE_BODY_LEN);
  return formatCode(body + checkChar(body));
}

function formatCode(raw9: string): string {
  return `${PARTICIPANT_CODE_PREFIX}-${raw9.slice(0, 4)}-${raw9.slice(4, 8)}-${raw9.slice(8)}`;
}

/**
 * Normalise user-typed input into canonical form, or return null if it is not
 * a valid code (wrong length or failed check character).
 */
export function normaliseParticipantCode(input: string): string | null {
  let s = input.toUpperCase().replace(/[\s\-_.]/g, "");
  if (s.startsWith(PARTICIPANT_CODE_PREFIX)) s = s.slice(PARTICIPANT_CODE_PREFIX.length);
  s = s.replace(/O/g, "0").replace(/[IL]/g, "1");
  if (s.length !== CODE_BODY_LEN + 1) return null;
  for (const ch of s) if (!CROCKFORD.includes(ch)) return null;
  const body = s.slice(0, CODE_BODY_LEN);
  if (checkChar(body) !== s.slice(CODE_BODY_LEN)) return null;
  return formatCode(s);
}

export function isValidParticipantCode(input: string): boolean {
  return normaliseParticipantCode(input) === input;
}

/** Session ids: `S-YYYYMMDD-XXXX` (date of creation + 4 random chars). Not personal data. */
export function generateSessionId(now = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `S-${y}${m}${d}-${randomCrockford(4)}`;
}

/** Anonymous ids used in anonymised exports: `A-XXXXXX`. */
export function generateAnonymousId(): string {
  return `A-${randomCrockford(6)}`;
}

/** Random opaque token (hex) — used for browser terminal keys. */
export function randomToken(bytes = 16): string {
  return Array.from(randomBytes(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}
