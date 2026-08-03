/**
 * top-radio.ru scraping core.
 *
 * Shared by the local server (top-radio-app.ts). Everything here is plain
 * Node with no dependencies.
 *
 * Page structure this relies on (verified 2026-08-03):
 *   - Country page (/armeniya, /rossiya): station cards as
 *     <a href="web/<slug>" title="<name>"><img data-src="assets/image/radio/100/<file>"><p><name></p></a>
 *     plus a <ul class="threecolumn"> block listing the country's cities.
 *   - Station page (/web/<slug>): `var STREAMS = '[{"bitrate":"128","url":"..."}]'`,
 *     <meta property="og:image"> for the 180px logo, <h1> for the name, and a
 *     "Частота вещания по городам" block with <a href="<city>/<slug>">City 90.7 FM</a>.
 *   - City station lists are rendered by JS, so per-city stations come from sitemap.xml.
 *   - Some stream URLs are wrapped in the site proxy: https://vobook.ru/<real-url>
 *
 * robots.txt is respected: no URL with a query string is requested, traffic is
 * throttled, and the User-Agent identifies the tool.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

export const BASE_URL = 'https://top-radio.ru';
export const PROXY_PREFIX = 'https://vobook.ru/';
export const USER_AGENT = 'top-radio-m3u/2.0 (personal playlist tool)';

/** Only these two countries are offered by the UI. */
export const COUNTRIES = [
  { slug: 'armeniya', name: 'Армения' },
  { slug: 'rossiya', name: 'Россия' },
] as const;

const HTML_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SITEMAP_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// ============================================================================
// TYPES
// ============================================================================

export type Stream = {
  /** Advertised bitrate in kbps (0 when the site states none) */
  bitrate: number;
  /** Playable URL (proxy prefix unwrapped) */
  url: string;
  /** URL exactly as published on the page */
  rawUrl: string;
  /** true/false after a probe, undefined when not probed */
  reachable?: boolean;
  /** HLS streams need a different player path than plain mp3/aac */
  hls: boolean;
};

export type Station = {
  /** Station slug, unique site-wide (from /web/<slug>) */
  slug: string;
  name: string;
  pageUrl: string;
  /** Logo URLs, best quality first — the 180px variant occasionally 404s */
  logoCandidates: string[];
  /** File name inside the logos directory once downloaded */
  logoFile?: string;
  streams: Stream[];
  /** FM frequency labels, the requested country's cities first */
  frequencies: Array<{ citySlug: string; label: string }>;
};

export type City = { slug: string; name: string; count: number | null };

export type FetchContext = {
  cacheDir: string | null;
  delayMs: number;
  concurrency: number;
};

// ============================================================================
// HTTP with cache, throttling and retries
// ============================================================================

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** robots.txt on top-radio.ru has "Disallow: *?" — never request a query URL. */
function assertCrawlable(url: string): void {
  const parsed = new URL(url);
  if (parsed.hostname.endsWith('top-radio.ru') && parsed.search) {
    throw new Error(`Refusing a robots.txt-disallowed URL (Disallow: *?): ${url}`);
  }
}

function cachePath(cacheDir: string, url: string, extension: string): string {
  return join(cacheDir, `${createHash('sha1').update(url).digest('hex')}${extension}`);
}

async function readCache(cacheDir: string | null, url: string, ext: string, ttlMs: number): Promise<string | null> {
  if (!cacheDir) return null;
  try {
    const file = cachePath(cacheDir, url, ext);
    const [content, info] = await Promise.all([readFile(file, 'utf8'), stat(file)]);
    return Date.now() - info.mtimeMs > ttlMs ? null : content;
  } catch {
    return null;
  }
}

async function writeCache(cacheDir: string | null, url: string, ext: string, body: string): Promise<void> {
  if (!cacheDir) return;
  try {
    await mkdir(cacheDir, { recursive: true });
    await writeFile(cachePath(cacheDir, url, ext), body, 'utf8');
  } catch {
    // A broken cache must never fail the run
  }
}

export async function fetchText(
  url: string,
  ctx: FetchContext,
  { ttlMs = HTML_CACHE_TTL_MS, ext = '.html', attempt = 1 } = {},
): Promise<string> {
  assertCrawlable(url);

  const cached = await readCache(ctx.cacheDir, url, ext, ttlMs);
  if (cached !== null) return cached;

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml',
        'Accept-Language': 'ru,en;q=0.8',
        Referer: `${BASE_URL}/`,
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.text();
    await writeCache(ctx.cacheDir, url, ext, body);
    return body;
  } catch (error) {
    if (attempt >= 3) throw new Error(`Failed to fetch ${url}: ${(error as Error).message}`);
    await sleep(500 * 2 ** (attempt - 1));
    return fetchText(url, ctx, { ttlMs, ext, attempt: attempt + 1 });
  }
}

/** Run tasks with a fixed worker count and a per-worker delay between requests. */
export async function pool<T>(
  items: T[],
  workers: number,
  delayMs: number,
  task: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0;

  const run = async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await task(items[index], index);
      if (delayMs > 0) await sleep(delayMs);
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, Math.min(workers, items.length)) }, run));
}

// ============================================================================
// HTML HELPERS
// ============================================================================

const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  laquo: '«',
  raquo: '»',
  ndash: '–',
  mdash: '—',
};

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (match, name) => HTML_ENTITIES[name.toLowerCase()] ?? match);
}

export function clean(text: string): string {
  return decodeEntities(text.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function absolute(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('//')) return `https:${url}`;
  return `${BASE_URL}/${url.replace(/^\/+/, '')}`;
}

function stripQuery(url: string): string {
  const index = url.indexOf('?');
  return index === -1 ? url : url.slice(0, index);
}

// ============================================================================
// PARSERS
// ============================================================================

/** Station cards on a country page (also works for any listing page). */
export function parseStationCards(html: string): Array<{ path: string; name: string; logoUrl: string | null }> {
  const cards = new Map<string, { path: string; name: string; logoUrl: string | null }>();
  const cardRe = /<a\s+href="((?:web|[a-z0-9-]+)\/[a-z0-9-]+)"\s+title="([^"]*)"\s*>([\s\S]*?)<\/a>/gi;

  for (const match of html.matchAll(cardRe)) {
    const [, path, title, inner] = match;
    if (/^(genres|playlist|faq|stranyi)\//i.test(path)) continue;

    const logo = /data-src="([^"]*assets\/image\/radio\/[^"]+)"/i.exec(inner);
    const name = clean(/<p[^>]*>([\s\S]*?)<\/p>/i.exec(inner)?.[1] ?? '') || clean(title);
    if (!name) continue;

    if (!cards.has(path)) {
      cards.set(path, { path, name, logoUrl: logo ? absolute(stripQuery(logo[1])) : null });
    }
  }

  return [...cards.values()];
}

/** The country's own cities, from the `<ul class="threecolumn">` block. */
export function parseCountryCities(html: string): City[] {
  const block = /<ul class="threecolumn">([\s\S]*?)<\/ul>/i.exec(html);
  if (!block) return [];

  const cities: City[] = [];
  const itemRe = /<a\s+href="([a-z0-9-]+)"[^>]*>([^<]*)<\/a>\s*(?:<span[^>]*>\((\d+)\)<\/span>)?/gi;

  for (const match of block[1].matchAll(itemRe)) {
    cities.push({ slug: match[1], name: clean(match[2]), count: match[3] ? Number(match[3]) : null });
  }
  return cities;
}

function unwrapStreamUrl(url: string): string {
  if (!url.startsWith(PROXY_PREFIX)) return url;
  const inner = url.slice(PROXY_PREFIX.length);
  if (/^https?:\/\//i.test(inner)) return inner;
  // The site also proxies scheme-less targets (host:port/path) — plain HTTP streams
  if (/^[\w.-]+(?::\d+)?\//.test(inner)) return `http://${inner}`;
  return url;
}

export function parseStationPage(html: string, path: string, fallbackName: string, countryCities: Set<string>) {
  const slug = path.split('/').pop() ?? path;

  const streamsMatch = /var\s+STREAMS\s*=\s*'(\[[\s\S]*?\])'\s*;/.exec(html);
  const streams: Stream[] = [];

  if (streamsMatch) {
    try {
      for (const entry of JSON.parse(streamsMatch[1]) as Array<{ bitrate?: string; url?: string }>) {
        // Some entries end in a bare "?" — players choke on it
        const rawUrl = (entry.url ?? '').trim().replace(/\?$/, '');
        if (!rawUrl) continue;
        const url = unwrapStreamUrl(rawUrl);
        if (!/^https?:\/\//i.test(url)) continue;
        streams.push({
          bitrate: Number(entry.bitrate) || 0,
          url,
          rawUrl,
          hls: /\.m3u8(\?|$)/i.test(url),
        });
      }
    } catch {
      // Malformed JSON on the page — treat the station as stream-less
    }
  }

  if (streams.length === 0) return null;

  const name =
    clean(/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] ?? '') ||
    clean(/<meta property="og:title" content="([^"]*)"/i.exec(html)?.[1] ?? '') ||
    fallbackName;

  const logoCandidates = [
    /<meta property="og:image" content="([^"]+)"/i.exec(html)?.[1],
    /<img[^>]+itemprop="image"[^>]+src="([^"]+)"/i.exec(html)?.[1],
  ]
    .filter((value): value is string => Boolean(value))
    .map((value) => absolute(stripQuery(value)));

  const frequencies: Station['frequencies'] = [];
  const freqBlock = /Частота вещания[^<]*<\/h2>\s*<ul[^>]*>([\s\S]*?)<\/ul>/i.exec(html);
  if (freqBlock) {
    for (const item of freqBlock[1].matchAll(/<a\s+href="([a-z0-9-]+)\/[a-z0-9-]+"[^>]*>([\s\S]*?)<\/a>/gi)) {
      frequencies.push({ citySlug: item[1], label: clean(item[2]) });
    }
  }
  // Frequencies of the requested country first (network stations list dozens of cities)
  if (countryCities.size > 0) {
    frequencies.sort((a, b) => Number(countryCities.has(b.citySlug)) - Number(countryCities.has(a.citySlug)));
  }

  const station: Station = {
    slug,
    name,
    pageUrl: absolute(path),
    logoCandidates,
    streams,
    frequencies,
  };
  return station;
}

/**
 * Station page paths for one city, taken from sitemap.xml — city pages
 * render their station list with JS, so the HTML has no links to scrape.
 */
export async function fetchCityStationPaths(citySlug: string, ctx: FetchContext): Promise<string[]> {
  const sitemap = await fetchText(`${BASE_URL}/sitemap.xml`, ctx, { ttlMs: SITEMAP_CACHE_TTL_MS, ext: '.xml' });
  const paths: string[] = [];

  for (const match of sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    const path = match[1].replace(`${BASE_URL}/`, '').replace(/\/+$/, '');
    const parts = path.split('/');
    if (parts.length === 2 && parts[0] === citySlug) paths.push(path);
  }
  return paths;
}

// ============================================================================
// SCRAPE
// ============================================================================

export type ScrapeProgress =
  | { kind: 'status'; message: string }
  | { kind: 'station'; index: number; total: number; station: Station }
  | { kind: 'skip'; index: number; total: number; name: string; reason: string };

/**
 * Scrape one country (its top stations) or one city of that country.
 *
 * Country mode uses the country page cards (Armenia: 18, Russia: top 100).
 * City mode resolves the station list from sitemap.xml.
 */
export async function scrape(
  options: { country: string; city?: string | null },
  ctx: FetchContext,
  onProgress: (event: ScrapeProgress) => void,
): Promise<{ title: string; cities: City[]; stations: Station[] }> {
  const countryUrl = `${BASE_URL}/${options.country}`;
  onProgress({ kind: 'status', message: `Загружаю страницу страны: ${countryUrl}` });

  const countryHtml = await fetchText(countryUrl, ctx);
  const title = clean(/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(countryHtml)?.[1] ?? '') || options.country;
  const cities = parseCountryCities(countryHtml);
  const countryCitySlugs = new Set(cities.map((city) => city.slug));

  let targets: Array<{ path: string; name: string; logoUrl: string | null }>;

  if (options.city) {
    onProgress({ kind: 'status', message: `Беру список станций города «${options.city}» из sitemap.xml` });
    const paths = await fetchCityStationPaths(options.city, ctx);
    targets = paths.map((path) => ({ path, name: path.split('/').pop() ?? path, logoUrl: null }));
  } else {
    targets = parseStationCards(countryHtml);
  }

  onProgress({ kind: 'status', message: `Найдено станций: ${targets.length}. Читаю страницы…` });

  const stations: Station[] = [];
  await pool(targets, ctx.concurrency, ctx.delayMs, async (target, index) => {
    try {
      const html = await fetchText(absolute(target.path), ctx);
      const station = parseStationPage(html, target.path, target.name, countryCitySlugs);

      if (!station) {
        onProgress({ kind: 'skip', index, total: targets.length, name: target.name, reason: 'нет потока' });
        return;
      }
      // The card image (100px) is a fallback: the 180px variant sometimes 404s
      if (target.logoUrl && !station.logoCandidates.includes(target.logoUrl)) {
        station.logoCandidates.push(target.logoUrl);
      }
      stations.push(station);
      onProgress({ kind: 'station', index, total: targets.length, station });
    } catch (error) {
      onProgress({
        kind: 'skip',
        index,
        total: targets.length,
        name: target.name,
        reason: (error as Error).message,
      });
    }
  });

  stations.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  return { title, cities, stations };
}

// ============================================================================
// STREAM PROBE
// ============================================================================

/**
 * Probe a stream by reading its first bytes. Icecast/Shoutcast servers usually
 * reject HEAD, so a ranged GET is used and aborted right away.
 */
export async function probeStream(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Range: 'bytes=0-2047', 'Icy-MetaData': '1' },
      signal: AbortSignal.timeout(8000),
      redirect: 'follow',
    });
    if (!response.ok && response.status !== 206) {
      await response.body?.cancel();
      return false;
    }
    const reader = response.body?.getReader();
    if (!reader) return true;
    const { value } = await reader.read();
    await reader.cancel();
    return (value?.byteLength ?? 0) > 0;
  } catch {
    return false;
  }
}

// ============================================================================
// LOGOS (downloaded once, reused from disk afterwards)
// ============================================================================

export type LogoResult = {
  slug: string;
  file: string | null;
  status: 'downloaded' | 'cached' | 'failed';
  error?: string;
};

/**
 * Download logos into `dir`, skipping any file already on disk, so repeated
 * runs never re-download. Returns the file name per station.
 */
export async function downloadLogos(
  stations: Array<{ slug: string; logoCandidates: string[] }>,
  dir: string,
  ctx: FetchContext,
  onProgress?: (result: LogoResult) => void,
): Promise<LogoResult[]> {
  await mkdir(dir, { recursive: true });
  const results: LogoResult[] = [];

  await pool(stations, ctx.concurrency, ctx.delayMs, async (station) => {
    // Already on disk? Keep it — logos are fetched exactly once.
    for (const extension of ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg']) {
      const file = `${station.slug}${extension}`;
      try {
        await stat(join(dir, file));
        const result: LogoResult = { slug: station.slug, file, status: 'cached' };
        results.push(result);
        onProgress?.(result);
        return;
      } catch {
        // Not this extension — keep looking
      }
    }

    const errors: string[] = [];
    for (const candidate of station.logoCandidates) {
      const extension = extname(new URL(candidate).pathname) || '.png';
      const file = `${station.slug}${extension}`;
      try {
        const response = await fetch(candidate, {
          headers: { 'User-Agent': USER_AGENT, Referer: `${BASE_URL}/` },
          signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        await writeFile(join(dir, file), Buffer.from(await response.arrayBuffer()));
        const result: LogoResult = { slug: station.slug, file, status: 'downloaded' };
        results.push(result);
        onProgress?.(result);
        return;
      } catch (error) {
        errors.push(`${candidate} → ${(error as Error).message}`);
      }
    }

    const result: LogoResult = {
      slug: station.slug,
      file: null,
      status: 'failed',
      error: errors.join('; ') || 'нет ссылки на логотип',
    };
    results.push(result);
    onProgress?.(result);
  });

  return results;
}
