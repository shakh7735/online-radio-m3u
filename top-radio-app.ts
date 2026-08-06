/**
 * top-radio.ru → M3U: local web app.
 *
 * Serves index.html and the few endpoints the page needs. A local server is
 * required because top-radio.ru sends no CORS headers, so the browser cannot
 * fetch its pages directly.
 *
 * Run:
 *   node --experimental-strip-types top-radio-app.ts
 *   open http://localhost:8787
 *
 * Endpoints:
 *   GET  /api/countries                 → the two supported countries
 *   GET  /api/cities?country=…          → cities of that country (from its page)
 *   POST /api/scrape                    → NDJSON progress stream + final result
 *   POST /api/probe                     → reachability per stream URL
 *   POST /api/logos                     → download missing logos into ./logos
 *   GET  /api/logos/list                → what is already on disk
 *   POST /api/save                      → write a playlist next to the app
 *   POST /api/vendor/hls                → fetch hls.js once into ./vendor (opt-in)
 *   GET  /api/drive/status              → token/scope state and the saved folder
 *   POST /api/drive/folder              → resolve a Drive link into a usable folder
 *   POST /api/drive/sync                → upload missing logos, return direct links
 *   POST /api/drive/login               → NDJSON: runs gcloud ADC login with Drive scopes
 *   POST /api/drive/enable-api          → NDJSON: enables drive.googleapis.com for the quota project
 *   POST /api/drive/logout              → revokes the stored ADC credentials
 *   POST /api/drive/token               → stores a pasted OAuth access token (bypasses gcloud)
 *   GET/POST /api/drive/settings        → remembered folder / account / link style
 *   GET  /api/github/status             → token owner, repo state, remembered settings
 *   POST /api/github/token              → store/clear the GitHub personal access token
 *   POST /api/github/repo               → check (or create) the target repository
 *   POST /api/github/sync               → push missing logos, return raw URLs
 *   POST /api/github/push-project       → publish the app's own files to the repo
 *   POST /api/publish/playlist          → write a playlist into playlists/ and git push it
 *   POST /api/github/publish-playlist   → same via the Contents API (when there is no SSH)
 *   POST /api/playlist/fetch            → download a playlist by URL (server-side, avoids CORS)
 *   GET  /api/stream?url=&referer=      → relay a station, injecting Referer (Range-aware)
 *   GET  /logos/<file>, /vendor/<file>  → local static files
 *
 * Ports/paths are CLI-overridable: --port 8787 --dir <workdir>
 */
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, extname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import {
  createRepo,
  getRepo,
  putRepoFile,
  type GithubSettings,
  type LinkStyle as GithubLinkStyle,
  readSettings as readGithubSettings,
  readToken as readGithubToken,
  syncLogosToGithub,
  whoAmI,
  writeSettings as writeGithubSettings,
  writeToken as writeGithubToken,
} from './top-radio-github.ts';
import {
  checkDriveApi,
  DRIVE_SCOPES,
  driveDirectLink,
  ensureFolder,
  getFolder,
  getQuotaProject,
  getTokenInfo,
  isGcloudAvailable,
  type LinkStyle,
  readDriveMap,
  readSettings,
  resolveTarget,
  runGcloud,
  syncLogosToDrive,
  writeSettings,
} from './top-radio-drive.ts';
import {
  BASE_URL,
  COUNTRIES,
  clean,
  downloadLogos,
  type FetchContext,
  fetchText,
  parseCountryCities,
  pool,
  probeStream,
  scrape,
  USER_AGENT,
} from './top-radio-core.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const readArg = (name: string, fallback: string) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : (args[index + 1] ?? fallback);
};

const PORT = Number(readArg('--port', '8787'));
/** Everything the app writes (logos, playlists, cache) lives here. */
const WORK_DIR = resolve(readArg('--dir', HERE));
const LOGOS_DIR = join(WORK_DIR, 'logos');
const VENDOR_DIR = join(WORK_DIR, 'vendor');
const CACHE_DIR = join(WORK_DIR, '.cache');

/** hls.js is only fetched when the user opts in from the page. */
const HLS_JS_URL = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js';

const CTX: FetchContext = { cacheDir: CACHE_DIR, delayMs: 250, concurrency: 4 };

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.m3u': 'audio/x-mpegurl',
};

// ============================================================================
// HTTP helpers
// ============================================================================

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

function sendText(res: ServerResponse, status: number, body: string, type = 'text/plain; charset=utf-8'): void {
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
}

async function readBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? (JSON.parse(raw) as T) : ({} as T);
}

/** Serve a file from a whitelisted directory, refusing path traversal. */
async function sendFile(res: ServerResponse, dir: string, name: string): Promise<void> {
  const target = resolve(join(dir, name));
  if (!target.startsWith(resolve(dir))) {
    sendText(res, 403, 'Forbidden');
    return;
  }
  try {
    const info = await stat(target);
    if (!info.isFile()) throw new Error('not a file');
    res.writeHead(200, {
      'Content-Type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'no-cache',
    });
    createReadStream(target).pipe(res);
  } catch {
    sendText(res, 404, 'Not found');
  }
}

/** Run a command in `cwd`, collecting its output lines. Resolves with the exit code. */
function runCommand(
  command: string,
  args: string[],
  cwd: string,
  onLine: (line: string) => void,
  timeoutMs = 120_000,
): Promise<number | null> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);

    const forward = (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (line.trim()) onLine(line.trim());
      }
    };
    child.stdout.on('data', forward);
    child.stderr.on('data', forward);
    child.on('error', (error) => {
      onLine(`${command}: ${error.message}`);
      clearTimeout(timer);
      resolvePromise(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise(code);
    });
  });
}

// ============================================================================
// Endpoints
// ============================================================================

async function handleCities(res: ServerResponse, country: string): Promise<void> {
  const html = await fetchText(`${BASE_URL}/${country}`, CTX);
  const title = clean(/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] ?? '') || country;
  sendJson(res, 200, { title, cities: parseCountryCities(html) });
}

/** Streams NDJSON: one progress object per line, `{kind:'done'}` last. */
async function handleScrape(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { country, city } = await readBody<{ country: string; city?: string | null }>(req);

  if (!COUNTRIES.some((entry) => entry.slug === country)) {
    sendJson(res, 400, { error: `Unsupported country: ${country}` });
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache' });
  const write = (event: unknown) => res.write(`${JSON.stringify(event)}\n`);

  try {
    const result = await scrape({ country, city: city ?? null }, CTX, write);
    write({ kind: 'done', ...result });
  } catch (error) {
    write({ kind: 'error', message: (error as Error).message });
  }
  res.end();
}

async function handleProbe(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // `referers` — url → Referer, only for the CDNs that require one (#EXTVLCOPT:http-referrer=)
  const { urls, referers } = await readBody<{ urls: string[]; referers?: Record<string, string> }>(req);
  const results: Record<string, boolean> = {};

  await pool(urls ?? [], 6, 0, async (url) => {
    results[url] = await probeStream(url, referers?.[url]);
  });

  sendJson(res, 200, { results });
}

async function handleLogos(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { stations } = await readBody<{ stations: Array<{ slug: string; logoCandidates: string[] }> }>(req);
  const results = await downloadLogos(stations ?? [], LOGOS_DIR, CTX);

  sendJson(res, 200, {
    dir: LOGOS_DIR,
    downloaded: results.filter((r) => r.status === 'downloaded').length,
    cached: results.filter((r) => r.status === 'cached').length,
    failed: results.filter((r) => r.status === 'failed'),
    files: Object.fromEntries(results.filter((r) => r.file).map((r) => [r.slug, r.file])),
  });
}

async function handleLogoList(res: ServerResponse): Promise<void> {
  try {
    const files = await readdir(LOGOS_DIR);
    sendJson(res, 200, { dir: LOGOS_DIR, files });
  } catch {
    sendJson(res, 200, { dir: LOGOS_DIR, files: [] });
  }
}

async function handleSave(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { filename, content } = await readBody<{ filename: string; content: string }>(req);
  const safeName = (filename ?? 'playlist.m3u').replace(/[^\w.-]+/g, '_');

  await writeFile(join(WORK_DIR, safeName), content ?? '', 'utf8');
  sendJson(res, 200, { path: join(WORK_DIR, safeName) });
}

/** Opt-in, one-time download of hls.js so Chrome/Firefox can play .m3u8. */
async function handleVendorHls(res: ServerResponse): Promise<void> {
  const target = join(VENDOR_DIR, 'hls.min.js');
  try {
    await stat(target);
    sendJson(res, 200, { path: target, status: 'cached' });
    return;
  } catch {
    // Not downloaded yet
  }

  try {
    const response = await fetch(HLS_JS_URL, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    await mkdir(VENDOR_DIR, { recursive: true });
    await writeFile(target, Buffer.from(await response.arrayBuffer()));
    sendJson(res, 200, { path: target, status: 'downloaded' });
  } catch (error) {
    sendJson(res, 500, { error: (error as Error).message });
  }
}

async function handleDriveStatus(res: ServerResponse): Promise<void> {
  const [info, map, settings, gcloud] = await Promise.all([
    getTokenInfo(WORK_DIR),
    readDriveMap(WORK_DIR),
    readSettings(WORK_DIR),
    isGcloudAvailable(),
  ]);

  let folder = null;
  let apiError: string | null = null;

  if (info.token && info.hasDriveScope) {
    const api = await checkDriveApi(info.token);
    if (!api.ok) apiError = api.error ?? null;

    const folderId = map.folderId ?? settings.folderId;
    if (!apiError && folderId) {
      const resolved = await getFolder(folderId, info.token);
      folder = 'error' in resolved ? null : resolved;
    }
  }

  sendJson(res, 200, {
    gcloudAvailable: gcloud,
    tokenSource: info.source,
    email: info.email ?? null,
    hasDriveScope: info.hasDriveScope,
    signedIn: Boolean(info.token && info.hasDriveScope && !apiError),
    error: info.error ?? null,
    apiError,
    needsApiEnable: Boolean(apiError && /не включён/i.test(apiError)),
    quotaProject: await getQuotaProject(),
    folder,
    settings,
    uploaded: Object.keys(map.files).length,
    scopes: DRIVE_SCOPES,
  });
}

/** Streams the gcloud login so the page can show progress and the fallback URL. */
async function handleDriveLogin(res: ServerResponse): Promise<void> {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache' });
  const write = (event: unknown) => res.write(`${JSON.stringify(event)}\n`);

  if (!(await isGcloudAvailable())) {
    write({ kind: 'error', message: 'gcloud CLI не найден. Установи Google Cloud SDK или положи access token в drive-token.txt' });
    res.end();
    return;
  }

  write({ kind: 'status', message: 'Открываю окно входа Google в браузере…' });
  const { code } = await runGcloud(
    ['auth', 'application-default', 'login', `--scopes=${DRIVE_SCOPES}`, '--quiet'],
    (line) => write({ kind: 'line', message: line }),
  );

  if (code !== 0) {
    write({ kind: 'error', message: `gcloud завершился с кодом ${code}` });
    res.end();
    return;
  }

  const info = await getTokenInfo(WORK_DIR);
  if (info.email) await writeSettings(WORK_DIR, { account: info.email });

  write({ kind: 'done', email: info.email ?? null, hasDriveScope: info.hasDriveScope });
  res.end();
}

/** Drive API must be enabled for the ADC quota project before uploads work. */
async function handleDriveEnableApi(res: ServerResponse): Promise<void> {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache' });
  const write = (event: unknown) => res.write(`${JSON.stringify(event)}\n`);

  const project = await getQuotaProject();
  write({ kind: 'status', message: `Включаю Drive API${project ? ` в проекте ${project}` : ''}…` });

  const args = ['services', 'enable', 'drive.googleapis.com', '--quiet'];
  if (project) args.push(`--project=${project}`);

  const { code } = await runGcloud(args, (line) => write({ kind: 'line', message: line }));
  write(code === 0 ? { kind: 'done' } : { kind: 'error', message: `gcloud завершился с кодом ${code}` });
  res.end();
}

async function handleDriveLogout(res: ServerResponse): Promise<void> {
  const lines: string[] = [];
  const { code } = await runGcloud(['auth', 'application-default', 'revoke', '--quiet'], (line) => lines.push(line), 60_000);
  sendJson(res, 200, { ok: code === 0, output: lines.join('\n') });
}

/**
 * Store (or clear) a pasted OAuth access token.
 *
 * This is the escape hatch when Google refuses the gcloud login: the Drive
 * scope is "restricted", so the gcloud OAuth client — or a Workspace policy —
 * can block it. A token from the OAuth Playground works for ~1 hour, which is
 * plenty: file ids are cached in drive-map.json and reused forever after.
 */
async function handleDriveToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { token } = await readBody<{ token: string }>(req);
  const target = join(WORK_DIR, 'drive-token.txt');

  if (!token || !token.trim()) {
    await writeFile(target, '', 'utf8');
    return void sendJson(res, 200, { cleared: true });
  }

  await writeFile(target, token.trim(), 'utf8');
  const info = await getTokenInfo(WORK_DIR);
  if (info.email) await writeSettings(WORK_DIR, { account: info.email });

  sendJson(res, 200, {
    email: info.email ?? null,
    hasDriveScope: info.hasDriveScope,
    error: info.error ?? null,
  });
}

async function handleDriveSettings(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === 'GET') return void sendJson(res, 200, await readSettings(WORK_DIR));
  const patch = await readBody<Record<string, unknown>>(req);
  sendJson(res, 200, await writeSettings(WORK_DIR, patch));
}

/**
 * Resolve a pasted Drive link. `/file/d/<id>` links point at a file, not a
 * folder — then the caller can use that file's parent, or create a subfolder.
 */
async function handleDriveFolder(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { link, useParent, createName } = await readBody<{
    link: string;
    useParent?: boolean;
    createName?: string;
  }>(req);

  const info = await getTokenInfo(WORK_DIR);
  if (!info.token || !info.hasDriveScope) {
    return void sendJson(res, 400, { error: info.error ?? 'У токена нет Drive-скоупа' });
  }

  const resolved = await resolveTarget(link ?? '', info.token);
  if (resolved.kind === 'error') return void sendJson(res, 400, { error: resolved.error });

  let folderId: string | null = null;
  let note: string | null = null;

  if (resolved.kind === 'folder') {
    folderId = resolved.folder.id;
  } else if (useParent && resolved.parents.length > 0) {
    folderId = resolved.parents[0];
    note = `Ссылка вела на файл «${resolved.name}» — использую папку, в которой он лежит.`;
  } else {
    return void sendJson(res, 200, {
      needsChoice: true,
      file: { id: resolved.id, name: resolved.name, hasParent: resolved.parents.length > 0 },
      message:
        `Ссылка ведёт на файл «${resolved.name}», а не на папку. ` +
        'Можно использовать папку, в которой он лежит, либо создать новую папку для логотипов.',
    });
  }

  if (createName) {
    const created = await ensureFolder(createName, folderId, info.token);
    if ('error' in created) return void sendJson(res, 400, { error: created.error });
    folderId = created.id;
    note = `Использую папку «${created.name}».`;
  }

  const folder = await getFolder(folderId!, info.token);
  if ('error' in folder) return void sendJson(res, 400, { error: folder.error });

  const map = await readDriveMap(WORK_DIR);
  if (map.folderId !== folder.id) {
    await writeFile(join(WORK_DIR, 'drive-map.json'), `${JSON.stringify({ folderId: folder.id, files: {} }, null, 2)}\n`, 'utf8');
  }
  await writeSettings(WORK_DIR, { folderId: folder.id, folderName: folder.name, account: info.email ?? null });

  sendJson(res, 200, { folder, note });
}

/** Download any missing logo locally, then upload the missing ones to Drive. */
async function handleDriveSync(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { stations, linkStyle } = await readBody<{
    stations: Array<{ slug: string; logoCandidates: string[] }>;
    linkStyle?: LinkStyle;
  }>(req);

  const info = await getTokenInfo(WORK_DIR);
  if (!info.token || !info.hasDriveScope) {
    return void sendJson(res, 400, { error: info.error ?? 'У токена нет Drive-скоупа' });
  }

  const settings = await readSettings(WORK_DIR);
  const map = await readDriveMap(WORK_DIR);
  const folderId = map.folderId ?? settings.folderId;
  if (!folderId) return void sendJson(res, 400, { error: 'Папка Drive не выбрана' });

  // Local logos first — Drive uploads read them from disk
  const local = await downloadLogos(stations ?? [], LOGOS_DIR, CTX);
  const items = local
    .filter((entry) => entry.file)
    .map((entry) => ({ slug: entry.slug, file: entry.file as string }));

  try {
    const results = await syncLogosToDrive(items, {
      logosDir: LOGOS_DIR,
      workDir: WORK_DIR,
      folderId,
      token: info.token,
      linkStyle: linkStyle ?? settings.linkStyle ?? 'lh3',
    });
    if (linkStyle) await writeSettings(WORK_DIR, { linkStyle });

    sendJson(res, 200, {
      folderId,
      localDownloaded: local.filter((entry) => entry.status === 'downloaded').length,
      localCached: local.filter((entry) => entry.status === 'cached').length,
      localFailed: local.filter((entry) => entry.status === 'failed'),
      uploaded: results.filter((entry) => entry.status === 'uploaded').length,
      existing: results.filter((entry) => entry.status === 'existing').length,
      failed: results.filter((entry) => entry.status === 'failed'),
      links: Object.fromEntries(results.filter((entry) => entry.link).map((entry) => [entry.slug, entry.link])),
      files: Object.fromEntries(local.filter((entry) => entry.file).map((entry) => [entry.slug, entry.file])),
    });
  } catch (error) {
    sendJson(res, 500, { error: (error as Error).message });
  }
}

// ============================================================================
// GitHub logo hosting
// ============================================================================

async function handleGithubStatus(res: ServerResponse): Promise<void> {
  const [token, settings] = await Promise.all([readGithubToken(WORK_DIR), readGithubSettings(WORK_DIR)]);

  if (!token) {
    return void sendJson(res, 200, { hasToken: false, settings, account: null, repo: null });
  }

  const user = await whoAmI(token);
  if ('error' in user) {
    return void sendJson(res, 200, { hasToken: true, settings, account: null, repo: null, error: user.error });
  }

  let repo = null;
  let repoError: string | null = null;
  if (settings.owner && settings.repo) {
    const info = await getRepo(settings.owner, settings.repo, token);
    if ('error' in info) repoError = info.error;
    else repo = info;
  }

  sendJson(res, 200, {
    hasToken: true,
    account: user.login,
    scopes: user.scopes ?? null,
    settings: { ...settings, owner: settings.owner ?? user.login },
    repo,
    repoError,
  });
}

async function handleGithubToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { token } = await readBody<{ token: string }>(req);

  if (!token || !token.trim()) {
    await writeGithubToken(WORK_DIR, '');
    return void sendJson(res, 200, { cleared: true });
  }

  await writeGithubToken(WORK_DIR, token);
  const user = await whoAmI(token.trim());
  if ('error' in user) return void sendJson(res, 200, { error: user.error });

  const settings = await readGithubSettings(WORK_DIR);
  await writeGithubSettings(WORK_DIR, { account: user.login, owner: settings.owner ?? user.login });
  sendJson(res, 200, { account: user.login, scopes: user.scopes ?? null });
}

/** Check the target repository, optionally creating it first. */
async function handleGithubRepo(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody<{
    owner?: string;
    repo?: string;
    branch?: string;
    dir?: string;
    linkStyle?: GithubLinkStyle;
    create?: boolean;
  }>(req);

  const token = await readGithubToken(WORK_DIR);
  if (!token) return void sendJson(res, 400, { error: 'Сначала сохрани personal access token' });

  const user = await whoAmI(token);
  if ('error' in user) return void sendJson(res, 400, { error: user.error });

  const owner = (body.owner ?? '').trim() || user.login;
  const repoName = (body.repo ?? '').trim();
  if (!repoName) return void sendJson(res, 400, { error: 'Укажи имя репозитория' });

  let info = await getRepo(owner, repoName, token);

  if ('error' in info && body.create) {
    if (owner !== user.login) {
      return void sendJson(res, 400, { error: `Создать репозиторий можно только под аккаунтом ${user.login}` });
    }
    info = await createRepo(repoName, token);
  }
  if ('error' in info) return void sendJson(res, 400, { error: info.error, canCreate: owner === user.login });

  const settings = await writeGithubSettings(WORK_DIR, {
    owner,
    repo: repoName,
    branch: (body.branch ?? '').trim() || info.defaultBranch,
    dir: (body.dir ?? 'logos').trim().replace(/^\/+|\/+$/g, ''),
    ...(body.linkStyle ? { linkStyle: body.linkStyle } : {}),
    account: user.login,
  });

  sendJson(res, 200, {
    repo: info,
    settings,
    warning: info.private
      ? 'Репозиторий приватный — raw-ссылки не откроются в плеерах. Сделай его публичным.'
      : !info.canPush
        ? 'У токена нет прав на запись в этот репозиторий.'
        : null,
  });
}

/** Download any missing logo locally, then push the missing ones to GitHub. */
async function handleGithubSync(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { stations, linkStyle } = await readBody<{
    stations: Array<{ slug: string; logoCandidates: string[] }>;
    linkStyle?: GithubLinkStyle;
  }>(req);

  const token = await readGithubToken(WORK_DIR);
  if (!token) return void sendJson(res, 400, { error: 'Сначала сохрани personal access token' });

  let settings: GithubSettings = await readGithubSettings(WORK_DIR);
  if (linkStyle && linkStyle !== settings.linkStyle) settings = await writeGithubSettings(WORK_DIR, { linkStyle });
  if (!settings.owner || !settings.repo) return void sendJson(res, 400, { error: 'Репозиторий не выбран' });

  // Local logos first — the uploader reads them from disk
  const local = await downloadLogos(stations ?? [], LOGOS_DIR, CTX);
  const items = local.filter((entry) => entry.file).map((entry) => ({ slug: entry.slug, file: entry.file as string }));

  try {
    const results = await syncLogosToGithub(items, { logosDir: LOGOS_DIR, workDir: WORK_DIR, settings, token });

    sendJson(res, 200, {
      settings,
      localDownloaded: local.filter((entry) => entry.status === 'downloaded').length,
      localCached: local.filter((entry) => entry.status === 'cached').length,
      uploaded: results.filter((entry) => entry.status === 'uploaded').length,
      existing: results.filter((entry) => entry.status === 'existing').length,
      failed: results.filter((entry) => entry.status === 'failed'),
      links: Object.fromEntries(results.filter((entry) => entry.url).map((entry) => [entry.slug, entry.url])),
      files: Object.fromEntries(local.filter((entry) => entry.file).map((entry) => [entry.slug, entry.file])),
    });
  } catch (error) {
    sendJson(res, 500, { error: (error as Error).message });
  }
}

/** Files of the app itself that are worth publishing (secrets excluded). */
const PROJECT_FILES = [
  'index.html',
  'index.command',
  'package.json',
  'top-radio-app.ts',
  'top-radio-core.ts',
  'top-radio-drive.ts',
  'top-radio-github.ts',
  'README.md',
  '.gitignore',
];

/**
 * Publish the app's own sources into the repository through the Contents API,
 * one commit per file. Tokens and local state files are never included.
 */
async function handleGithubPushProject(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { includeLogos } = await readBody<{ includeLogos?: boolean }>(req);

  const token = await readGithubToken(WORK_DIR);
  if (!token) return void sendJson(res, 400, { error: 'Сначала сохрани personal access token' });

  const settings = await readGithubSettings(WORK_DIR);
  if (!settings.owner || !settings.repo) return void sendJson(res, 400, { error: 'Репозиторий не выбран' });

  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache' });
  const write = (event: unknown) => res.write(`${JSON.stringify(event)}\n`);

  // The app's sources go to the repository root; logos keep the configured dir
  const appSettings = { ...settings, dir: '' };
  let pushed = 0;
  let failed = 0;

  for (const name of PROJECT_FILES) {
    try {
      const content = await readFile(join(WORK_DIR, name));
      const result = await putRepoFile(appSettings, name, content, token, `Add ${name}`);
      if ('error' in result) {
        failed++;
        write({ kind: 'line', message: `✗ ${name}: ${result.error}` });
      } else {
        pushed++;
        write({ kind: 'line', message: `✓ ${name}` });
      }
    } catch {
      write({ kind: 'line', message: `— ${name}: файла нет, пропускаю` });
    }
  }

  if (includeLogos) {
    let logoFiles: string[] = [];
    try {
      logoFiles = await readdir(LOGOS_DIR);
    } catch {
      logoFiles = [];
    }

    for (const file of logoFiles.filter((name) => !name.startsWith('.'))) {
      const repoPath = [settings.dir, file].filter(Boolean).join('/');
      try {
        const content = await readFile(join(LOGOS_DIR, file));
        const result = await putRepoFile(settings, repoPath, content, token, `Add radio logo ${file}`);
        if ('error' in result) {
          failed++;
          write({ kind: 'line', message: `✗ ${repoPath}: ${result.error}` });
        } else {
          pushed++;
          write({ kind: 'line', message: `✓ ${repoPath}` });
        }
      } catch (error) {
        failed++;
        write({ kind: 'line', message: `✗ ${repoPath}: ${(error as Error).message}` });
      }
    }
  }

  write({
    kind: 'done',
    pushed,
    failed,
    repoUrl: `https://github.com/${settings.owner}/${settings.repo}`,
  });
  res.end();
}

/** Max playlist size accepted by /api/playlist/fetch. */
const MAX_PLAYLIST_BYTES = 2 * 1024 * 1024;

/**
 * Download a playlist by URL on the server side.
 *
 * Doing it here rather than in the page keeps it working for hosts that send no
 * CORS headers, and it is also the honest test of what a radio app will get:
 * a plain unauthenticated GET.
 */
async function handlePlaylistFetch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { url } = await readBody<{ url: string }>(req);

  let parsed: URL;
  try {
    parsed = new URL((url ?? '').trim());
  } catch {
    return void sendJson(res, 400, { error: 'Некорректный URL' });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return void sendJson(res, 400, { error: 'Поддерживаются только http и https' });
  }

  try {
    const response = await fetch(parsed, {
      headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
    });

    if (!response.ok) {
      return void sendJson(res, 200, {
        error:
          response.status === 404
            ? 'HTTP 404: файл недоступен по этой ссылке (для приватного репозитория raw-ссылки не работают)'
            : `HTTP ${response.status}`,
        status: response.status,
      });
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_PLAYLIST_BYTES) {
      return void sendJson(res, 200, { error: `Файл слишком большой (${buffer.byteLength} байт)` });
    }

    sendJson(res, 200, {
      content: buffer.toString('utf8'),
      status: response.status,
      contentType: response.headers.get('content-type'),
      size: buffer.byteLength,
      finalUrl: response.url,
    });
  } catch (error) {
    sendJson(res, 200, { error: (error as Error).message });
  }
}

/**
 * Streams a station through the server instead of straight from the browser.
 *
 * Some CDNs (stations aggregated through play.radioplayer.org, e.g.
 * de.auroramedia.am) reject requests with no Referer header — and a browser
 * can't be told to send an arbitrary cross-origin Referer, that header is
 * off-limits to page JS. The server has no such restriction, so it fetches
 * the stream with the Referer from the playlist's #EXTVLCOPT and relays the
 * bytes to the <audio> element, which never sees the real URL.
 */
async function handleStreamProxy(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const target = url.searchParams.get('url') ?? '';
  const referer = url.searchParams.get('referer') ?? undefined;

  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return void sendJson(res, 400, { error: 'Некорректный URL потока' });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return void sendJson(res, 400, { error: 'Поддерживаются только http и https' });
  }

  // Радиопоток живёт часами — таймаут должен ловить только зависшее подключение,
  // а не рвать эфир по истечении фиксированного времени
  const controller = new AbortController();
  const connectTimeout = setTimeout(() => controller.abort(), 15_000);
  req.on('close', () => controller.abort());

  try {
    const upstream = await fetch(parsed, {
      headers: {
        'User-Agent': USER_AGENT,
        // Без Icy-MetaData: 1 — иначе Icecast вклинивает в поток бинарные блоки метаданных,
        // которые мы не разбираем и не вырезаем, и <audio> получает испорченный MP3
        Range: req.headers.range ?? 'bytes=0-',
        ...(referer ? { Referer: referer } : {}),
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    clearTimeout(connectTimeout);

    if (!upstream.ok && upstream.status !== 206) {
      await upstream.body?.cancel();
      return void sendJson(res, upstream.status, { error: `Поток ответил HTTP ${upstream.status}` });
    }

    const headers: Record<string, string> = {};
    for (const key of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'icy-name', 'icy-br']) {
      const value = upstream.headers.get(key);
      if (value) headers[key] = value;
    }
    res.writeHead(upstream.status, headers);

    if (!upstream.body) return void res.end();
    const body = Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream);
    // Отключение клиента абортит upstream (см. выше) — это бьёт по тому же body,
    // и без листенера необработанный 'error' на Readable валит весь процесс
    body.on('error', () => body.destroy());
    res.on('error', () => body.destroy());
    body.pipe(res);
  } catch (error) {
    clearTimeout(connectTimeout);
    if (!res.headersSent) sendJson(res, 502, { error: (error as Error).message });
  }
}

/** Where published playlists live inside the repository. */
const PLAYLIST_DIR = 'playlists';

function sanitizeName(name: string, fallback: string): string {
  const clean = (name ?? '').trim().replace(/[^\w.\-]+/g, '_');
  return clean && clean !== '.m3u' ? (clean.endsWith('.m3u') ? clean : `${clean}.m3u`) : fallback;
}

/**
 * Publish a playlist by committing it with the local git remote.
 *
 * This is the token-free path: the repo was cloned/pushed over SSH, so the
 * existing key does the authentication. Returns the raw URL to paste into a
 * radio app.
 */
async function handlePublishPlaylist(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { filename, content } = await readBody<{ filename: string; content: string }>(req);
  const name = sanitizeName(filename, 'playlist.m3u');

  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache' });
  const write = (event: unknown) => res.write(`${JSON.stringify(event)}\n`);

  try {
    await mkdir(join(WORK_DIR, PLAYLIST_DIR), { recursive: true });
    await writeFile(join(WORK_DIR, PLAYLIST_DIR, name), content ?? '', 'utf8');
    write({ kind: 'line', message: `✓ записал ${PLAYLIST_DIR}/${name}` });

    const git = async (args: string[]) => {
      const lines: string[] = [];
      const code = await runCommand('git', args, WORK_DIR, (line) => lines.push(line));
      return { code, output: lines.join('\n') };
    };

    const remote = await git(['remote', 'get-url', 'origin']);
    if (remote.code !== 0) {
      write({ kind: 'error', message: 'В папке нет git-remote origin — добавь его или используй публикацию по токену' });
      res.end();
      return;
    }
    const remoteUrl = remote.output.trim();

    const add = await git(['add', '--', `${PLAYLIST_DIR}/${name}`]);
    if (add.code !== 0) {
      write({ kind: 'error', message: `git add: ${add.output}` });
      res.end();
      return;
    }

    const commit = await git(['commit', '-m', `Publish playlist ${name}`, '--', `${PLAYLIST_DIR}/${name}`]);
    if (commit.code !== 0 && !/nothing to commit|no changes added/i.test(commit.output)) {
      write({ kind: 'error', message: `git commit: ${commit.output}` });
      res.end();
      return;
    }
    write({ kind: 'line', message: commit.code === 0 ? '✓ commit' : '— без изменений, коммит не нужен' });

    const push = await git(['push', 'origin', 'HEAD']);
    if (push.code !== 0) {
      write({ kind: 'error', message: `git push: ${push.output}` });
      res.end();
      return;
    }
    write({ kind: 'line', message: '✓ push' });

    // Compose the raw URL from the remote (SSH or HTTPS shape)
    const match = /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/.exec(remoteUrl);
    const settings = await readGithubSettings(WORK_DIR);
    const owner = match?.[1] ?? settings.owner;
    const repo = match?.[2] ?? settings.repo;
    const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).output.trim() || settings.branch;

    write({
      kind: 'done',
      url: `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${PLAYLIST_DIR}/${name}`,
      jsdelivr: `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${branch}/${PLAYLIST_DIR}/${name}`,
      repoUrl: `https://github.com/${owner}/${repo}`,
    });
  } catch (error) {
    write({ kind: 'error', message: (error as Error).message });
  }
  res.end();
}

/** Same, but through the GitHub API — for machines without an SSH key. */
async function handleGithubPublishPlaylist(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { filename, content } = await readBody<{ filename: string; content: string }>(req);
  const name = sanitizeName(filename, 'playlist.m3u');

  const token = await readGithubToken(WORK_DIR);
  if (!token) return void sendJson(res, 400, { error: 'Нет токена: используй публикацию через git или сохрани токен' });

  const settings = await readGithubSettings(WORK_DIR);
  if (!settings.owner || !settings.repo) return void sendJson(res, 400, { error: 'Репозиторий не выбран' });

  const result = await putRepoFile(
    { ...settings, dir: '' },
    `${PLAYLIST_DIR}/${name}`,
    Buffer.from(content ?? '', 'utf8'),
    token,
    `Publish playlist ${name}`,
  );
  if ('error' in result) return void sendJson(res, 400, { error: result.error });

  sendJson(res, 200, {
    url: `https://raw.githubusercontent.com/${settings.owner}/${settings.repo}/${settings.branch}/${PLAYLIST_DIR}/${name}`,
    jsdelivr: `https://cdn.jsdelivr.net/gh/${settings.owner}/${settings.repo}@${settings.branch}/${PLAYLIST_DIR}/${name}`,
    repoUrl: `https://github.com/${settings.owner}/${settings.repo}`,
  });
}

async function handleStatus(res: ServerResponse): Promise<void> {
  let hlsReady = false;
  try {
    await stat(join(VENDOR_DIR, 'hls.min.js'));
    hlsReady = true;
  } catch {
    hlsReady = false;
  }

  let logoCount = 0;
  try {
    logoCount = (await readdir(LOGOS_DIR)).length;
  } catch {
    logoCount = 0;
  }

  sendJson(res, 200, { workDir: WORK_DIR, logosDir: LOGOS_DIR, logoCount, hlsReady, countries: COUNTRIES });
}

// ============================================================================
// Router
// ============================================================================

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const path = url.pathname;

  try {
    if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
      await sendFile(res, HERE, 'index.html');
      return;
    }
    if (req.method === 'GET' && path === '/api/status') return void (await handleStatus(res));
    if (req.method === 'GET' && path === '/api/countries') return void sendJson(res, 200, { countries: COUNTRIES });
    if (req.method === 'GET' && path === '/api/cities') {
      const country = url.searchParams.get('country') ?? '';
      if (!COUNTRIES.some((entry) => entry.slug === country)) {
        return void sendJson(res, 400, { error: `Unsupported country: ${country}` });
      }
      return void (await handleCities(res, country));
    }
    if (req.method === 'GET' && path === '/api/logos/list') return void (await handleLogoList(res));
    if (req.method === 'POST' && path === '/api/scrape') return void (await handleScrape(req, res));
    if (req.method === 'POST' && path === '/api/probe') return void (await handleProbe(req, res));
    if (req.method === 'POST' && path === '/api/logos') return void (await handleLogos(req, res));
    if (req.method === 'POST' && path === '/api/save') return void (await handleSave(req, res));
    if (req.method === 'POST' && path === '/api/vendor/hls') return void (await handleVendorHls(res));
    if (req.method === 'GET' && path === '/api/drive/status') return void (await handleDriveStatus(res));
    if (req.method === 'POST' && path === '/api/drive/folder') return void (await handleDriveFolder(req, res));
    if (req.method === 'POST' && path === '/api/drive/sync') return void (await handleDriveSync(req, res));
    if (req.method === 'POST' && path === '/api/drive/login') return void (await handleDriveLogin(res));
    if (req.method === 'POST' && path === '/api/drive/enable-api') return void (await handleDriveEnableApi(res));
    if (req.method === 'POST' && path === '/api/drive/logout') return void (await handleDriveLogout(res));
    if (req.method === 'POST' && path === '/api/drive/token') return void (await handleDriveToken(req, res));
    if (req.method === 'GET' && path === '/api/github/status') return void (await handleGithubStatus(res));
    if (req.method === 'POST' && path === '/api/github/token') return void (await handleGithubToken(req, res));
    if (req.method === 'POST' && path === '/api/github/repo') return void (await handleGithubRepo(req, res));
    if (req.method === 'POST' && path === '/api/github/sync') return void (await handleGithubSync(req, res));
    if (req.method === 'POST' && path === '/api/github/push-project') {
      return void (await handleGithubPushProject(req, res));
    }
    if (req.method === 'POST' && path === '/api/publish/playlist') return void (await handlePublishPlaylist(req, res));
    if (req.method === 'POST' && path === '/api/playlist/fetch') return void (await handlePlaylistFetch(req, res));
    if (req.method === 'GET' && path === '/api/stream') return void (await handleStreamProxy(req, res, url));
    if (req.method === 'POST' && path === '/api/github/publish-playlist') {
      return void (await handleGithubPublishPlaylist(req, res));
    }
    if ((req.method === 'GET' || req.method === 'POST') && path === '/api/drive/settings') {
      return void (await handleDriveSettings(req, res));
    }

    if (req.method === 'GET' && path.startsWith('/logos/')) {
      return void (await sendFile(res, LOGOS_DIR, decodeURIComponent(path.slice('/logos/'.length))));
    }
    if (req.method === 'GET' && path.startsWith('/vendor/')) {
      return void (await sendFile(res, VENDOR_DIR, decodeURIComponent(path.slice('/vendor/'.length))));
    }

    sendText(res, 404, 'Not found');
  } catch (error) {
    sendJson(res, 500, { error: (error as Error).message });
  }
});

// Referenced so the helper stays part of the server's public surface
void driveDirectLink;

server.listen(PORT, () => {
  console.log(`top-radio → M3U

  UI:        http://localhost:${PORT}
  Work dir:  ${WORK_DIR}
  Logos:     ${LOGOS_DIR}  (downloaded once, reused afterwards)

Press Ctrl+C to stop.`);
});
