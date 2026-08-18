import crypto from 'node:crypto';

/**
 * Plaid access tokens are long-lived credentials to somebody's bank data.
 * They are encrypted at rest so a leaked database file is not a leaked bank connection.
 * AES-256-GCM: the tag makes tampering detectable, not just unreadable.
 */
const IV_BYTES = 12, TAG_BYTES = 16;

export function encrypt(plaintext, key){
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

export function decrypt(payload, key){
  const raw = Buffer.from(String(payload), 'base64');
  if (raw.length <= IV_BYTES + TAG_BYTES) throw new Error('ciphertext is too short to be valid');
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
}

export const newId = (prefix) => prefix + '_' + crypto.randomBytes(12).toString('hex');
