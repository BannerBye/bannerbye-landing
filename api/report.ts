/**
 * BannerBye — auto-submit report endpoint (Phase 1, v0.2.0)
 *
 * POST /api/report
 *   body: { hostname: string, version: string, message?: string, ticket?: string,
 *           v?: 2, path?: string, lang?: string, snapshot?: ReportSnapshot, trace?: string }
 *   (v0.4.17 — pijplijn v2: path/lang/snapshot/trace zijn optioneel en worden
 *    hier opnieuw gevalideerd en begrensd; zie validSnapshot() hieronder.)
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
import {
  persistReport,
  addWatcher,
  isOverRateLimit,
  registerTicket,
  TICKET_ID_RE,
  type ReportSnapshot,
} from '../lib/store.js';

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
 * Ontvangstbevestiging aan een melder die een e-mailadres achterliet.
 * Best-effort: logt bij falen, gooit nooit.
 */
async function sendAcknowledgement(apiKey: string, email: string, hostname: string): Promise<void> {
  const text = [
    `Thanks — we got your report about ${hostname}.`,
    ``,
    `What happens next: an automated check visits the site and proposes a fix; a human reviews it before it ships. Fixes reach every BannerBye user through the rule list, usually without an extension update. You'll get one more email from us when ${hostname} is handled.`,
    ``,
    `Until then, you can pause BannerBye on that site from the toolbar button if it gets in the way.`,
    ``,
    `Recent fixes: https://bannerbye.com/fixed`,
    `Reply to this email if you want to add anything.`,
    ``,
    `— BannerBye`,
  ].join('\n');
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const r = await fetch(RESEND_API_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'BannerBye <hello@bannerbye.com>',
        to: email,
        reply_to: REPORT_TO,
        subject: `We got your report about ${hostname}`,
        text,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!r.ok) console.error('[api/report] acknowledgement failed:', r.status, await r.text());
  } catch (err) {
    console.error('[api/report] acknowledgement fetch failed:', err);
  }
}

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

// ---------------------------------------------------------------------------
// v0.4.17 (pijplijn v2) — context van de melder. Alles optioneel, alles
// opnieuw begrensd: de extensie poetst zelf al, maar deze endpoint is publiek
// en de payload kan van iedereen komen. Harde maxima houden Redis klein en
// de analyse-prompt veilig (claude.ts wikkelt alles in een untrusted-blok).
// ---------------------------------------------------------------------------
const SNAP_MAX_CANDIDATES = 40;
const SNAP_MAX_LABEL = 160;
const SNAP_MAX_BANNER = 400;
const SNAP_MAX_ATTRS = 12;
const SNAP_MAX_LIST = 8;
const SNAP_MAX_JSON = 16 * 1024;

/** Pad opnieuw opschonen: alleen een pad, geen query/hash, tokens weg. */
function validPath(value: unknown): string {
  if (typeof value !== 'string') return '/';
  let p = value.trim();
  if (!p.startsWith('/') || p.length > 200) return '/';
  p = p.split(/[?#]/)[0]!;
  if (!/^[A-Za-z0-9/_\-.~%*]*$/.test(p)) return '/';
  const parts = p.split('/').map((seg) => {
    if (!seg) return seg;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return '*';
    if (/^\d{4,}$/.test(seg)) return '*';
    if (seg.length >= 24 && /\d/.test(seg)) return '*';
    return seg;
  });
  return parts.join('/').replace(/\/{2,}/g, '/') || '/';
}

function validLang(value: unknown): string {
  if (typeof value !== 'string') return '';
  const v = value.trim();
  return /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(v) ? v.slice(0, 16) : '';
}

function strList(value: unknown, maxItems: number, maxLen: number, re?: RegExp): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== 'string') continue;
    const s = sanitize(v, maxLen);
    if (!s || (re && !re.test(s))) continue;
    if (!out.includes(s)) out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}

/** Snapshot valideren en inkorten. Null bij onzin — de melding gaat dan zonder. */
function validSnapshot(value: unknown): ReportSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  try {
    if (JSON.stringify(value).length > SNAP_MAX_JSON) return null;
  } catch {
    return null;
  }
  const o = value as Record<string, unknown>;
  const rawCands = Array.isArray(o.candidates) ? o.candidates : [];
  const candidates: ReportSnapshot['candidates'] = [];
  for (const c of rawCands) {
    if (!c || typeof c !== 'object') continue;
    const cc = c as Record<string, unknown>;
    const text = sanitize(cc.text, SNAP_MAX_LABEL);
    if (!text) continue;
    const tag = sanitize(cc.tag, 24).toLowerCase().replace(/[^a-z0-9-]/g, '') || 'unknown';
    const attrs = strList(cc.attrs, SNAP_MAX_ATTRS, 32, /^[a-z0-9]+$/);
    candidates.push({ text, tag, inBanner: cc.inBanner === true, ...(attrs.length ? { attrs } : {}) });
    if (candidates.length >= SNAP_MAX_CANDIDATES) break;
  }
  const vp = (o.viewport && typeof o.viewport === 'object' ? o.viewport : {}) as Record<string, unknown>;
  const num = (v: unknown, max: number): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? Math.round(v) : 0;
  return {
    v: num(o.v, 99) || 1,
    at: num(o.at, 9e15),
    candidates,
    bannerFound: o.bannerFound === true,
    bannerText: sanitize(o.bannerText, SNAP_MAX_BANNER),
    cmps: strList(o.cmps, SNAP_MAX_LIST, 40),
    iframes: strList(o.iframes, SNAP_MAX_LIST, 253, /^[a-z0-9.-]+$/).filter((h) => !isDeniedHostname(h)),
    pageLang: validLang(o.pageLang),
    uiLang: validLang(o.uiLang),
    viewport: { w: num(vp.w, 20000), h: num(vp.h, 20000) },
    totalClickables: num(o.totalClickables, 100000),
  };
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
    ticket?: unknown;
    v?: unknown;
    path?: unknown;
    lang?: unknown;
    snapshot?: unknown;
    trace?: unknown;
  };
  const hostname = validHostname(body.hostname);
  const version = sanitize(body.version, 32);
  const message = sanitize(body.message, 2000);
  const email = validEmail(body.email); // null = geen/ongeldig = anoniem
  // v0.4.12: anoniem ticket-ID, door de extensie zelf gemaakt en alleen daar
  // bewaard. Koppelt het apparaat aan de fix-status van déze site, zonder
  // dat wij weten welk apparaat. Zie lib/store.ts.
  const ticketRaw = sanitize(body.ticket, 16).toLowerCase();
  const ticket = TICKET_ID_RE.test(ticketRaw) ? ticketRaw : null;
  // v0.4.17 (pijplijn v2): context van de melder — zie validators hierboven.
  const path = validPath(body.path);
  const lang = validLang(body.lang);
  const snapshot = validSnapshot(body.snapshot);
  const trace = sanitize(body.trace, 2000);

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
      `Notify:   ${email ? `${email} (opted in — will be emailed when fixed)` : ticket ? `ticket ${ticket} (anonymous, via popup)` : 'no (anonymous)'}`,
      `Path:     ${path}${lang ? `   Lang: ${lang}` : ''}`,
      ``,
      `--- User message ---`,
      message || '(no additional context)',
      ``,
      ...(snapshot
        ? [
            `--- What the reporter saw (snapshot v${snapshot.v}) ---`,
            `Banner container found by extension: ${snapshot.bannerFound ? 'yes' : 'no'} · viewport ${snapshot.viewport.w}×${snapshot.viewport.h} · page lang ${snapshot.pageLang || '-'}`,
            `CMP signatures: ${snapshot.cmps.join(', ') || '-'} · consent iframes: ${snapshot.iframes.join(', ') || '-'}`,
            `Buttons (${snapshot.candidates.length}): ${
              snapshot.candidates.map((c) => `${c.inBanner ? '●' : '○'} "${c.text}"`).join('  ') || '-'
            }`,
            snapshot.bannerText ? `Banner text: ${snapshot.bannerText}` : '',
            ``,
          ].filter((l) => l !== '')
        : []),
      ...(trace ? [`--- Trace ---`, trace, ``] : []),
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
    path,
    ...(lang ? { lang } : {}),
    ...(snapshot ? { snapshot } : {}),
    ...(trace ? { trace } : {}),
  });

  if (ticket) await registerTicket(ticket, hostname);

  // Phase 2C (#reward-3): opt-in "email me when fixed". Best-effort; een fout
  // hier mag de melding nooit laten klappen. Alleen bij een geldig adres.
  if (email) {
    await addWatcher(hostname, email);
    // 5 okt 2026 (productonderzoek, bouwpunt 3): directe ontvangstbevestiging.
    // Tot nu toe hoorde een melder pas iets bij een fix — en bij een melding
    // die geen codefix nodig had (of die bleef liggen) dus nooit. Eén korte
    // mail, geen marketing, geen tracking. Best-effort, na de interne mail,
    // zodat een Resend-storing hier nooit de melding zelf kost. Misbruik
    // (andermans adres invullen) is begrensd door de IP- en host-limieten
    // hierboven en de mail bevat niets van de melder behalve de hostname.
    await sendAcknowledgement(apiKey, email, hostname);
  }

  // Meteen de analyzer aftrappen (i.p.v. dagschema). Best-effort en vóór de
  // response, want een serverless function kan na res.json() bevriezen.
  await triggerAnalysis(hostname);

  res.status(200).json({ ok: true, ticket });
}
