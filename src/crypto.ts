/**
 * Encryption for Plaid access tokens.
 *
 * A Plaid access token is a standing key to somebody's bank data, so it never
 * touches the database in the clear. AES-256-GCM via the Workers runtime's own
 * WebCrypto — no dependency, and the key never leaves the environment.
 *
 * GCM is authenticated: decryption fails loudly if the ciphertext was altered,
 * rather than quietly returning rubbish.
 */

/** Bump when TOKEN_ENCRYPTION_KEY is rotated, so old rows stay identifiable. */
export const KEY_VERSION = "v1";

const IV_BYTES = 12; // 96 bits, the size GCM is defined for

function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

let cachedKey: CryptoKey | null = null;

async function getKey(env: Env): Promise<CryptoKey> {
  // Safe to cache per isolate: the key material is fixed for the deployment.
  if (cachedKey) return cachedKey;

  const raw = base64ToBytes(env.TOKEN_ENCRYPTION_KEY);
  if (raw.length !== 32) {
    // Caught here rather than as an opaque WebCrypto error further down.
    throw new Error(`TOKEN_ENCRYPTION_KEY must decode to 32 bytes, got ${raw.length}`);
  }

  cachedKey = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
  return cachedKey;
}

export interface SealedToken {
  ciphertext: string;
  iv: string;
  keyVersion: string;
}

/** Encrypts a token for storage. A fresh IV every time — never reuse one under GCM. */
export async function sealToken(env: Env, plaintext: string): Promise<SealedToken> {
  const key = await getKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );

  return {
    ciphertext: bytesToBase64(new Uint8Array(sealed)),
    iv: bytesToBase64(iv),
    keyVersion: KEY_VERSION,
  };
}

/** Reverses sealToken. Throws if the key is wrong or the ciphertext was tampered with. */
export async function openToken(env: Env, ciphertext: string, iv: string): Promise<string> {
  const key = await getKey(env);
  const opened = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(iv) },
    key,
    base64ToBytes(ciphertext),
  );
  return new TextDecoder().decode(opened);
}
