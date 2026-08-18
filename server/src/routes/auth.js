import express from 'express';
import { createUser, authenticate, createSession, destroySession, userForSession } from '../auth.js';

export function authRoutes(config){
  const router = express.Router();
  const cookieOptions = {
    httpOnly: true,                       // JavaScript on the page can never read it
    sameSite: 'lax',
    secure: config.isProduction,          // HTTPS-only once deployed
    maxAge: config.session.ttlDays * 86400_000,
    path: '/'
  };

  router.post('/signup', (req, res, next) => {
    try {
      const user = createUser(req.db, req.body?.email, req.body?.password);
      const session = createSession(req.db, user.id, config.session.ttlDays);
      res.cookie('sid', session.id, cookieOptions).json({ user });
    } catch (err){ next(err); }
  });

  router.post('/login', (req, res) => {
    const user = authenticate(req.db, req.body?.email, req.body?.password);
    if (!user) return res.status(401).json({ error: 'Wrong email or password.' });
    const session = createSession(req.db, user.id, config.session.ttlDays);
    res.cookie('sid', session.id, cookieOptions).json({ user });
  });

  router.post('/logout', (req, res) => {
    if (req.cookies?.sid) destroySession(req.db, req.cookies.sid);
    res.clearCookie('sid', { path: '/' }).json({ ok: true });
  });

  router.get('/me', (req, res) => {
    res.json({ user: userForSession(req.db, req.cookies?.sid) });
  });

  return router;
}
