/**
 * BannerBye — auto-submit report endpoint (Phase 1, v0.2.0)
 *
 * POST /api/report
 *   body: { hostname: string, version: string, message?: string }
 *   responses:
 *     200 { ok: true }      — verstuurd
 *     400 { error: "..." }  — invalid payload
 *     429 { error: "..." }  — rate limited (max 5/IP/uur)
 *     500 { error: "..." }  — Resend faalde
 *
 * Resend SMTP is al gekoppeld aan bannerbye.com (zie eerdere DNS setup +
 * Resend API key in Vercel env vars onder RESEND_API_KEY).
 *
 * Rate-limit: Redis-gebaseerd (zie lib/store.ts bumpRateLimit/isOverRateLimit,
 * fix #5, security-audit 2026-09-16) — vervangt de oude in-memory `Map`, die
 * onder Vercel's parallelle serverless-instances niet betrouwbaar telde.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { persistReport, addWatcher, isOverRateLimit } from '../lib/store.js';

// We gebruiken Resend's REST API direct via fetch — geen SDK-dependency.
// Reden: resend@4.x is ESM-only en geeft FUNCTION_INVOCATION_FAILED in
// Vercel's CJS-by-default runtime. fetch werkt out-of-the-box in Node 20+
// op Vercel, zonder ESM/CJS-gedoe.
const RESEND_API_ENDPOINT = 'https://api.resend.com/emails';

const REPORT_TO = 'hello@bannerbye.com';
const REPORT_FROM = 'BannerBye Reports <hello@bannerbye.com>';

// v0.4.5 (fix #15, security-audit 2026-09-16): CORS beperkt tot ons eigen
// domein. De extensie zelf is hier niet van afhankelijk — die heeft
// host_permissions "<all_urls>" (zie wxt.config.ts) en Chrome/Firefox/Safari
// negeren CORS voor requests vanuit een context met host-permissie op de
// doel-URL, ongeacht de Access-Control-Allow-Origin-waarde. Een wildcard
// hielp dus alleen willekeurige websites om deze endpoint (met een bezoekers
// browser/IP als proxy) aan te roepen — geen legitiem gebruik dat we kwijtraken.
const ALLOWED_ORIGIN = 'https://bannerbye.com';

// De analyzer-workflow draait in de extensie-repo. Bij elke geldige melding
// vuren we daar een repository_dispatch af, zodat de AI meteen aan de slag gaat
// i.p.v. te wachten op een dagschema. Token = env GH_DISPATCH_TOKEN (scope: bij
// een classic PAT `repo`; bij een fine-grained PAT read/write op "Contents").
const GH_DISPATCH_REPO = process.env.GH_DISPATCH_REPO || 'BannerBye/BannerBye';

/**
 * Trigger de analyzer meteen via GitHub repository_dispatch. Best-effort met
 * korte timeout — een fout hier mag de melding NOOIT laten klappen.
 */
async function triggerAnalysis(hostname: string): Promise<void> {
  const token = process.env.GH_DISPATCH_TOKEN;
  if (!token) {
    console.warn('[api/report] GH_DISPATCH_TOKEN ontbreekt — sla trigger over.');
    return;
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const resp = await fetch(
      `https://api.github.com/repos/${GH_DISPATCH_REPO}/dispatches`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
          'User-Agent': 'bannerbye-report',
        },
        body: JSON.stringify({
          event_type: 'report-submitted',
          client_payload: { hostname },
        }),
        signal: controller.signal,
      },
    );
    clearTimeout(timer);
    if (!resp.ok) {
      console.error(
        '[api/report] dispatch HTTP',
        resp.status,
        (await resp.text()).slice(0, 200),
      );
    }
  } catch (err) {
    console.error('[api/report] dispatch failed:', err);
  }
}

// Rate-limit: max 5 reports per IP per uur.
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_S = 60 * 60;

// Per-host rate-limit: max 3 reports per host per uur (anti-flood per site).
const PER_HOST_MAX = 3;

/** Sanitize string: max length, strip control chars. Defense against abuse. */
function sanitize(value: unknown, maxLen: number): string {
  if (typeof value !== 'string') return '';
  return value.slice(0, maxLen).replace(/[\x00-\x1F\x7F]/g, '').trim();
}

/** Optioneel opt-in e-mailadres. Tolerant, alleen om onzin te weren. */
function validEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || trimmed.length > 254) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * v0.4.5 (fix #4, security-audit 2026-09-16) — SSRF-denylist.
 *
 * Een gemelde hostname wordt uren later door de Phase 2B-analyzer bezocht met
 * een headless browser die draait in een GitHub Actions-job met secrets in
 * zijn environment (ANTHROPIC_API_KEY, LANDING_REPO_TOKEN met push-rechten,
 * KV_REST_API_TOKEN, RESEND_API_KEY). validHostname() hieronder stond al
 * "127.0.0.1" of "169.254.169.254" (de cloud-metadata-endpoint bij AWS/GCP/
 * Azure) gewoon toe. Blokkeer bekende loopback/private/metadata-hostnames
 * al hier, bij de submit — het vroegste en goedkoopste punt.
 *
 * Bekende resterende beperking: dit is een check op de LETTERLIJKE hostname-
 * string, geen DNS-rebinding-bescherming — een ogenschijnlijk normale
 * hostname die pas bij het daadwerkelijke bezoek (analyze.ts, uren later)
 * naar een interne/metadata-IP resolvet, glipt hier doorheen. Een volledige
 * fix vereist DNS-resolutie + IP-pinning vlak vóór het Playwright-bezoek,
 * wat een grotere wijziging is dan deze patch — zie
 * BannerBye_Security-Audit_2026-09-16_INTERN.md, bevinding 4.
 */
function isDeniedHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();

  const DENIED_EXACT = new Set([
    'localhost',
    'localhost.localdomain',
    'ip6-localhost',
    'ip6-loopback',
    'broadcasthost',
    'metadata',
    'metadata.google.internal',
    'metadata.internal',
  ]);
  if (DENIED_EXACT.has(h)) return true;

  // IPv4-literal? (IPv6-literals met ':' vallen al buiten validHostname's
  // [a-z0-9.-]+-regex, dus die hoeven we hier niet apart te dekken.)
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a > 255 || b > 255 || Number(m[3]) > 255 || Number(m[4]) > 255) {
      return true; // geen geldig IPv4 — sowieso niets zinnigs om te bezoeken
    }
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 10) return true; // 10.0.0.0/8 private
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  }

  return false;
}

/** Strip aria/host to plausible hostname. Geen pad of querystring toegestaan. */
function validHostname(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  // Strikte check: alleen letters, cijfers, punt, streep. Geen pad of port.
  if (!/^[a-z0-9.-]+$/.test(trimmed)) return null;
  if (trimmed.length > 253) return null;
  if (isDeniedHostname(trimmed)) return null;
  return trimmed;
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  // CORS preflight — beperkt tot ons eigen domein (fix #15). De extensie zelf
  // is hier niet van afhankelijk, zie ALLOWED_ORIGIN hierboven.
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // Extract client IP (Vercel sets x-forwarded-for)
  const ipHeader = req.headers['x-forwarded-for'];
  const ip = Array.isArray(ipHeader)
    ? ipHeader[0]
    : (ipHeader ?? 'unknown').split(',')[0]!.trim();

  if (await isOverRateLimit(`report:ip:${ip}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_S)) {
    res.status(429).json({ error: 'Too many reports — try again later' });
    return;
  }

  // Validate payload
  const body = (req.body ?? {}) as {
    hostname?: unknown;
    version?: unknown;
    message?: unknown;
    email?: unknown;
  };
  const hostname = validHostname(body.hostname);
  const version = sanitize(body.version, 32);
  const message = sanitize(body.message, 2000);
  const email = validEmail(body.email); // null = geen/ongeldig = anoniem

  if (!hostname) {
    res.status(400).json({ error: 'Invalid hostname' });
    return;
  }
  if (!version) {
    res.status(400).json({ error: 'Missing version' });
    return;
  }

  if (await isOverRateLimit(`report:host:${hostname}`, PER_HOST_MAX, RATE_LIMIT_WINDOW_S)) {
    res.status(429).json({ error: 'Too many reports for this site' });
    return;
  }

  // Send email via Resend
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('[api/report] RESEND_API_KEY not configured');
    res.status(500).json({ error: 'Server misconfigured' });
    return;
  }

  const now = Date.now();

  try {
    const userAgent = sanitize(req.headers['user-agent'], 256) || 'unknown';
    const lines = [
      `Hostname: ${hostname}`,
      `Version:  ${version}`,
      `IP:       ${ip}`,
      `UA:       ${userAgent}`,
      `Time:     ${new Date(now).toISOString()}`,
      `Notify:   ${email ? `${email} (opted in — will be emailed when fixed)` : 'no (anonymous)'}`,
      ``,
      `--- User message ---`,
      message || '(no additional context)',
      ``,
      `---`,
      `Reported via BannerBye extension`,
    ];
    const resendRes = await fetch(RESEND_API_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: REPORT_FROM,
        to: REPORT_TO,
        subject: `[BannerBye] Broken on ${hostname}`,
        text: lines.join('\n'),
      }),
    });
    if (!resendRes.ok) {
      const errBody = await resendRes.text();
      console.error(
        '[api/report] Resend HTTP error:',
        resendRes.status,
        errBody,
      );
      res.status(500).json({ error: 'Failed to deliver report' });
      return;
    }
  } catch (err) {
    console.error('[api/report] Resend fetch failed:', err);
    res.status(500).json({ error: 'Failed to deliver report' });
    return;
  }

  // Phase 2A: persisteer naar Redis voor /api/reports + /admin.
  // Best-effort — persistReport gooit nooit; bij falen blijft mail de bron.
  const userAgentForStore = sanitize(req.headers['user-agent'], 256) || 'unknown';
  await persistReport({
    hostname,
    version,
    ip,
    ua: userAgentForStore,
    message,
    ts: now,
  });

  // Phase 2C (#reward-3): opt-in "email me when fixed". Best-effort; een fout
  // hier mag de melding nooit laten klappen. Alleen bij een geldig adres.
  if (email) {
    await addWatcher(hostname, email);
  }

  // Meteen de analyzer aftrappen (i.p.v. dagschema). Best-effort en vóór de
  // response, want een serverless function kan na res.json() bevriezen.
  await triggerAnalysis(hostname);

  res.status(200).json({ ok: true });
}
