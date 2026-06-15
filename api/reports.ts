/**
 * BannerBye — admin reports endpoint (Phase 2A, v0.3.0)
 *
 * GET /api/reports
 *   auth: Bearer-token (header `Authorization: Bearer <ADMIN_TOKEN>`)
 *         of query `?token=<ADMIN_TOKEN>` (handig vanuit de /admin-pagina).
 *   query:
 *     view=reports | hosts | stats   (default: reports)
 *     hostname=<host>                 (alleen view=reports — filter)
 *     limit=<n>                       (1..500, default 100)
 *     offset=<n>                      (default 0, alleen view=reports)
 *   responses:
 *     200 { view, ... }   — data
 *     401 { error }       — geen/onjuiste token
 *     503 { error }       — storage niet geconfigureerd
 *
 * Token staat in Vercel env var ADMIN_TOKEN (Production). Niet in de repo.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  listReports,
  listHostSummary,
  getStats,
  storageEnabled,
  deleteHost,
  deleteReport,
} from '../lib/store.js';

/** Timing-safe-ish string compare (constant-time over de kortste lengte). */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function extractToken(req: VercelRequest): string {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return auth.slice('Bearer '.length).trim();
  }
  const q = req.query['token'];
  if (typeof q === 'string') return q.trim();
  if (Array.isArray(q) && q.length) return String(q[0]).trim();
  return '';
}

function firstString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length) return String(value[0]);
  return '';
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET' && req.method !== 'DELETE') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // .trim() op expected: Vercel UI plakte soms trailing whitespace/newline mee
  // in de env-var, wat een length-mismatch in safeEqual triggerde → 401.
  const expected = (process.env.ADMIN_TOKEN || '').trim();
  if (!expected) {
    console.error('[api/reports] ADMIN_TOKEN not configured');
    res.status(503).json({ error: 'Admin endpoint not configured' });
    return;
  }
  const provided = extractToken(req);
  if (!provided || !safeEqual(provided, expected)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  if (!storageEnabled()) {
    res.status(503).json({ error: 'Storage not configured' });
    return;
  }

  // ---- DELETE: verwijder een hele host of één losse melding ----
  if (req.method === 'DELETE') {
    const hostnameRaw = firstString(req.query['hostname']).toLowerCase();
    const hostname = /^[a-z0-9.-]+$/.test(hostnameRaw) ? hostnameRaw : '';
    const id = firstString(req.query['id']).trim();
    if (!hostname) {
      res.status(400).json({ error: 'Missing or invalid hostname' });
      return;
    }
    try {
      if (id) {
        if (!/^[0-9]+-[a-z0-9]+$/.test(id)) {
          res.status(400).json({ error: 'Invalid id' });
          return;
        }
        const ok = await deleteReport(id, hostname);
        res.status(200).json({ ok, deleted: ok ? 1 : 0 });
        return;
      }
      const deleted = await deleteHost(hostname);
      res.status(200).json({ ok: true, deleted });
      return;
    } catch (err) {
      console.error('[api/reports] DELETE failed:', err);
      res.status(500).json({ error: 'Internal error' });
      return;
    }
  }

  const view = firstString(req.query['view']) || 'reports';
  const limit = Number.parseInt(firstString(req.query['limit']) || '', 10);
  const offset = Number.parseInt(firstString(req.query['offset']) || '', 10);

  try {
    if (view === 'stats') {
      const stats = await getStats();
      res.status(200).json({ view: 'stats', ...stats });
      return;
    }
    if (view === 'hosts') {
      const hosts = await listHostSummary({
        limit: Number.isNaN(limit) ? undefined : limit,
      });
      res.status(200).json({ view: 'hosts', count: hosts.length, hosts });
      return;
    }
    // default: reports
    const hostnameRaw = firstString(req.query['hostname']).toLowerCase();
    const hostname = /^[a-z0-9.-]+$/.test(hostnameRaw) ? hostnameRaw : undefined;
    const reports = await listReports({
      hostname,
      limit: Number.isNaN(limit) ? undefined : limit,
      offset: Number.isNaN(offset) ? undefined : offset,
    });
    res.status(200).json({
      view: 'reports',
      hostname: hostname ?? null,
      count: reports.length,
      reports,
    });
  } catch (err) {
    console.error('[api/reports] handler failed:', err);
    res.status(500).json({ error: 'Internal error' });
  }
}
