/**
 * BannerBye — public "recently killed" feed (Phase 2C, #reward-2)
 *
 * GET /api/fixed
 *   query: limit=<n> (1..200, default 60)
 *   response 200 { count, fixed: [{ hostname, keyword, fixedAt }] }
 *
 * PUBLIEK — geen token. Geeft NOOIT persoonlijke data terug: alleen de
 * hostnaam die is opgelost, het toegepaste keyword en de datum. Voedt de
 * publieke changelog op /fixed (sociale proof + beloning voor melders).
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { listFixed } from '../lib/store.js';

function firstString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length) return String(value[0]);
  return '';
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  // Kort cachen: de feed hoeft niet real-time te zijn.
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const parsed = Number.parseInt(firstString(req.query['limit']) || '', 10);
  const limit = Number.isNaN(parsed) ? 60 : Math.min(Math.max(parsed, 1), 200);

  try {
    const fixed = await listFixed({ limit });
    res.status(200).json({
      count: fixed.length,
      fixed: fixed.map((f) => ({
        hostname: f.hostname,
        keyword: f.keyword,
        fixedAt: f.fixedAt,
      })),
    });
  } catch (err) {
    console.error('[api/fixed] handler failed:', err);
    res.status(500).json({ error: 'Internal error' });
  }
}
