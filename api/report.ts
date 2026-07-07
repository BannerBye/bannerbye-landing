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
 * In-memory rate-limit: simpel, werkt voor low-volume MVP. Bij groei
 * migreren naar Vercel KV (Phase 2A).
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { persistReport, addWatcher } from '../lib/store.js';

// We gebruiken Resend's REST API direct via fetch — geen SDK-dependency.
// Reden: resend@4.x is ESM-only en geeft FUNCTION_INVOCATION_FAILED in
// Vercel's CJS-by-default runtime. fetch werkt out-of-the-box in Node 20+
// op Vercel, zonder ESM/CJS-gedoe.
const RESEND_API_ENDPOINT = 'https://api.resend.com/emails';

const REPORT_TO = 'hello@bannerbye.com';
const REPORT_FROM = 'BannerBye Reports <hello@bannerbye.com>';

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
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

// Per-host rate-limit: max 3 reports per host per uur (anti-flood per site).
const PER_HOST_MAX = 3;

const reportTimestampsByIp = new Map<string, number[]>();
const reportTimestampsByHost = new Map<string, number[]>();

function cleanTimestamps(arr: number[], now: number): number[] {
  return arr.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
}

function isOverLimit(
  map: Map<string, number[]>,
  key: string,
  max: number,
  now: number,
): boolean {
  const recent = cleanTimestamps(map.get(key) ?? [], now);
  map.set(key, recent);
  return recent.length >= max;
}

function record(map: Map<string, number[]>, key: string, now: number): void {
  const recent = cleanTimestamps(map.get(key) ?? [], now);
  recent.push(now);
  map.set(key, recent);
}

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

/** Strip aria/host to plausible hostname. Geen pad of querystring toegestaan. */
function validHostname(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  // Strikte check: alleen letters, cijfers, punt, streep. Geen pad of port.
  if (!/^[a-z0-9.-]+$/.test(trimmed)) return null;
  if (trimmed.length > 253) return null;
  return trimmed;
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  // CORS preflight — extension fetch stuurt automatisch credentials/headers
  res.setHeader('Access-Control-Allow-Origin', '*');
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

  const now = Date.now();
  if (isOverLimit(reportTimestampsByIp, ip, RATE_LIMIT_MAX, now)) {
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

  if (isOverLimit(reportTimestampsByHost, hostname, PER_HOST_MAX, now)) {
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

  record(reportTimestampsByIp, ip, now);
  record(reportTimestampsByHost, hostname, now);

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
