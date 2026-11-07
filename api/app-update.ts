/**
 * BannerBye — /app-update.json, dynamisch (7 nov 2026)
 *
 * GET /app-update.json  (vercel.json herschrijft naar /api/app-update)
 *   response 200 { ios: { on, latest, minimum }, macos: { on, latest, minimum } }
 *
 * Gelezen door de iPhone/iPad/Mac-app (ViewController.swift, BannerByeUpdate)
 * om een update-kaart of de "Update required"-noodrem te tonen. Tot 7 nov was
 * dit een statisch bestand dat na élke Apple-goedkeuring met de hand moest
 * worden bijgewerkt — en dat dus steeds een paar dagen achterliep.
 *
 * Nu: `latest` komt live uit de App Store zelf, per platform en zonder
 * credentials.
 *   - iOS:   iTunes Lookup API (JSON) — `results[0].version`.
 *   - macOS: de publieke App Store-pagina met ?platform=mac. De Lookup-API
 *            geeft voor een universal-purchase-app alleen de iOS-versie
 *            terug, terwijl macOS historisch achterloopt (1.3.13/1.3.14/
 *            1.3.16 zijn op Mac nooit live gegaan). De pagina bevat per
 *            platform de versiegeschiedenis; we nemen de hoogste.
 * `on` en `minimum` blijven handmatige config (lib/app-update-config.ts) —
 * dat zijn beslissingen, geen feiten.
 *
 * Vangrails:
 *   - Versies moeten op /^\d+(\.\d+){1,3}$/ matchen, anders worden ze genegeerd.
 *   - Laatst bekende goede waarden staan in Redis (`bb:app-update:latest`,
 *     geen TTL). Faalt Apple of de parse, dan serveren we die — nooit een
 *     lege of lagere `latest`, want dan zou een gebruiker ten onrechte een
 *     update-kaart kwijtraken of krijgen.
 *   - Apple wordt hooguit eens per uur bevraagd (Redis `fetchedAt`), de app
 *     zelf checkt ook maar eens per uur. Fail-open zonder Redis: dan per
 *     function-instance een in-memory cache van een uur.
 *   - Geen gebruikersdata in, geen gebruikersdata uit. Zelfde belofte als het
 *     statische bestand had.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getRedis } from '../lib/store.js';
import { APP_UPDATE_CONFIG, APP_STORE_ID } from '../lib/app-update-config.js';

const REDIS_KEY = 'bb:app-update:latest';
const REFRESH_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 6000;
const VERSION_RE = /^\d+(\.\d+){1,3}$/;
const UA = 'BannerBye-app-update/1.0 (+https://bannerbye.com)';

interface LatestRecord {
  ios: string;
  macos: string;
  fetchedAt: number;
}

let memory: LatestRecord | null = null;

function isVersion(v: unknown): v is string {
  return typeof v === 'string' && VERSION_RE.test(v);
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function maxVersion(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return compareVersions(a, b) >= 0 ? a : b;
}

async function fetchText(url: string, accept: string): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, Accept: accept, 'Accept-Language': 'nl-NL,nl;q=0.9,en;q=0.5' },
      redirect: 'follow',
    });
    if (!res.ok) return null;
    return await res.text();
  } catch (err) {
    console.warn('[api/app-update] fetch failed:', url, err instanceof Error ? err.message : err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** iOS: iTunes Lookup. Eén JSON-call, geen HTML. */
async function fetchIosVersion(): Promise<string | null> {
  const url = `https://itunes.apple.com/lookup?id=${APP_STORE_ID}&country=nl`;
  const body = await fetchText(url, 'application/json');
  if (!body) return null;
  try {
    const json = JSON.parse(body) as { results?: Array<{ version?: unknown; kind?: unknown }> };
    const hit = json.results?.find((r) => r.kind === 'software' && isVersion(r.version));
    return hit && isVersion(hit.version) ? hit.version : null;
  } catch {
    return null;
  }
}

/**
 * macOS: de publieke productpagina met ?platform=mac. De versiegeschiedenis
 * staat als `"primarySubtitle":"Versie 1.3.18"` (NL) in de ingebakken JSON;
 * de zichtbare variant is `<span …>Versie 1.3.18</span>`. We pakken alle
 * treffers en nemen de hoogste — dan maakt de volgorde op de pagina niet uit.
 */
async function fetchMacVersion(): Promise<string | null> {
  const url = `https://apps.apple.com/nl/app/bannerbye/id${APP_STORE_ID}?platform=mac`;
  const html = await fetchText(url, 'text/html');
  if (!html) return null;
  const re = /(?:"primarySubtitle":"|>)(?:Versie|Version)\s+(\d+(?:\.\d+){1,3})(?:"|<)/g;
  let best: string | null = null;
  for (const m of html.matchAll(re)) {
    if (isVersion(m[1])) best = maxVersion(best, m[1]);
  }
  return best;
}

async function readStored(): Promise<LatestRecord | null> {
  const redis = getRedis();
  if (!redis) return memory;
  try {
    const raw = await redis.get<LatestRecord | string>(REDIS_KEY);
    if (!raw) return memory;
    const rec = typeof raw === 'string' ? (JSON.parse(raw) as LatestRecord) : raw;
    if (isVersion(rec.ios) && isVersion(rec.macos) && typeof rec.fetchedAt === 'number') return rec;
  } catch (err) {
    console.warn('[api/app-update] redis read failed:', err);
  }
  return memory;
}

async function writeStored(rec: LatestRecord): Promise<void> {
  memory = rec;
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.set(REDIS_KEY, JSON.stringify(rec));
  } catch (err) {
    console.warn('[api/app-update] redis write failed:', err);
  }
}

/**
 * Levert de actuele `latest` per platform. Verser dan een uur → zoals
 * opgeslagen. Ouder → opnieuw bij Apple ophalen; per platform geldt: een
 * geldige, niet-lagere versie vervangt de oude, al het andere laat de oude
 * staan. Zo kan één mislukte parse nooit een update-kaart laten verdwijnen.
 */
async function resolveLatest(): Promise<LatestRecord | null> {
  const stored = await readStored();
  if (stored && Date.now() - stored.fetchedAt < REFRESH_MS) return stored;

  const [ios, macos] = await Promise.all([fetchIosVersion(), fetchMacVersion()]);
  const nextIos = maxVersion(stored?.ios ?? null, ios);
  const nextMac = maxVersion(stored?.macos ?? null, macos);
  if (!nextIos || !nextMac) {
    // Allereerste run zonder Apple-antwoord: niets te serveren.
    return stored;
  }
  const rec: LatestRecord = {
    ios: nextIos,
    macos: nextMac,
    // Bij een mislukte fetch korter wachten (10 min) i.p.v. een uur.
    fetchedAt: ios && macos ? Date.now() : Date.now() - REFRESH_MS + 10 * 60 * 1000,
  };
  await writeStored(rec);
  return rec;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const latest = await resolveLatest();
  if (!latest) {
    // Liever 503 dan een verzonnen versie: de app negeert alles behalve 200
    // en probeert het later gewoon opnieuw.
    res.setHeader('Cache-Control', 'no-store');
    res.status(503).json({ error: 'App Store version unavailable' });
    return;
  }

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400');
  res.status(200).json({
    _doc:
      'Read by the BannerBye app for iPhone, iPad and Mac to show an update notice. Contains no user data. ' +
      'latest = the version currently live in the App Store for that platform (read from Apple, refreshed hourly). ' +
      'on=true + latest newer than installed -> dismissible notice; minimum newer than installed -> required update.',
    ios: { on: APP_UPDATE_CONFIG.ios.on, latest: latest.ios, minimum: APP_UPDATE_CONFIG.ios.minimum },
    macos: { on: APP_UPDATE_CONFIG.macos.on, latest: latest.macos, minimum: APP_UPDATE_CONFIG.macos.minimum },
    checkedAt: new Date(latest.fetchedAt).toISOString(),
  });
}
