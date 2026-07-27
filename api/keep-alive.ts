/**
 * BannerBye — Upstash Redis keep-alive endpoint.
 *
 * Doel: voorkomt dat de Free-tier Upstash Redis database na 30 dagen
 * inactiviteit verwijderd wordt. Vercel Cron pingt deze endpoint dagelijks
 * (zie vercel.json → crons).
 *
 * Werking: één PING naar Redis. Als er geen Redis geconfigureerd is,
 * retourneert de endpoint alsnog 200 (idempotent, zodat cron-runs niet
 * falen tijdens infrastructuur-migraties).
 *
 * Endpoint is bewust openbaar/idempotent: geen state-mutatie, alleen
 * één lezinq. Wel controleren we op de x-vercel-cron header voor logs.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getRedis } from '../lib/store.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const startedAt = Date.now();
  const invokedByCron = req.headers['x-vercel-cron'] === '1';

  const redis = getRedis();
  if (!redis) {
    return res.status(200).json({
      ok: true,
      redis: 'not-configured',
      cron: invokedByCron,
      elapsedMs: Date.now() - startedAt,
    });
  }

  try {
    const pong = await redis.ping();
    return res.status(200).json({
      ok: true,
      redis: pong === 'PONG' ? 'alive' : String(pong),
      cron: invokedByCron,
      elapsedMs: Date.now() - startedAt,
    });
  } catch (err: any) {
    // Log maar geef 200 terug: cron mag niet falen. Upstash-outages zijn
    // zeldzaam en de volgende cron-run herstelt vanzelf.
    console.error('[keep-alive] Redis ping failed:', err?.message ?? err);
    return res.status(200).json({
      ok: false,
      redis: 'ping-failed',
      error: String(err?.message ?? err),
      cron: invokedByCron,
      elapsedMs: Date.now() - startedAt,
    });
  }
}
