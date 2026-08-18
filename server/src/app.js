import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authRoutes } from './routes/auth.js';
import { linkRoutes } from './routes/link.js';
import { dataRoutes } from './routes/data.js';
import { webhookRoutes } from './routes/webhook.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Built as a function so tests can mount it with an in-memory db and a fake Plaid. */
export function createApp({ config, db, plaid }){
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser());
  app.use((req, _res, next) => { req.db = db; next(); });

  app.get('/api/health', (_req, res) => res.json({ ok: true, plaidEnv: config.plaid.env }));
  app.use('/api/auth', authRoutes(config));
  app.use('/api/link', linkRoutes(config, plaid));
  app.use('/api', dataRoutes(config, plaid));
  app.use('/api/plaid/webhook', webhookRoutes(config, plaid));

  // The signed-in app. The marketing page stays on GitHub Pages; this serves the
  // logged-in views from the same shared engine.
  app.use(express.static(path.join(here, '..', 'public')));

  app.use((err, _req, res, _next) => {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: err.message || 'Something went wrong.' });
  });

  return app;
}
