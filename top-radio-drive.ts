/**
 * Google Drive upload for station logos.
 *
 * Logos are uploaded once into a Drive folder, made readable by link, and the
 * resulting file IDs are cached in `drive-map.json` next to the app, so a
 * second run re-uses the existing Drive files instead of uploading again.
 *
 * Access token sources, in order:
 *   1. `drive-token.txt` next to the app (a raw OAuth access token — handy for
 *      a one-off run, e.g. from the OAuth Playground; expires in ~1h).
 *   2. `gcloud auth application-default print-access-token`.
 *
 * The token needs a Drive scope. gcloud's default ADC login has none, so:
 *   gcloud auth application-default login \
 *     --scopes=openid,email,https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/drive
 *
 * `drive` (full) is required to upload into a folder that was created by hand
 * in the Drive UI. With `drive.file` the app can only see files it created
 * itself — in that case let the app create its own folder.
 */
import { execFile, spawn } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Scopes requested at login: Drive access plus what ADC needs for a quota project. */
export const DRIVE_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/drive',
].join(',');

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

export type TokenInfo = {
  source: 'file' | 'gcloud' | 'none';
  token: string | null;
  email?: string;
  scopes: string[];
  hasDriveScope: boolean;
  error?: string;
};

export type DriveFolder = { id: string; name: string; url: string };

export type DriveMap = {
  folderId: string | null;
  /** logo file name → Drive file id */
  files: Record<string, string>;
};

export type SyncResult = {
  slug: string;
  file: string;
  driveId: string;
  link: string;
  status: 'uploaded' | 'existing' | 'failed';
  error?: string;
};

/** Link style used inside the playlist. */
export type LinkStyle = 'lh3' | 'uc';

// ============================================================================
// TOKEN
// ============================================================================

export function driveDirectLink(fileId: string, style: LinkStyle = 'lh3'): string {
  return style === 'uc'
    ? `https://drive.google.com/uc?export=view&id=${fileId}`
    : `https://lh3.googleusercontent.com/d/${fileId}`;
}

async function readTokenFile(workDir: string): Promise<string | null> {
  try {
    const raw = await readFile(join(workDir, 'drive-token.txt'), 'utf8');
    const token = raw.trim();
    return token || null;
  } catch {
    return null;
  }
}

async function gcloudToken(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('gcloud', ['auth', 'application-default', 'print-access-token'], {
      timeout: 20_000,
    });
    const token = stdout.trim();
    return token || null;
  } catch {
    return null;
  }
}

/** Resolve a token and check what it is allowed to do. */
export async function getTokenInfo(workDir: string): Promise<TokenInfo> {
  const fromFile = await readTokenFile(workDir);
  const token = fromFile ?? (await gcloudToken());
  const source: TokenInfo['source'] = fromFile ? 'file' : token ? 'gcloud' : 'none';

  if (!token) {
    return {
      source: 'none',
      token: null,
      scopes: [],
      hasDriveScope: false,
      error: 'Токен не найден: положи access token в drive-token.txt или выполни gcloud auth application-default login',
    };
  }

  try {
    const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      return { source, token, scopes: [], hasDriveScope: false, error: `Токен недействителен (HTTP ${response.status})` };
    }
    const info = (await response.json()) as { scope?: string; email?: string };
    const scopes = (info.scope ?? '').split(/\s+/).filter(Boolean);

    return {
      source,
      token,
      email: info.email,
      scopes,
      hasDriveScope: scopes.some((scope) => scope.startsWith('https://www.googleapis.com/auth/drive')),
    };
  } catch (error) {
    return { source, token, scopes: [], hasDriveScope: false, error: (error as Error).message };
  }
}

// ============================================================================
// API HELPERS
// ============================================================================

/** Turn an API error body into a message that says what to do next. */
function explainDriveError(status: number, body: string): string {
  if (/accessNotConfigured|has not been used in project|is disabled/i.test(body)) {
    const project = /project (\d+)/i.exec(body)?.[1];
    return (
      'Drive API не включён в проекте квоты ADC. Включи его: ' +
      `gcloud services enable drive.googleapis.com${project ? ` --project ${project}` : ''}`
    );
  }
  if (status === 403 && /insufficient|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(body)) {
    return (
      'У токена нет Drive-скоупа. Выполни: gcloud auth application-default login ' +
      '--scopes=openid,email,https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/drive'
    );
  }
  if (status === 404) {
    return 'Папка не найдена или недоступна этому аккаунту (проверь, тем ли аккаунтом авторизован и расшарена ли папка).';
  }
  return `Drive API HTTP ${status}: ${body.slice(0, 300)}`;
}

async function driveFetch(
  url: string,
  token: string,
  init: RequestInit = {},
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  const response = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(60_000),
  });

  const text = await response.text();
  if (!response.ok) return { ok: false, error: explainDriveError(response.status, text) };

  try {
    return { ok: true, data: text ? JSON.parse(text) : {} };
  } catch {
    return { ok: false, error: 'Не удалось разобрать ответ Drive API' };
  }
}

/** Extract a Drive id from any of the link shapes Google hands out. */
export function parseDriveId(input: string): string | null {
  const value = input.trim();
  if (!value) return null;

  const patterns = [
    /\/folders\/([A-Za-z0-9_-]{10,})/,
    /\/file\/d\/([A-Za-z0-9_-]{10,})/,
    /\/d\/([A-Za-z0-9_-]{10,})/,
    /[?&]id=([A-Za-z0-9_-]{10,})/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(value);
    if (match) return match[1];
  }
  return /^[A-Za-z0-9_-]{10,}$/.test(value) ? value : null;
}

export type ResolveResult =
  | { kind: 'folder'; folder: DriveFolder }
  | { kind: 'file'; id: string; name: string; parents: string[] }
  | { kind: 'error'; error: string };

/**
 * Look up what a link points at. A `/file/d/<id>` link is a file, not a
 * folder — the caller can offer to use the file's parent folder instead.
 */
export async function resolveTarget(idOrUrl: string, token: string): Promise<ResolveResult> {
  const id = parseDriveId(idOrUrl);
  if (!id) return { kind: 'error', error: 'Не смог распознать ID в ссылке' };

  const result = await driveFetch(
    `${DRIVE_API}/files/${id}?fields=id,name,mimeType,parents&supportsAllDrives=true`,
    token,
  );
  if (!result.ok) return { kind: 'error', error: result.error };

  const file = result.data as { id: string; name: string; mimeType: string; parents?: string[] };
  if (file.mimeType === FOLDER_MIME) {
    return { kind: 'folder', folder: { id: file.id, name: file.name, url: folderUrl(file.id) } };
  }
  return { kind: 'file', id: file.id, name: file.name, parents: file.parents ?? [] };
}

export function folderUrl(folderId: string): string {
  return `https://drive.google.com/drive/folders/${folderId}`;
}

export async function getFolder(folderId: string, token: string): Promise<DriveFolder | { error: string }> {
  const result = await driveFetch(`${DRIVE_API}/files/${folderId}?fields=id,name,mimeType&supportsAllDrives=true`, token);
  if (!result.ok) return { error: result.error };

  const file = result.data as { id: string; name: string; mimeType: string };
  if (file.mimeType !== FOLDER_MIME) return { error: `«${file.name}» — это файл, а не папка` };
  return { id: file.id, name: file.name, url: folderUrl(file.id) };
}

/** Find a folder by name inside `parentId`, creating it when missing. */
export async function ensureFolder(
  name: string,
  parentId: string | null,
  token: string,
): Promise<DriveFolder | { error: string }> {
  const query = [
    `name = '${name.replace(/'/g, "\\'")}'`,
    `mimeType = '${FOLDER_MIME}'`,
    'trashed = false',
    parentId ? `'${parentId}' in parents` : null,
  ]
    .filter(Boolean)
    .join(' and ');

  const found = await driveFetch(
    `${DRIVE_API}/files?q=${encodeURIComponent(query)}&fields=files(id,name)&pageSize=1&supportsAllDrives=true`,
    token,
  );
  if (!found.ok) return { error: found.error };

  const existing = (found.data as { files?: Array<{ id: string; name: string }> }).files?.[0];
  if (existing) return { id: existing.id, name: existing.name, url: folderUrl(existing.id) };

  const created = await driveFetch(`${DRIVE_API}/files?fields=id,name&supportsAllDrives=true`, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, ...(parentId ? { parents: [parentId] } : {}) }),
  });
  if (!created.ok) return { error: created.error };

  const folder = created.data as { id: string; name: string };
  return { id: folder.id, name: folder.name, url: folderUrl(folder.id) };
}

/** File names already present in the folder → their ids. */
export async function listFolder(folderId: string, token: string): Promise<Record<string, string> | { error: string }> {
  const files: Record<string, string> = {};
  let pageToken: string | undefined;

  do {
    const query = `'${folderId}' in parents and trashed = false`;
    const url =
      `${DRIVE_API}/files?q=${encodeURIComponent(query)}` +
      `&fields=nextPageToken,files(id,name)&pageSize=1000&supportsAllDrives=true` +
      (pageToken ? `&pageToken=${pageToken}` : '');

    const result = await driveFetch(url, token);
    if (!result.ok) return { error: result.error };

    const page = result.data as { files?: Array<{ id: string; name: string }>; nextPageToken?: string };
    for (const file of page.files ?? []) files[file.name] = file.id;
    pageToken = page.nextPageToken;
  } while (pageToken);

  return files;
}

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
};

/** Multipart upload of one local file into the folder. */
async function uploadFile(
  localPath: string,
  folderId: string,
  token: string,
): Promise<{ id: string } | { error: string }> {
  const name = basename(localPath);
  const extension = name.slice(name.lastIndexOf('.')).toLowerCase();
  const contentType = IMAGE_MIME[extension] ?? 'application/octet-stream';
  const content = await readFile(localPath);

  const boundary = `top-radio-${Math.random().toString(36).slice(2)}`;
  const metadata = JSON.stringify({ name, parents: [folderId] });
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
        `--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`,
    ),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  const result = await driveFetch(`${DRIVE_UPLOAD}?uploadType=multipart&fields=id&supportsAllDrives=true`, token, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!result.ok) return { error: result.error };
  return { id: (result.data as { id: string }).id };
}

/** Make a file readable by anyone with the link (playlists need that). */
async function shareByLink(fileId: string, token: string): Promise<string | null> {
  const result = await driveFetch(`${DRIVE_API}/files/${fileId}/permissions?supportsAllDrives=true`, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'reader', type: 'anyone' }),
  });
  return result.ok ? null : result.error;
}

// ============================================================================
// MAP CACHE
// ============================================================================

export async function readDriveMap(workDir: string): Promise<DriveMap> {
  try {
    return JSON.parse(await readFile(join(workDir, 'drive-map.json'), 'utf8')) as DriveMap;
  } catch {
    return { folderId: null, files: {} };
  }
}

export async function writeDriveMap(workDir: string, map: DriveMap): Promise<void> {
  await writeFile(join(workDir, 'drive-map.json'), `${JSON.stringify(map, null, 2)}\n`, 'utf8');
}

// ============================================================================
// SETTINGS (remembered between runs)
// ============================================================================

export type DriveSettings = {
  /** Last folder used, so the page comes back pre-filled */
  folderId: string | null;
  folderName: string | null;
  /** Account that was logged in last time */
  account: string | null;
  linkStyle: LinkStyle;
};

const DEFAULT_SETTINGS: DriveSettings = { folderId: null, folderName: null, account: null, linkStyle: 'lh3' };

export async function readSettings(workDir: string): Promise<DriveSettings> {
  try {
    const raw = JSON.parse(await readFile(join(workDir, 'drive-settings.json'), 'utf8')) as Partial<DriveSettings>;
    return { ...DEFAULT_SETTINGS, ...raw };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function writeSettings(workDir: string, patch: Partial<DriveSettings>): Promise<DriveSettings> {
  const merged = { ...(await readSettings(workDir)), ...patch };
  await writeFile(join(workDir, 'drive-settings.json'), `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  return merged;
}

// ============================================================================
// LOGIN / API ENABLEMENT (driven from the page, executed via gcloud)
// ============================================================================

/** Quota project ADC will bill Drive API calls to. */
export async function getQuotaProject(): Promise<string | null> {
  try {
    const raw = await readFile(join(process.env.HOME ?? '', '.config/gcloud/application_default_credentials.json'), 'utf8');
    const adc = JSON.parse(raw) as { quota_project_id?: string };
    if (adc.quota_project_id) return adc.quota_project_id;
  } catch {
    // No ADC file yet
  }
  try {
    const { stdout } = await execFileAsync('gcloud', ['config', 'get-value', 'project'], { timeout: 15_000 });
    const project = stdout.trim();
    return project && project !== '(unset)' ? project : null;
  } catch {
    return null;
  }
}

export async function isGcloudAvailable(): Promise<boolean> {
  try {
    await execFileAsync('gcloud', ['--version'], { timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run a gcloud command, streaming its output line by line.
 *
 * `gcloud auth application-default login` opens the browser itself and prints
 * a URL as a fallback — the page shows both so the user can always continue.
 */
export function runGcloud(
  args: string[],
  onLine: (line: string) => void,
  timeoutMs = 5 * 60_000,
): Promise<{ code: number | null }> {
  return new Promise((resolvePromise) => {
    const child = spawn('gcloud', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);

    const forward = (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (line.trim()) onLine(line.trim());
      }
    };

    child.stdout.on('data', forward);
    child.stderr.on('data', forward);
    child.on('error', (error) => {
      onLine(`Не удалось запустить gcloud: ${error.message}`);
      clearTimeout(timer);
      resolvePromise({ code: null });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code });
    });
  });
}

/** Probe whether Drive API answers for this token/quota project. */
export async function checkDriveApi(token: string): Promise<{ ok: boolean; error?: string }> {
  const result = await driveFetch(`${DRIVE_API}/about?fields=user(emailAddress)`, token);
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

// ============================================================================
// SYNC
// ============================================================================

/**
 * Upload the given local logo files into the Drive folder, skipping anything
 * already there (by file name, or by the cached id map). Returns one entry per
 * requested logo with its shareable direct link.
 */
export async function syncLogosToDrive(
  items: Array<{ slug: string; file: string }>,
  options: { logosDir: string; workDir: string; folderId: string; token: string; linkStyle: LinkStyle },
  onProgress?: (result: SyncResult) => void,
): Promise<SyncResult[]> {
  const map = await readDriveMap(options.workDir);
  if (map.folderId !== options.folderId) {
    // Folder changed — the cached ids belong elsewhere
    map.folderId = options.folderId;
    map.files = {};
  }

  const remote = await listFolder(options.folderId, options.token);
  if ('error' in remote) throw new Error(remote.error);

  const results: SyncResult[] = [];

  for (const item of items) {
    const localPath = join(options.logosDir, item.file);
    const knownId = remote[item.file] ?? map.files[item.file];

    if (knownId) {
      map.files[item.file] = knownId;
      const result: SyncResult = {
        slug: item.slug,
        file: item.file,
        driveId: knownId,
        link: driveDirectLink(knownId, options.linkStyle),
        status: 'existing',
      };
      results.push(result);
      onProgress?.(result);
      continue;
    }

    try {
      await stat(localPath);
    } catch {
      const result: SyncResult = {
        slug: item.slug,
        file: item.file,
        driveId: '',
        link: '',
        status: 'failed',
        error: 'локального файла нет — сначала скачай логотипы',
      };
      results.push(result);
      onProgress?.(result);
      continue;
    }

    const uploaded = await uploadFile(localPath, options.folderId, options.token);
    if ('error' in uploaded) {
      const result: SyncResult = {
        slug: item.slug,
        file: item.file,
        driveId: '',
        link: '',
        status: 'failed',
        error: uploaded.error,
      };
      results.push(result);
      onProgress?.(result);
      continue;
    }

    const shareError = await shareByLink(uploaded.id, options.token);
    map.files[item.file] = uploaded.id;

    const result: SyncResult = {
      slug: item.slug,
      file: item.file,
      driveId: uploaded.id,
      link: driveDirectLink(uploaded.id, options.linkStyle),
      status: 'uploaded',
      ...(shareError ? { error: `загружено, но не удалось расшарить: ${shareError}` } : {}),
    };
    results.push(result);
    onProgress?.(result);
  }

  await writeDriveMap(options.workDir, map);
  return results;
}
