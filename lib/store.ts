/**
 * BannerBye — report storage helper (Phase 2A, v0.3.0)
 *
 * Persisteert inkomende "Report broken site"-meldingen in Upstash Redis,
 * zodat /api/reports + de /admin-pagina ze kunnen tonen en aggregeren.
 *
 * Storage is BEST-EFFORT: als Redis niet is geconfigureerd of faalt, mag
 * dat NOOIT de /api/report-flow breken (mail blijft de bron-van-waarheid).
 *
 * Env-vars: de detectie is prefix-onafhankelijk (zie getRedis). Gezocht wordt
 * naar een gevulde key die "REST" bevat en op "URL" eindigt, plus een key die
 * "REST" + "API" bevat, op "TOKEN" eindigt en géén "READ" bevat. Dat dekt o.a.:
 *   - KV_REST_API_URL        / KV_REST_API_TOKEN         (Vercel-integratie)
 *   - UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN  (Upstash direct)
 *   - elke andere prefix die Vercel's Marketplace-integratie genereert
 * Reden: Redis.fromEnv() ging uit van exact die twee namen en gaf null zodra
 * Vercel een afwijkende prefix koos.
 *
 * Datamodel (alle keys geprefixed met bb:):
 *   bb:report:{id}          STRING(JSON)  een losse melding, TTL 180d
 *   bb:reports              ZSET          globale index, score=ts, member=id
 *   bb:host:reports:{host}  ZSET          per-host index, score=ts, member=id
 *   bb:hosts                ZSET          host-ranking, score=count, member=host
 *   bb:host:meta:{host}     HASH          {lastTs,lastVersion,lastMessage}
 */

import { Redis } from '@upstash/redis';

export interface StoredReport {
  id: string;
  hostname: string;
  version: string;
  ip: string;
  ua: string;
  message: string;
  ts: number;
}

export interface HostSummary {
  hostname: string;
  count: number;
  lastTs: number;
  lastVersion: string;
}

// Bewaartermijn van een losse melding. Index-ZSETs leven door, maar de
// detail-records vervallen na 180 dagen om storage klein te houden.
const REPORT_TTL_SECONDS = 180 * 24 * 60 * 60;

let cached: Redis | null | undefined;

/** Lazy singleton. Geeft null als de env-vars ontbreken (graceful degrade). */
export function getRedis(): Redis | null {
  if (cached !== undefined) return cached;

  const entries = Object.entries(process.env);
  const url = entries.find(([key, value]) =>
    Boolean(value) && key.includes("REST") && key.endsWith("URL"),
  )?.[1];
  const token = entries.find(([key, value]) =>
    Boolean(value) &&
    key.includes("REST") &&
    key.includes("API") &&
    key.endsWith("TOKEN") &&
    !key.includes("READ"),
  )?.[1];

  if (!url || !token) {
    cached = null;
    return cached;
  }

  try {
    cached = new Redis({ url, token });
  } catch (err) {
    console.error("[store] Redis init failed:", err);
    cached = null;
  }
  return cached;
}

/** Of persistentie überhaupt actief is (env aanwezig). */
export function storageEnabled(): boolean {
  return getRedis() !== null;
}

function newId(ts: number): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}-${rand}`;
}

/**
 * Persisteer één melding. Best-effort: gooit nooit — logt en returnt false
 * bij falen zodat de caller de request niet hoeft te laten klappen.
 */
export async function persistReport(
  input: Omit<StoredReport, 'id'>,
): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return false;
  const id = newId(input.ts);
  const record: StoredReport = { id, ...input };
  try {
    const p = redis.pipeline();
    p.set(`bb:report:${id}`, record, { ex: REPORT_TTL_SECONDS });
    p.zadd('bb:reports', { score: input.ts, member: id });
    p.zadd(`bb:host:reports:${input.hostname}`, {
      score: input.ts,
      member: id,
    });
    p.expire(`bb:host:reports:${input.hostname}`, REPORT_TTL_SECONDS);
    p.zincrby('bb:hosts', 1, input.hostname);
    p.hset(`bb:host:meta:${input.hostname}`, {
      lastTs: input.ts,
      lastVersion: input.version,
      lastMessage: input.message || '',
    });
    await p.exec();
    return true;
  } catch (err) {
    console.error('[store] persistReport failed:', err);
    return false;
  }
}

/**
 * Lijst meldingen, nieuwste eerst. Filter optioneel op hostname.
 */
export async function listReports(opts: {
  hostname?: string;
  limit?: number;
  offset?: number;
}): Promise<StoredReport[]> {
  const redis = getRedis();
  if (!redis) return [];
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);
  const indexKey = opts.hostname
    ? `bb:host:reports:${opts.hostname}`
    : 'bb:reports';
  try {
    const ids = (await redis.zrange(
      indexKey,
      offset,
      offset + limit - 1,
      { rev: true },
    )) as string[];
    if (!ids.length) return [];
    const keys = ids.map((id) => `bb:report:${id}`);
    const records = (await redis.mget<StoredReport[]>(...keys)) ?? [];
    // mget kan null bevatten voor verlopen records — filter die eruit.
    return records.filter((r): r is StoredReport => !!r && typeof r === 'object');
  } catch (err) {
    console.error('[store] listReports failed:', err);
    return [];
  }
}

/**
 * Geaggregeerde host-ranking, hoogste count eerst, met meta erbij.
 */
export async function listHostSummary(opts: {
  limit?: number;
}): Promise<HostSummary[]> {
  const redis = getRedis();
  if (!redis) return [];
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  try {
    const flat = (await redis.zrange('bb:hosts', 0, limit - 1, {
      rev: true,
      withScores: true,
    })) as (string | number)[];
    const hosts: { hostname: string; count: number }[] = [];
    for (let i = 0; i < flat.length; i += 2) {
      hosts.push({
        hostname: String(flat[i]),
        count: Number(flat[i + 1]),
      });
    }
    if (!hosts.length) return [];
    // Haal meta per host op (pipeline van hgetalls).
    const p = redis.pipeline();
    hosts.forEach((h) => p.hgetall(`bb:host:meta:${h.hostname}`));
    const metas = (await p.exec()) as (Record<string, unknown> | null)[];
    return hosts.map((h, i) => {
      const m = metas[i] ?? {};
      return {
        hostname: h.hostname,
        count: h.count,
        lastTs: Number(m?.['lastTs'] ?? 0),
        lastVersion: String(m?.['lastVersion'] ?? ''),
      };
    });
  } catch (err) {
    console.error('[store] listHostSummary failed:', err);
    return [];
  }
}

/**
 * Verwijder ALLE meldingen van één host + alle bijbehorende indexen/meta.
 * Geeft het aantal verwijderde meldingen terug.
 */
export async function deleteHost(hostname: string): Promise<number> {
  const redis = getRedis();
  if (!redis) return 0;
  try {
    const ids = (await redis.zrange(
      `bb:host:reports:${hostname}`,
      0,
      -1,
    )) as string[];
    const p = redis.pipeline();
    if (ids.length) {
      ids.forEach((id) => p.del(`bb:report:${id}`));
      p.zrem('bb:reports', ...ids);
    }
    p.del(`bb:host:reports:${hostname}`);
    p.zrem('bb:hosts', hostname);
    p.del(`bb:host:meta:${hostname}`);
    await p.exec();
    return ids.length;
  } catch (err) {
    console.error('[store] deleteHost failed:', err);
    return 0;
  }
}

/**
 * Verwijder één losse melding. Werkt de host-teller bij en ruimt de host
 * volledig op als dit zijn laatste melding was. hostname is vereist zodat we
 * geen extra read hoeven te doen (de admin-UI heeft 'm al).
 */
export async function deleteReport(
  id: string,
  hostname: string,
): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return false;
  try {
    const p = redis.pipeline();
    p.del(`bb:report:${id}`);
    p.zrem('bb:reports', id);
    p.zrem(`bb:host:reports:${hostname}`, id);
    await p.exec();
    // Werk de host-ranking bij; ruim host op als die op 0 staat.
    const remaining = await redis.zincrby('bb:hosts', -1, hostname);
    if (Number(remaining) <= 0) {
      const cleanup = redis.pipeline();
      cleanup.zrem('bb:hosts', hostname);
      cleanup.del(`bb:host:meta:${hostname}`);
      cleanup.del(`bb:host:reports:${hostname}`);
      await cleanup.exec();
    }
    return true;
  } catch (err) {
    console.error('[store] deleteReport failed:', err);
    return false;
  }
}

/**
 * v0.3.0 (#reward-3): opt-in "email me when fixed".
 * Sla het e-mailadres van een melder op in een per-host SET, zodat de analyzer
 * later één seintje kan sturen zodra de host is opgelost. Best-effort — gooit
 * nooit. TTL gelijk aan de report-bewaartermijn (180d) zodat oude watchers
 * vanzelf verlopen als er nooit een fix komt.
 */
export async function addWatcher(
  hostname: string,
  email: string,
): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return false;
  try {
    const key = `bb:host:watchers:${hostname}`;
    await redis.sadd(key, email);
    await redis.expire(key, REPORT_TTL_SECONDS);
    return true;
  } catch (err) {
    console.error('[store] addWatcher failed:', err);
    return false;
  }
}

export interface FixedEntry {
  hostname: string;
  keyword: string;
  list: string;
  fixedAt: number;
}

/**
 * v0.3.0 (#reward-2): lees de recent opgeloste hosts voor de publieke
 * /fixed-changelog. Bron = bb:fixed ZSET (score=fixedAt) + per-host meta.
 * Geeft NOOIT persoonlijke data terug — alleen hostname + keyword + datum.
 */
export async function listFixed(opts: {
  limit?: number;
}): Promise<FixedEntry[]> {
  const redis = getRedis();
  if (!redis) return [];
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  try {
    const hosts = (await redis.zrange('bb:fixed', 0, limit - 1, {
      rev: true,
    })) as string[];
    if (!hosts.length) return [];
    const p = redis.pipeline();
    hosts.forEach((h) => p.get(`bb:fixed:meta:${h}`));
    const metas = (await p.exec()) as (FixedEntry | null)[];
    return hosts.map((h, i) => {
      const m = metas[i];
      return {
        hostname: h,
        keyword: m?.keyword ?? '',
        list: m?.list ?? '',
        fixedAt: Number(m?.fixedAt ?? 0),
      };
    });
  } catch (err) {
    console.error('[store] listFixed failed:', err);
    return [];
  }
}

export interface FixTimeStats {
  /** Gemiddelde tijd tussen eerste melding en fix, in hele uren (afgerond). */
  averageFixHours: number | null;
  /** Mediaan, minder gevoelig voor een enkele trage uitschieter. */
  medianFixHours: number | null;
  /** Aantal fixes waarop de metric is gebaseerd. */
  sampleSize: number;
}

/**
 * v0.3.2 (#152): publieke fix-tijd-metric — "melding → live fix" in uren.
 * Bron: voor elke host in bb:fixed (score=fixedAt) pakken we de VROEGSTE
 * melding uit bb:host:reports:{host} (score=ts) als moment van melden.
 * Hosts zonder (nog resterende) report-index — bv. na de 180-dagen-TTL,
 * of handmatig via /admin gefixt zonder report — worden overgeslagen: die
 * leveren geen betrouwbare delta op, geen educated guess.
 *
 * Bewust hergebruikt: geen nieuwe Redis-keys, geen nieuwe cron, geen nieuwe
 * infrastructuur — dezelfde twee ZSETs die al bestonden voor /fixed en
 * /api/reports. Consistent met BannerBye's eigen "geen nieuwe leverancier"-
 * uitgangspunt (zie ook BannerBye-for-Teams_Scope-MVP_v1.md).
 */
export async function getFixTimeStats(opts: {
  sampleLimit?: number;
}): Promise<FixTimeStats> {
  const redis = getRedis();
  if (!redis) return { averageFixHours: null, medianFixHours: null, sampleSize: 0 };
  const sampleLimit = Math.min(Math.max(opts.sampleLimit ?? 100, 1), 500);
  try {
    const hosts = (await redis.zrange('bb:fixed', 0, sampleLimit - 1, {
      rev: true,
      withScores: true,
    })) as (string | number)[];
    if (!hosts.length) {
      return { averageFixHours: null, medianFixHours: null, sampleSize: 0 };
    }
    const pairs: { hostname: string; fixedAt: number }[] = [];
    for (let i = 0; i < hosts.length; i += 2) {
      pairs.push({ hostname: String(hosts[i]), fixedAt: Number(hosts[i + 1]) });
    }
    // Eén pipeline-call voor de vroegste melding per host (index 0, oplopend).
    const p = redis.pipeline();
    pairs.forEach((h) => p.zrange(`bb:host:reports:${h.hostname}`, 0, 0, { withScores: true }));
    const results = (await p.exec()) as (string | number)[][];

    const deltasHours: number[] = [];
    results.forEach((res, i) => {
      if (!res || res.length < 2) return; // geen report-index meer (TTL / handmatige fix)
      const firstReportTs = Number(res[1]);
      const fixedAt = pairs[i]!.fixedAt;
      const deltaMs = fixedAt - firstReportTs;
      if (deltaMs > 0) {
        deltasHours.push(deltaMs / (1000 * 60 * 60));
      }
    });

    if (!deltasHours.length) {
      return { averageFixHours: null, medianFixHours: null, sampleSize: 0 };
    }
    const sum = deltasHours.reduce((a, b) => a + b, 0);
    const average = sum / deltasHours.length;
    const sorted = [...deltasHours].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median =
      sorted.length % 2 !== 0
        ? sorted[mid]!
        : (sorted[mid - 1]! + sorted[mid]!) / 2;

    return {
      averageFixHours: Math.round(average * 10) / 10,
      medianFixHours: Math.round(median * 10) / 10,
      sampleSize: deltasHours.length,
    };
  } catch (err) {
    console.error('[store] getFixTimeStats failed:', err);
    return { averageFixHours: null, medianFixHours: null, sampleSize: 0 };
  }
}

/** Totale tellingen voor de dashboard-header. */
export async function getStats(): Promise<{
  totalReports: number;
  totalHosts: number;
}> {
  const redis = getRedis();
  if (!redis) return { totalReports: 0, totalHosts: 0 };
  try {
    const p = redis.pipeline();
    p.zcard('bb:reports');
    p.zcard('bb:hosts');
    const [totalReports, totalHosts] = (await p.exec()) as [number, number];
    return {
      totalReports: Number(totalReports ?? 0),
      totalHosts: Number(totalHosts ?? 0),
    };
  } catch (err) {
    console.error('[store] getStats failed:', err);
    return { totalReports: 0, totalHosts: 0 };
  }
}
