import crypto from 'node:crypto';
import { newId } from './crypto.js';
import { nowIso } from './db.js';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(password){
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return 'scrypt$' + salt.toString('base64') + '$' + hash.toString('base64');
}

export function verifyPassword(password, stored){
  const [scheme, saltB64, hashB64] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, SCRYPT);
  // Constant time: a fast "wrong" answer leaks how much of the hash matched.
  return crypto.timingSafeEqual(expected, actual);
}

export function createUser(db, email, password){
  const normalized = String(email).trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) throw Object.assign(new Error('That does not look like an email address.'), { status: 400 });
  if (String(password).length < 10) throw Object.assign(new Error('Use a password of at least 10 characters.'), { status: 400 });
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(normalized);
  if (existing) throw Object.assign(new Error('That email is already registered.'), { status: 409 });
  const user = { id: newId('usr'), email: normalized, password_hash: hashPassword(password), created_at: nowIso() };
  db.prepare('INSERT INTO users (id, email, password_hash, created_at) VALUES (@id, @email, @password_hash, @created_at)').run(user);
  return { id: user.id, email: user.email };
}

export function authenticate(db, email, password){
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email).trim().toLowerCase());
  // Hash anyway when the user is unknown, so "no such account" and "wrong password"
  // take the same time and cannot be told apart by timing.
  if (!row){ hashPassword(String(password)); return null; }
  return verifyPassword(password, row.password_hash) ? { id: row.id, email: row.email } : null;
}

export function createSession(db, userId, ttlDays){
  const session = {
    id: crypto.randomBytes(32).toString('hex'),
    user_id: userId,
    created_at: nowIso(),
    expires_at: new Date(Date.now() + ttlDays * 86400_000).toISOString()
  };
  db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (@id, @user_id, @created_at, @expires_at)').run(session);
  return session;
}

export function userForSession(db, sessionId){
  if (!sessionId) return null;
  const row = db.prepare(
    `SELECT u.id, u.email, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`
  ).get(sessionId);
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()){
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    return null;
  }
  return { id: row.id, email: row.email };
}

export const destroySession = (db, sessionId) => db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);

/** Express middleware: 401 unless a valid session cookie is present. */
export function requireUser(req, res, next){
  const user = userForSession(req.db, req.cookies?.sid);
  if (!user) return res.status(401).json({ error: 'Sign in first.' });
  req.user = user;
  next();
}
