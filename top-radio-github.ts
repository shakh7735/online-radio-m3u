/**
 * GitHub hosting for station logos.
 *
 * Logos are pushed once into a public repository via the Contents API and the
 * playlist references them by their stable raw URL. Unlike Google Drive links,
 * raw.githubusercontent.com / jsDelivr URLs are plain files with no redirects,
 * consent screens or per-file ids — which is what players can actually load.
 *
 * A file that already exists in the repo is left alone, so repeated runs never
 * re-upload. The known file shas are cached in `github-map.json`.
 *
 * Token: a personal access token in `github-token.txt` next to the app.
 *   - classic: scope `public_repo` (or `repo` for private)
 *   - fine-grained: repository permission "Contents: read and write"
 */
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const API = 'https://api.github.com';
const API_HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'top-radio-m3u',
};

export type LinkStyle = 'raw' | 'jsdelivr';

export type GithubSettings = {
  owner: string | null;
  repo: string | null;
  branch: string;
  /** Directory inside the repository, '' for the root */
  dir: string;
  linkStyle: LinkStyle;
  /** Login of the account the token belongs to */
  account: string | null;
};

export type GithubMap = {
  /** `owner/repo@branch:dir` the shas below belong to */
  target: string | null;
  /** file name → blob sha */
  files: Record<string, string>;
};

export type RepoInfo = {
  fullName: string;
  private: boolean;
  defaultBranch: string;
  canPush: boolean;
  htmlUrl: string;
};

export type UploadResult = {
  slug: string;
  file: string;
  url: string;
  status: 'uploaded' | 'existing' | 'failed';
  error?: string;
};

const DEFAULT_SETTINGS: GithubSettings = {
  owner: null,
  repo: null,
  branch: 'main',
  dir: 'logos',
  linkStyle: 'raw',
  account: null,
};

// ============================================================================
// SETTINGS / CACHE
// ============================================================================

export async function readSettings(workDir: string): Promise<GithubSettings> {
  try {
    const raw = JSON.parse(await readFile(join(workDir, 'github-settings.json'), 'utf8')) as Partial<GithubSettings>;
    return { ...DEFAULT_SETTINGS, ...raw };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function writeSettings(workDir: string, patch: Partial<GithubSettings>): Promise<GithubSettings> {
  const merged = { ...(await readSettings(workDir)), ...patch };
  await writeFile(join(workDir, 'github-settings.json'), `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  return merged;
}

async function readMap(workDir: string): Promise<GithubMap> {
  try {
    return JSON.parse(await readFile(join(workDir, 'github-map.json'), 'utf8')) as GithubMap;
  } catch {
    return { target: null, files: {} };
  }
}

async function writeMap(workDir: string, map: GithubMap): Promise<void> {
  await writeFile(join(workDir, 'github-map.json'), `${JSON.stringify(map, null, 2)}\n`, 'utf8');
}

export async function readToken(workDir: string): Promise<string | null> {
  try {
    const token = (await readFile(join(workDir, 'github-token.txt'), 'utf8')).trim();
    return token || null;
  } catch {
    return null;
  }
}

export async function writeToken(workDir: string, token: string): Promise<void> {
  await writeFile(join(workDir, 'github-token.txt'), token.trim(), 'utf8');
}

// ============================================================================
// LINKS
// ============================================================================

export function rawUrl(settings: GithubSettings, file: string): string {
  const { owner, repo, branch, dir, linkStyle } = settings;
  const path = [dir, file].filter(Boolean).join('/');

  return linkStyle === 'jsdelivr'
    ? `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${branch}/${path}`
    : `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
}

// ============================================================================
// API
// ============================================================================

async function api(
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<{ ok: true; data: unknown; scopes?: string } | { ok: false; status: number; error: string }> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { ...API_HEADERS, Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(60_000),
  });

  const text = await response.text();
  if (!response.ok) {
    const message = (() => {
      try {
        return (JSON.parse(text) as { message?: string }).message ?? text.slice(0, 200);
      } catch {
        return text.slice(0, 200);
      }
    })();
    return { ok: false, status: response.status, error: explain(response.status, message) };
  }

  try {
    return {
      ok: true,
      data: text ? JSON.parse(text) : {},
      scopes: response.headers.get('x-oauth-scopes') ?? undefined,
    };
  } catch {
    return { ok: false, status: response.status, error: 'Не удалось разобрать ответ GitHub API' };
  }
}

function explain(status: number, message: string): string {
  if (status === 401) return 'Токен недействителен или истёк (GitHub: 401). Создай новый personal access token.';
  if (status === 403 && /rate limit/i.test(message)) return 'Превышен лимит запросов GitHub — попробуй через несколько минут.';
  if (status === 403) return `Нет прав (403): ${message}. Нужен scope public_repo (classic) или Contents: read and write (fine-grained).`;
  if (status === 404) return 'Не найдено (404): проверь owner/repo и что токен видит этот репозиторий.';
  if (status === 409) return 'Конфликт (409): ветка пустая или изменилась — проверь имя ветки.';
  if (status === 422) return `GitHub отклонил запрос (422): ${message}`;
  return `GitHub API ${status}: ${message}`;
}

export async function whoAmI(token: string): Promise<{ login: string; scopes?: string } | { error: string }> {
  const result = await api('/user', token);
  if (!result.ok) return { error: result.error };
  return { login: (result.data as { login: string }).login, scopes: result.scopes };
}

export async function getRepo(owner: string, repo: string, token: string): Promise<RepoInfo | { error: string }> {
  const result = await api(`/repos/${owner}/${repo}`, token);
  if (!result.ok) return { error: result.error };

  const data = result.data as {
    full_name: string;
    private: boolean;
    default_branch: string;
    permissions?: { push?: boolean };
    html_url: string;
  };

  return {
    fullName: data.full_name,
    private: data.private,
    defaultBranch: data.default_branch,
    canPush: Boolean(data.permissions?.push),
    htmlUrl: data.html_url,
  };
}

/** Create a public repository under the token's account. */
export async function createRepo(name: string, token: string): Promise<RepoInfo | { error: string }> {
  const result = await api('/user/repos', token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      description: 'Radio station logos for M3U playlists',
      private: false,
      auto_init: true,
    }),
  });
  if (!result.ok) return { error: result.error };

  const data = result.data as { full_name: string; private: boolean; default_branch: string; html_url: string };
  return {
    fullName: data.full_name,
    private: data.private,
    defaultBranch: data.default_branch,
    canPush: true,
    htmlUrl: data.html_url,
  };
}

/** File names already committed in the target directory → their blob shas. */
export async function listDir(
  settings: GithubSettings,
  token: string,
): Promise<Record<string, string> | { error: string }> {
  const path = settings.dir ? `/${encodeURIComponent(settings.dir).replace(/%2F/g, '/')}` : '';
  const result = await api(
    `/repos/${settings.owner}/${settings.repo}/contents${path}?ref=${encodeURIComponent(settings.branch)}`,
    token,
  );

  // A missing directory is normal on the first run
  if (!result.ok) return result.status === 404 ? {} : { error: result.error };

  const entries = result.data as Array<{ name: string; sha: string; type: string }> | { name?: string };
  if (!Array.isArray(entries)) return {};

  const files: Record<string, string> = {};
  for (const entry of entries) {
    if (entry.type === 'file') files[entry.name] = entry.sha;
  }
  return files;
}

async function putFile(
  settings: GithubSettings,
  file: string,
  content: Buffer,
  token: string,
): Promise<{ sha: string } | { error: string }> {
  const path = [settings.dir, file].filter(Boolean).join('/');
  const result = await api(`/repos/${settings.owner}/${settings.repo}/contents/${path}`, token, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: `Add radio logo ${file}`,
      content: content.toString('base64'),
      branch: settings.branch,
    }),
  });
  if (!result.ok) return { error: result.error };

  const data = result.data as { content?: { sha?: string } };
  return { sha: data.content?.sha ?? '' };
}

/**
 * Upload one file to any path in the repository, overwriting when it already
 * exists (needs the current blob sha). Used to publish the app's own sources.
 */
export async function putRepoFile(
  settings: GithubSettings,
  repoPath: string,
  content: Buffer,
  token: string,
  message: string,
): Promise<{ sha: string } | { error: string }> {
  const existing = await api(
    `/repos/${settings.owner}/${settings.repo}/contents/${repoPath}?ref=${encodeURIComponent(settings.branch)}`,
    token,
  );
  const currentSha = existing.ok ? (existing.data as { sha?: string }).sha : undefined;

  const result = await api(`/repos/${settings.owner}/${settings.repo}/contents/${repoPath}`, token, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      content: content.toString('base64'),
      branch: settings.branch,
      ...(currentSha ? { sha: currentSha } : {}),
    }),
  });
  if (!result.ok) return { error: result.error };

  const data = result.data as { content?: { sha?: string } };
  return { sha: data.content?.sha ?? '' };
}

// ============================================================================
// SYNC
// ============================================================================

/**
 * Upload the given local logo files, skipping any file already present in the
 * repository (checked against the live directory listing and the local cache).
 */
export async function syncLogosToGithub(
  items: Array<{ slug: string; file: string }>,
  options: { logosDir: string; workDir: string; settings: GithubSettings; token: string },
  onProgress?: (result: UploadResult) => void,
): Promise<UploadResult[]> {
  const { settings, token } = options;
  const target = `${settings.owner}/${settings.repo}@${settings.branch}:${settings.dir}`;

  const map = await readMap(options.workDir);
  if (map.target !== target) {
    map.target = target;
    map.files = {};
  }

  const remote = await listDir(settings, token);
  if ('error' in remote) throw new Error(remote.error);

  const results: UploadResult[] = [];

  for (const item of items) {
    const known = remote[item.file] ?? map.files[item.file];
    if (known) {
      map.files[item.file] = known;
      const result: UploadResult = {
        slug: item.slug,
        file: item.file,
        url: rawUrl(settings, item.file),
        status: 'existing',
      };
      results.push(result);
      onProgress?.(result);
      continue;
    }

    const localPath = join(options.logosDir, item.file);
    try {
      await stat(localPath);
    } catch {
      const result: UploadResult = {
        slug: item.slug,
        file: item.file,
        url: '',
        status: 'failed',
        error: 'локального файла нет — сначала скачай логотипы',
      };
      results.push(result);
      onProgress?.(result);
      continue;
    }

    const uploaded = await putFile(settings, item.file, await readFile(localPath), token);
    if ('error' in uploaded) {
      const result: UploadResult = { slug: item.slug, file: item.file, url: '', status: 'failed', error: uploaded.error };
      results.push(result);
      onProgress?.(result);
      continue;
    }

    map.files[item.file] = uploaded.sha;
    const result: UploadResult = {
      slug: item.slug,
      file: item.file,
      url: rawUrl(settings, item.file),
      status: 'uploaded',
    };
    results.push(result);
    onProgress?.(result);
  }

  await writeMap(options.workDir, map);
  return results;
}
