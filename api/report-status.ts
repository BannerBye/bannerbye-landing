/**
 * BannerBye — anonieme ticket-status (v0.4.12, 21 okt 2026)
 *
 * GET /api/report-status?ids=k7m2q9xd,…   (max 20, komma-gescheiden)
 *   200 { tickets: { "<id>": { hostname, status, note?, version?, ts } } }
 *
 * PUBLIEK — geen token, geen persoonsgegevens. Een ticket-ID is willekeurig,
 * staat alleen op het apparaat dat meldde, en levert niets anders op dan de
 * hostnaam die dat apparaat zelf al kent plus de fix-status van die site.
 * Zie lib/store.ts (registerTicket / resolveTicketStatus).
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { resolveTicketStatus, isOverRateLimit } from '../lib/store.js';

function firstString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length) return String(value[0]);
  return '';
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // Ruime limiet (de extensie vraagt max 1×/uur), vooral tegen ID-raden.
  const ipHeader = req.headers['x-forwarded-for'];
  const ip = Array.isArray(ipHeader) ? ipHeader[0] : (ipHeader ?? 'unknown').split(',')[0]!.trim();
  if (await isOverRateLimit(`ticket-status:ip:${ip}`, 60, 60 * 60)) {
    res.status(429).json({ error: 'Too many requests' });
    return;
  }

  const ids = firstString(req.query['ids'])
    .toLowerCase()
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 20);
  if (!ids.length) {
    res.status(400).json({ error: 'Missing ids' });
    return;
  }

  try {
    const tickets = await resolveTicketStatus(ids);
    res.status(200).json({ tickets });
  } catch (err) {
    console.error('[api/report-status] failed:', err);
    res.status(500).json({ error: 'Internal error' });
  }
}
