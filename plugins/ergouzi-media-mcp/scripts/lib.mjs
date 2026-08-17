import { randomUUID } from 'node:crypto';
import { lookup as lookupHost } from 'node:dns/promises';
import { createWriteStream } from 'node:fs';
import {
  link,
  mkdir,
  open,
  readFile,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { URL } from 'node:url';

export const DEFAULT_BASE_URL = 'https://ergouzi.life';
export const MAX_JSON_BYTES = 4 * 1024 * 1024;
export const MAX_EXPANDED_INPUT_BYTES = 4 * 1024 * 1024;
export const MAX_LOCAL_MEDIA_BYTES = 3 * 1024 * 1024;
export const MAX_OUTPUT_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_WAIT_SECONDS = 120;
export const DOWNLOAD_TIMEOUT_MS = 120_000;

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const VIDEO_TYPES = new Set(['video/mp4']);
const AUDIO_TYPES = new Set([
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
  'audio/flac',
]);
const LOCAL_FILE_KEY = '$local_file';
const FORBIDDEN_INPUT_FIELDS = new Set(['hf_api_token']);
const MP4_BRANDS = new Set([
  'avc1',
  'cmfc',
  'cmfs',
  'dash',
  'f4v ',
  'iso2',
  'iso3',
  'iso4',
  'iso5',
  'iso6',
  'iso7',
  'iso8',
  'isom',
  'm4v ',
  'mp41',
  'mp42',
  'mmp4',
  'msdh',
]);
const MEDIA_MCP_VERSION =
  typeof __ERGOUZI_MEDIA_MCP_VERSION__ === 'string'
    ? __ERGOUZI_MEDIA_MCP_VERSION__
    : '0.2.0-dev';
const MODEL_SCHEMA_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_API_ERROR_DETAIL_CHARS = 4_096;
const MODEL_SCHEMA_CACHES = new WeakMap();
const TRANSIENT_SUBMISSION_STATUSES = new Set([
  408, 409, 425, 429, 500, 502, 503, 504,
]);
const OUTPUT_MEDIA_TYPES = new Set([
  'image/avif',
  'image/jpeg',
  'image/png',
  'image/webp',
  'video/mp4',
  'video/quicktime',
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
  'audio/flac',
]);

const MODEL_MEDIA_FIELDS = {
  'ergouzi/e-image': {},
  'ergouzi/e-image-edit': { images: { types: IMAGE_TYPES, multiple: true } },
  'ergouzi/e-image-ideogram': {},
  'ergouzi/e-image-try-on': {
    person_image: { types: IMAGE_TYPES },
    garment_images: { types: IMAGE_TYPES, multiple: true },
    reference_pose: { types: IMAGE_TYPES },
  },
  'ergouzi/e-image-upscale': { image: { types: IMAGE_TYPES } },
  'ergouzi/e-rmbg': { image: { types: IMAGE_TYPES } },
  'ergouzi/e-video': {
    image: { types: IMAGE_TYPES },
    last_frame_image: { types: IMAGE_TYPES },
    audio: { types: AUDIO_TYPES },
  },
  'ergouzi/e-video-animate': {
    video: { types: VIDEO_TYPES },
    image: { types: IMAGE_TYPES },
  },
  'ergouzi/e-video-avatar': {
    image: { types: IMAGE_TYPES },
    audio: { types: AUDIO_TYPES },
  },
  'ergouzi/e-video-replace': {
    video: { types: VIDEO_TYPES },
    images: { types: IMAGE_TYPES, multiple: true },
  },
};

export class MediaMcpError extends Error {
  constructor(message, { status, code = 'MEDIA_MCP_ERROR', cause } = {}) {
    super(message, { cause });
    this.name = 'MediaMcpError';
    this.status = status;
    this.code = code;
  }
}

export class ApiError extends MediaMcpError {
  constructor(message, status) {
    super(message, { status, code: 'ERGOUZI_API_ERROR' });
  }
}

export function configPath({
  env = process.env,
  platform = process.platform,
} = {}) {
  const override = String(env.ERGOUZI_CONFIG_FILE ?? '').trim();
  if (override)
    return path.resolve(override.replace(/^~(?=$|[\\/])/, env.HOME ?? ''));
  if (platform === 'win32') {
    return path.join(
      env.APPDATA || path.join(env.USERPROFILE || '', 'AppData', 'Roaming'),
      'ergouzi',
      'credentials.json',
    );
  }
  return path.join(
    env.XDG_CONFIG_HOME || path.join(env.HOME || '', '.config'),
    'ergouzi',
    'credentials.json',
  );
}

export function normalizeBaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value).trim());
  } catch (error) {
    throw new MediaMcpError('Ergouzi base URL must be an absolute URL', {
      code: 'INVALID_BASE_URL',
      cause: error,
    });
  }
  const local = isLocalHostname(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) {
    throw new MediaMcpError(
      'Ergouzi base URL must use HTTPS (HTTP is allowed only for localhost)',
      { code: 'INVALID_BASE_URL' },
    );
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !['', '/'].includes(parsed.pathname)
  ) {
    throw new MediaMcpError(
      'Ergouzi base URL must not contain credentials, a path, query, or fragment',
      { code: 'INVALID_BASE_URL' },
    );
  }
  return parsed.origin;
}

export async function loadCredentials({
  env = process.env,
  platform = process.platform,
} = {}) {
  const file = configPath({ env, platform });
  let saved = {};
  try {
    saved = JSON.parse(
      await readFile(file, 'utf8').then((value) =>
        value.replace(/^\uFEFF/, ''),
      ),
    );
  } catch (error) {
    if (error.code !== 'ENOENT')
      throw new MediaMcpError(
        `Unable to read Ergouzi credentials file: ${file}`,
        { code: 'INVALID_CREDENTIALS_FILE', cause: error },
      );
  }
  const mediaApiKey = String(env.ERGOUZI_MEDIA_API_KEY || '').trim();
  const savedApiKey = String(saved.api_key || '').trim();
  const genericApiKey = String(env.ERGOUZI_API_KEY || '').trim();
  const apiKey = mediaApiKey || savedApiKey || genericApiKey;
  if (!apiKey)
    throw new MediaMcpError('Ergouzi media API key is not configured', {
      code: 'MISSING_API_KEY',
    });
  const mediaBaseUrl = String(env.ERGOUZI_MEDIA_BASE_URL || '').trim();
  const savedBaseUrl = String(saved.base_url || '').trim();
  const genericBaseUrl = String(env.ERGOUZI_BASE_URL || '').trim();
  const baseUrl = normalizeBaseUrl(
    mediaBaseUrl || savedBaseUrl || genericBaseUrl || DEFAULT_BASE_URL,
  );
  return {
    baseUrl,
    apiKey,
    configFile: file,
    credentialSource: mediaApiKey
      ? 'ERGOUZI_MEDIA_API_KEY'
      : savedApiKey
        ? 'credentials_file'
        : 'ERGOUZI_API_KEY',
    baseUrlSource: mediaBaseUrl
      ? 'ERGOUZI_MEDIA_BASE_URL'
      : savedBaseUrl
        ? 'credentials_file'
        : genericBaseUrl
          ? 'ERGOUZI_BASE_URL'
          : 'default',
  };
}

export function redactSecrets(value, secrets = []) {
  let text = String(value);
  for (const secret of secrets) {
    if (secret) text = text.split(secret).join('[redacted]');
  }
  return text;
}

export function safeErrorMessage(error, credentials) {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecrets(message, [credentials?.apiKey]);
}

export function mcpToolResult(value, isError = false) {
  const result = {
    content: [
      {
        type: 'text',
        text:
          typeof value === 'string' ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
  if (isError) return { ...result, isError: true };
  if (value && typeof value === 'object' && !Array.isArray(value))
    return { ...result, structuredContent: value };
  return result;
}

export async function credentialDiagnostics(
  credentials,
  { platform = process.platform } = {},
) {
  const diagnostics = {
    base_url: credentials.baseUrl,
    base_url_source: credentials.baseUrlSource || 'unknown',
    credential_source: credentials.credentialSource || 'unknown',
    config_file: credentials.configFile || null,
    config_file_permissions: null,
    warnings: [],
  };
  if (!credentials.configFile || platform === 'win32') return diagnostics;

  try {
    const fileInfo = await stat(credentials.configFile);
    const mode = fileInfo.mode & 0o777;
    diagnostics.config_file_permissions = `0${mode.toString(8)}`;
    if (
      credentials.credentialSource === 'credentials_file' &&
      (mode & 0o077) !== 0
    ) {
      diagnostics.warnings.push(
        'Credential file is readable by group or other users; set permissions to 0600.',
      );
    }
  } catch (error) {
    if (error.code !== 'ENOENT')
      diagnostics.warnings.push(
        'Unable to inspect credential file permissions.',
      );
  }
  return diagnostics;
}

function apiUrl(credentials, requestPath) {
  if (!String(requestPath).startsWith('/'))
    throw new MediaMcpError('API path must start with /', {
      code: 'INVALID_API_PATH',
    });
  return new URL(requestPath, `${credentials.baseUrl}/`);
}

async function readResponseBytes(response, maxBytes) {
  if (!response.body) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes)
      throw new MediaMcpError(`Response exceeds the ${maxBytes} byte limit`, {
        code: 'RESPONSE_TOO_LARGE',
      });
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new MediaMcpError(`Response exceeds the ${maxBytes} byte limit`, {
          code: 'RESPONSE_TOO_LARGE',
        });
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function truncate(value, limit) {
  const text = String(value);
  return text.length <= limit ? text : `${text.slice(0, limit)}...`;
}

function apiErrorDetail(parsed, apiKey) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return '';
  const fields = ['error', 'detail', 'message', 'title', 'invalid_fields'];
  const detail = Object.fromEntries(
    fields
      .filter((field) => Object.hasOwn(parsed, field))
      .map((field) => [field, parsed[field]]),
  );
  if (Object.keys(detail).length === 0) return '';
  return truncate(
    redactSecrets(JSON.stringify(detail), [apiKey]),
    MAX_API_ERROR_DETAIL_CHARS,
  );
}

export async function apiJson(
  credentials,
  method,
  requestPath,
  payload,
  { headers = {}, timeoutMs = 120_000 } = {},
) {
  const body = payload === undefined ? undefined : JSON.stringify(payload);
  if (body && Buffer.byteLength(body, 'utf8') > MAX_JSON_BYTES)
    throw new MediaMcpError('JSON request exceeds the 4 MiB limit', {
      code: 'REQUEST_TOO_LARGE',
    });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await fetch(apiUrl(credentials, requestPath), {
        method,
        body,
        redirect: 'error',
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${credentials.apiKey}`,
          'user-agent': `ergouzi-media-mcp/${MEDIA_MCP_VERSION}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...headers,
        },
      });
    } catch (error) {
      if (error?.name === 'AbortError')
        throw new ApiError('Ergouzi API request timed out');
      throw new ApiError(
        `Ergouzi API request failed: ${redactSecrets(error?.message || error, [credentials.apiKey])}`,
      );
    }
    const raw = await readResponseBytes(response, MAX_JSON_BYTES);
    const text = raw.toString('utf8');
    let parsed = {};
    if (text.trim()) {
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        if (response.ok)
          throw new ApiError(
            'Ergouzi API returned invalid JSON',
            response.status,
          );
        throw new ApiError(
          `Ergouzi API returned HTTP ${response.status}`,
          response.status,
        );
      }
    }
    if (!response.ok) {
      const detail = apiErrorDetail(parsed, credentials.apiKey);
      const retryAfter =
        response.status === 429 ? response.headers.get('retry-after') : null;
      const retryHint = retryAfter
        ? `; retry after ${truncate(retryAfter, 120)}`
        : '';
      throw new ApiError(
        `Ergouzi API returned HTTP ${response.status}${detail ? `: ${detail}` : ''}${retryHint}`,
        response.status,
      );
    }
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

function assertObject(value, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new MediaMcpError(message, { code: 'INVALID_INPUT' });
}

function validateModel(model) {
  if (
    typeof model !== 'string' ||
    !/^[A-Za-z0-9_-]+\/[A-Za-z0-9._-]+$/.test(model)
  )
    throw new MediaMcpError('model must be an owner/model identifier', {
      code: 'INVALID_MODEL',
    });
  return model;
}

function validateTaskId(taskId) {
  if (typeof taskId !== 'string' || !/^task_[A-Za-z0-9_-]+$/.test(taskId))
    throw new MediaMcpError('task_id must be a task_ identifier', {
      code: 'INVALID_TASK_ID',
    });
  return taskId;
}

function validateMediaReference(value, allowedTypes) {
  if (typeof value !== 'string')
    throw new MediaMcpError(
      'Media input must be an HTTPS URL or supported data URI',
      { code: 'INVALID_MEDIA_INPUT' },
    );
  if (value.startsWith('https://')) return value;
  if (!value.startsWith('data:'))
    throw new MediaMcpError(
      'Media input must use HTTPS or a supported base64 data URI',
      { code: 'INVALID_MEDIA_INPUT' },
    );
  const [header] = value.split(',', 1);
  const mediaType = header.slice(5).split(';', 1)[0].toLowerCase();
  if (!header.toLowerCase().includes(';base64') || !allowedTypes.has(mediaType))
    throw new MediaMcpError('Media input uses an unsupported data URI type', {
      code: 'INVALID_MEDIA_INPUT',
    });
  return value;
}

function detectMediaType(data) {
  if (
    data.length >= 3 &&
    data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
  )
    return 'image/jpeg';
  if (
    data
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return 'image/png';
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString() === 'RIFF' &&
    data.subarray(8, 12).toString() === 'WEBP'
  )
    return 'image/webp';
  if (data.length >= 12 && data.subarray(4, 8).toString() === 'ftyp') {
    const brand = data.subarray(8, 12).toString().toLowerCase();
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
    if (brand === 'qt  ') return 'video/quicktime';
    if (MP4_BRANDS.has(brand)) return 'video/mp4';
  }
  if (data.subarray(0, 4).toString() === 'fLaC') return 'audio/flac';
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString() === 'RIFF' &&
    data.subarray(8, 12).toString() === 'WAVE'
  )
    return 'audio/wav';
  if (
    data.subarray(0, 3).toString() === 'ID3' ||
    (data[0] === 0xff && (data[1] & 0xe0) === 0xe0)
  )
    return 'audio/mpeg';
  return '';
}

async function detectMediaTypeFromFile(filePath) {
  const file = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(512);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return detectMediaType(buffer.subarray(0, bytesRead));
  } finally {
    await file.close();
  }
}

async function readLocalMedia(filePath) {
  const file = await open(filePath, 'r').catch((error) => {
    throw new MediaMcpError(`Local media file does not exist: ${filePath}`, {
      code: 'INVALID_MEDIA_FILE',
      cause: error,
    });
  });
  try {
    const fileInfo = await file.stat();
    if (!fileInfo.isFile())
      throw new MediaMcpError(`Local media path is not a file: ${filePath}`, {
        code: 'INVALID_MEDIA_FILE',
      });
    if (fileInfo.size === 0)
      throw new MediaMcpError(`Local media file is empty: ${filePath}`, {
        code: 'INVALID_MEDIA_FILE',
      });
    if (fileInfo.size > MAX_LOCAL_MEDIA_BYTES)
      throw new MediaMcpError(
        'Local media exceeds the 3 MiB inline request limit; use an HTTPS URL',
        { code: 'MEDIA_TOO_LARGE' },
      );
    const data = Buffer.alloc(fileInfo.size);
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await file.read(
        data,
        offset,
        data.length - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset === 0)
      throw new MediaMcpError(`Local media file is empty: ${filePath}`, {
        code: 'INVALID_MEDIA_FILE',
      });
    return data.subarray(0, offset);
  } finally {
    await file.close();
  }
}

async function prepareMediaValue(value, field) {
  if (field.multiple) {
    if (!Array.isArray(value))
      throw new MediaMcpError('Media field must be an array', {
        code: 'INVALID_MEDIA_INPUT',
      });
    return Promise.all(
      value.map((item) => prepareMediaValue(item, { types: field.types })),
    );
  }
  if (typeof value === 'string')
    return validateMediaReference(value, field.types);
  if (
    !value ||
    typeof value !== 'object' ||
    Object.keys(value).length !== 1 ||
    typeof value[LOCAL_FILE_KEY] !== 'string' ||
    !value[LOCAL_FILE_KEY].trim()
  )
    throw new MediaMcpError(
      `Media input must be an HTTPS URL, data URI, or ${LOCAL_FILE_KEY} object`,
      { code: 'INVALID_MEDIA_INPUT' },
    );
  const filePath = path.resolve(expandHomePath(value[LOCAL_FILE_KEY]));
  const mediaData = await readLocalMedia(filePath);
  const mediaType = detectMediaType(mediaData);
  if (!field.types.has(mediaType))
    throw new MediaMcpError(
      `Unsupported local media type: ${mediaType || path.extname(filePath)}`,
      { code: 'INVALID_MEDIA_TYPE' },
    );
  return { mediaData, mediaType };
}

function containsLocalPlaceholder(value) {
  if (Array.isArray(value)) return value.some(containsLocalPlaceholder);
  if (!value || typeof value !== 'object') return false;
  if (Object.hasOwn(value, LOCAL_FILE_KEY)) return true;
  return Object.values(value).some(containsLocalPlaceholder);
}

function forbiddenInputField(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const field = forbiddenInputField(item);
      if (field) return field;
    }
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  for (const [name, item] of Object.entries(value)) {
    if (FORBIDDEN_INPUT_FIELDS.has(name)) return name;
    const field = forbiddenInputField(item);
    if (field) return field;
  }
  return null;
}

async function encodePreparedMedia(value) {
  if (Array.isArray(value)) return Promise.all(value.map(encodePreparedMedia));
  if (
    value &&
    typeof value === 'object' &&
    Buffer.isBuffer(value.mediaData) &&
    typeof value.mediaType === 'string'
  ) {
    return `data:${value.mediaType};base64,${value.mediaData.toString('base64')}`;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      await Promise.all(
        Object.entries(value).map(async ([key, item]) => [
          key,
          await encodePreparedMedia(item),
        ]),
      ),
    );
  }
  return value;
}

export async function resolveMediaInputs(model, input) {
  assertObject(input, 'input must be a JSON object');
  const blockedField = forbiddenInputField(input);
  if (blockedField)
    throw new MediaMcpError(
      `${blockedField} is not accepted; use the configured Ergouzi API key`,
      { code: 'FORBIDDEN_INPUT_FIELD' },
    );
  const fields = MODEL_MEDIA_FIELDS[model] || {};
  const prepared = { ...input };
  for (const [name, field] of Object.entries(fields)) {
    if (Object.hasOwn(prepared, name))
      prepared[name] = await prepareMediaValue(prepared[name], field);
  }
  if (containsLocalPlaceholder(prepared))
    throw new MediaMcpError(
      `${LOCAL_FILE_KEY} is only allowed in documented media fields`,
      { code: 'INVALID_MEDIA_FIELD' },
    );
  const encoded = await encodePreparedMedia(prepared);
  if (
    Buffer.byteLength(JSON.stringify(encoded), 'utf8') >
    MAX_EXPANDED_INPUT_BYTES
  )
    throw new MediaMcpError(
      'Expanded input exceeds the 4 MiB request limit; use HTTPS URLs for media',
      { code: 'REQUEST_TOO_LARGE' },
    );
  return encoded;
}

function retryable(error) {
  return (
    error instanceof ApiError &&
    (error.status === undefined ||
      TRANSIENT_SUBMISSION_STATUSES.has(error.status))
  );
}

export async function createPrediction(
  credentials,
  model,
  input,
  idempotencyKey = randomUUID(),
) {
  validateModel(model);
  if (
    typeof idempotencyKey !== 'string' ||
    !idempotencyKey ||
    idempotencyKey.length > 128
  )
    throw new MediaMcpError('idempotency_key must be 1-128 characters', {
      code: 'INVALID_IDEMPOTENCY_KEY',
    });
  const encodedInput = await resolveMediaInputs(model, input);
  const [owner, name] = model.split('/');
  const requestPath = `/customer/v1/models/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/predictions`;
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await apiJson(
        credentials,
        'POST',
        requestPath,
        { input: encodedInput },
        { headers: { 'Idempotency-Key': idempotencyKey } },
      );
    } catch (error) {
      lastError = error;
      if (attempt === 1 || !retryable(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  throw lastError;
}

function modelSchemaCacheFor(credentials) {
  let cache = MODEL_SCHEMA_CACHES.get(credentials);
  if (!cache) {
    cache = new Map();
    MODEL_SCHEMA_CACHES.set(credentials, cache);
  }
  return cache;
}

function modelSchemaSummary(model, details) {
  const openapiSchema = details?.latest_version?.openapi_schema;
  const schemas = openapiSchema?.components?.schemas || {};
  const version = details?.latest_version || {};
  return {
    model,
    description:
      typeof details?.description === 'string' ? details.description : null,
    version: {
      id: typeof version.id === 'string' ? version.id : null,
      cog_version:
        typeof version.cog_version === 'string' ? version.cog_version : null,
      created_at:
        typeof version.created_at === 'string' ? version.created_at : null,
    },
    input_schema:
      schemas.Input && typeof schemas.Input === 'object' ? schemas.Input : null,
    output_schema:
      schemas.Output && typeof schemas.Output === 'object'
        ? schemas.Output
        : null,
    default_input:
      details?.default_example?.input &&
      typeof details.default_example.input === 'object'
        ? details.default_example.input
        : null,
  };
}

export async function getModelSchema(
  credentials,
  model,
  { refresh = false } = {},
) {
  validateModel(model);
  if (typeof refresh !== 'boolean')
    throw new MediaMcpError('refresh must be a boolean', {
      code: 'INVALID_REFRESH',
    });
  const cache = modelSchemaCacheFor(credentials);
  const cacheKey = `${credentials.baseUrl}\u0000${model}`;
  const cached = cache.get(cacheKey);
  if (!refresh && cached && cached.expiresAt > Date.now()) return cached.value;

  const [owner, name] = model.split('/');
  const details = await apiJson(
    credentials,
    'GET',
    `/customer/v1/models/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
  );
  const value = modelSchemaSummary(model, details);
  cache.set(cacheKey, {
    expiresAt: Date.now() + MODEL_SCHEMA_CACHE_TTL_MS,
    value,
  });
  return value;
}

function visibleModelCount(models) {
  if (Array.isArray(models)) return models.length;
  if (Array.isArray(models?.results)) return models.results.length;
  return 0;
}

export async function checkConfiguration(credentials) {
  const [diagnostics, models] = await Promise.all([
    credentialDiagnostics(credentials),
    apiJson(credentials, 'GET', '/customer/v1/models', undefined, {
      timeoutMs: 30_000,
    }),
  ]);
  return {
    ...diagnostics,
    api_access: 'verified',
    visible_model_count: visibleModelCount(models),
  };
}

function isTerminalStatus(status) {
  return new Set(['succeeded', 'failed', 'canceled', 'cancelled']).has(status);
}

export async function getPrediction(credentials, taskId, waitSeconds = 0) {
  validateTaskId(taskId);
  if (
    !Number.isInteger(waitSeconds) ||
    waitSeconds < 0 ||
    waitSeconds > MAX_WAIT_SECONDS
  )
    throw new MediaMcpError(
      `wait_seconds must be an integer from 0 to ${MAX_WAIT_SECONDS}`,
      { code: 'INVALID_WAIT_SECONDS' },
    );
  const requestPath = `/customer/v1/predictions/${encodeURIComponent(taskId)}`;
  const deadline = Date.now() + waitSeconds * 1000;
  let delay = 250;
  let lastPrediction;
  while (true) {
    const remaining = deadline - Date.now();
    if (waitSeconds > 0 && remaining <= 0 && lastPrediction)
      return lastPrediction;
    const prediction = await apiJson(
      credentials,
      'GET',
      requestPath,
      undefined,
      waitSeconds === 0 ? {} : { timeoutMs: Math.max(1, remaining) },
    );
    lastPrediction = prediction;
    if (
      waitSeconds === 0 ||
      isTerminalStatus(prediction?.status) ||
      Date.now() >= deadline
    )
      return prediction;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(delay, Math.max(0, deadline - Date.now()))),
    );
    delay = Math.min(Math.floor(delay * 1.5), 10_000);
  }
}

export async function cancelPrediction(credentials, taskId) {
  validateTaskId(taskId);
  return apiJson(
    credentials,
    'POST',
    `/customer/v1/predictions/${encodeURIComponent(taskId)}/cancel`,
  );
}

function isLocalHostname(hostname) {
  const lower = String(hostname)
    .replace(/^\[|\]$/g, '')
    .toLowerCase();
  return (
    lower === 'localhost' ||
    lower.endsWith('.localhost') ||
    lower === '::1' ||
    lower.startsWith('127.')
  );
}

function ipv4ToNumber(address) {
  const octets = String(address).split('.').map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  )
    return null;
  return (
    (((octets[0] << 24) >>> 0) |
      (octets[1] << 16) |
      (octets[2] << 8) |
      octets[3]) >>>
    0
  );
}

function isNonPublicIpv4(address) {
  const value = ipv4ToNumber(address);
  if (value === null) return false;
  const first = value >>> 24;
  const second = (value >>> 16) & 0xff;
  const third = (value >>> 8) & 0xff;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && third === 0) ||
    (first === 192 && second === 0 && third === 2) ||
    (first === 192 && second === 88 && third === 99) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224
  );
}

function expandIpv6(address) {
  const raw = String(address).toLowerCase().split('%', 1)[0];
  const sections = raw.split('::');
  if (sections.length > 2) return null;
  const compressed = sections.length === 2;
  const parseSection = (section) => {
    if (!section) return [];
    const parts = section.split(':');
    const last = parts.at(-1);
    if (last?.includes('.')) {
      const ipv4 = ipv4ToNumber(last);
      if (ipv4 === null) return null;
      parts.splice(
        -1,
        1,
        (ipv4 >>> 16).toString(16),
        (ipv4 & 0xffff).toString(16),
      );
    }
    if (parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
    return parts;
  };
  const left = parseSection(sections[0]);
  const right = parseSection(sections[1] || '');
  if (!left || !right) return null;
  const missing = 8 - left.length - right.length;
  if ((compressed && missing < 1) || (!compressed && missing !== 0))
    return null;
  return [...left, ...Array.from({ length: missing }, () => '0'), ...right].map(
    (part) => Number.parseInt(part, 16),
  );
}

function ipv6ToBigInt(address) {
  const groups = expandIpv6(address);
  if (!groups) return null;
  return groups.reduce((value, group) => (value << 16n) | BigInt(group), 0n);
}

function isNonPublicIp(address) {
  const normalized = String(address).replace(/^\[|\]$/g, '');
  const version = isIP(normalized);
  if (version === 4) return isNonPublicIpv4(normalized);
  if (version !== 6) return false;
  const value = ipv6ToBigInt(normalized);
  if (value === null) return false;
  if (value >> 32n === 0xffffn) {
    const mapped = Number(value & 0xffffffffn);
    return isNonPublicIpv4(
      [
        (mapped >>> 24) & 0xff,
        (mapped >>> 16) & 0xff,
        (mapped >>> 8) & 0xff,
        mapped & 0xff,
      ].join('.'),
    );
  }
  // Only global-unicast IPv6 addresses are valid output destinations.
  return value >> 125n !== 1n;
}

async function resolveSafeDownloadUrl(
  value,
  { allowLocalHttp = false, lookup = lookupHost } = {},
) {
  let target;
  try {
    target = new URL(value);
  } catch (error) {
    throw new MediaMcpError('Output URL must be absolute', {
      code: 'UNSAFE_OUTPUT_URL',
      cause: error,
    });
  }
  if (target.username || target.password)
    throw new MediaMcpError('Output URL must not contain credentials', {
      code: 'UNSAFE_OUTPUT_URL',
    });
  const loopback = isLocalHostname(target.hostname);
  const explicitlyNonPublic =
    loopback ||
    isNonPublicIp(target.hostname) ||
    target.hostname.toLowerCase().endsWith('.local');
  const allowedLoopback =
    allowLocalHttp && target.protocol === 'http:' && loopback;
  if (explicitlyNonPublic && !allowedLoopback)
    throw new MediaMcpError(
      'Output URL must not target a private or local address',
      { code: 'UNSAFE_OUTPUT_URL' },
    );
  if (target.protocol !== 'https:' && !allowedLoopback)
    throw new MediaMcpError('Output URL must use HTTPS', {
      code: 'UNSAFE_OUTPUT_URL',
    });
  let addresses = [];
  const hostname = target.hostname.replace(/^\[|\]$/g, '');
  const addressFamily = isIP(hostname);
  if (addressFamily === 0 && !loopback) {
    try {
      addresses = await lookup(hostname, { all: true, verbatim: true });
    } catch (error) {
      throw new MediaMcpError(
        `Unable to resolve output hostname: ${target.hostname}`,
        { code: 'UNSAFE_OUTPUT_URL', cause: error },
      );
    }
    if (
      !Array.isArray(addresses) ||
      addresses.length === 0 ||
      addresses.some((item) => isNonPublicIp(item.address))
    )
      throw new MediaMcpError(
        'Output URL hostname resolves to a private or local address',
        { code: 'UNSAFE_OUTPUT_URL' },
      );
  } else if (addressFamily !== 0) {
    addresses = [
      {
        address: hostname,
        family: addressFamily,
      },
    ];
  }
  return { target, addresses };
}

export async function assertSafeDownloadUrl(value, options = {}) {
  return (await resolveSafeDownloadUrl(value, options)).target;
}

function sameOrigin(left, right) {
  return left.origin === right.origin;
}

function responseFromIncomingMessage(message, url) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(message.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) headers.set(name, value);
  }
  return {
    body: Readable.toWeb(message),
    headers,
    ok: message.statusCode >= 200 && message.statusCode < 300,
    status: message.statusCode,
    url,
  };
}

export async function fetchPinned(
  url,
  addresses = [],
  { headers = {}, method = 'GET', signal } = {},
) {
  const candidates = addresses.length > 0 ? addresses : [undefined];
  const connectionHostname = url.hostname.replace(/^\[|\]$/g, '');
  let lastError;
  for (const address of candidates) {
    if (signal?.aborted) throw signal.reason;
    try {
      return await new Promise((resolve, reject) => {
        const transport = url.protocol === 'https:' ? https : http;
        const requestHeaders = { ...headers, host: url.host };
        const request = transport.request(
          {
            agent: false,
            headers: requestHeaders,
            hostname: address?.address || connectionHostname,
            method,
            path: `${url.pathname}${url.search}`,
            port: url.port || undefined,
            ...(url.protocol === 'https:'
              ? { servername: connectionHostname }
              : {}),
            ...(address
              ? {
                  lookup: (_hostname, _options, callback) =>
                    callback(null, address.address, address.family),
                }
              : {}),
          },
          (response) => {
            signal?.removeEventListener('abort', abort);
            resolve(responseFromIncomingMessage(response, url.toString()));
          },
        );
        const abort = () => request.destroy(signal?.reason);
        signal?.addEventListener('abort', abort, { once: true });
        request.once('error', (error) => {
          signal?.removeEventListener('abort', abort);
          reject(error);
        });
        request.end();
      });
    } catch (error) {
      if (signal?.aborted) throw signal.reason || error;
      lastError = error;
    }
  }
  throw lastError;
}

function awaitWithAbort(value, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(value).then(
      (result) => {
        signal.removeEventListener('abort', abort);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

export async function fetchOutput(
  url,
  credentials,
  {
    fetchImpl = fetch,
    lookup = lookupHost,
    timeoutMs = DOWNLOAD_TIMEOUT_MS,
  } = {},
) {
  const base = new URL(credentials.baseUrl);
  const allowLocalHttp =
    base.protocol === 'http:' && isLocalHostname(base.hostname);
  const timeoutError = new MediaMcpError('Output download timed out', {
    code: 'DOWNLOAD_TIMEOUT',
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
  try {
    let resolved = await awaitWithAbort(
      resolveSafeDownloadUrl(url, { allowLocalHttp, lookup }),
      controller.signal,
    );
    let target = resolved.target;
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      const headers = {
        accept: '*/*',
        'user-agent': `ergouzi-media-mcp/${MEDIA_MCP_VERSION}`,
        ...(sameOrigin(target, base)
          ? { authorization: `Bearer ${credentials.apiKey}` }
          : {}),
      };
      let response;
      try {
        response =
          fetchImpl === fetch
            ? await fetchPinned(target, resolved.addresses, {
                headers,
                signal: controller.signal,
              })
            : await fetchImpl(target, {
                headers,
                redirect: 'manual',
                signal: controller.signal,
              });
      } catch (error) {
        if (controller.signal.aborted) throw timeoutError;
        throw new MediaMcpError(
          `Output download failed: ${redactSecrets(error.message, [credentials.apiKey])}`,
          { code: 'DOWNLOAD_FAILED', cause: error },
        );
      }
      if (response.status < 300 || response.status >= 400) {
        const finalTarget =
          fetchImpl === fetch
            ? target
            : await awaitWithAbort(
                assertSafeDownloadUrl(response.url || target.toString(), {
                  allowLocalHttp,
                  lookup,
                }),
                controller.signal,
              );
        return {
          response,
          target: finalTarget,
          signal: controller.signal,
          release: () => clearTimeout(timer),
        };
      }
      await response.body?.cancel().catch(() => {});
      if (redirects === 5)
        throw new MediaMcpError('Output download exceeded the redirect limit', {
          code: 'TOO_MANY_REDIRECTS',
        });
      const location = response.headers.get('location');
      if (!location)
        throw new MediaMcpError(
          'Output download redirect did not include a location',
          { code: 'INVALID_REDIRECT' },
        );
      resolved = await awaitWithAbort(
        resolveSafeDownloadUrl(new URL(location, target).toString(), {
          allowLocalHttp,
          lookup,
        }),
        controller.signal,
      );
      target = resolved.target;
    }
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
  clearTimeout(timer);
  throw new MediaMcpError('Output download failed to resolve', {
    code: 'DOWNLOAD_FAILED',
  });
}

function extensionForMediaType(contentType) {
  const mediaType = canonicalMediaType(contentType);
  const known = {
    'image/avif': '.avif',
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'audio/mpeg': '.mp3',
    'audio/wav': '.wav',
    'audio/flac': '.flac',
  };
  return known[mediaType] || '';
}

function extensionFor(contentType, sourceUrl) {
  const known = extensionForMediaType(contentType);
  if (known) return known;
  const suffix = path.extname(new URL(sourceUrl).pathname).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(suffix) ? suffix : '.bin';
}

function destinationForDetectedMediaType(destination, contentType, mediaType) {
  const declaredType = canonicalMediaType(contentType);
  if (declaredType && declaredType !== 'application/octet-stream')
    return destination;
  const extension = extensionForMediaType(mediaType);
  if (!extension) return destination;
  const currentExtension = path.extname(destination);
  if (currentExtension.toLowerCase() === extension) return destination;
  const stem = currentExtension
    ? destination.slice(0, -currentExtension.length)
    : destination;
  return `${stem}${extension}`;
}

function canonicalMediaType(contentType) {
  const mediaType = String(contentType || '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase();
  return mediaType === 'audio/x-wav' ? 'audio/wav' : mediaType;
}

function assertOutputContentType(contentType) {
  const mediaType = canonicalMediaType(contentType);
  if (!mediaType || mediaType === 'application/octet-stream') return;
  if (!OUTPUT_MEDIA_TYPES.has(mediaType))
    throw new MediaMcpError(
      `Generated output has an unsupported content type: ${mediaType}`,
      { code: 'UNEXPECTED_OUTPUT_TYPE' },
    );
}

function versionedPath(filePath, version) {
  const extension = path.extname(filePath);
  const stem = extension ? filePath.slice(0, -extension.length) : filePath;
  return `${stem}-v${version}${extension}`;
}

async function publishTemporaryFile(temporary, initialDestination) {
  let destination = initialDestination;
  let version = 2;
  while (true) {
    try {
      await link(temporary, destination);
      await unlink(temporary).catch(() => {});
      return destination;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      destination = versionedPath(initialDestination, version);
      version += 1;
    }
  }
}

class ByteLimitTransform extends Transform {
  constructor(limit) {
    super();
    this.limit = limit;
    this.total = 0;
  }

  _transform(chunk, encoding, callback) {
    this.total += chunk.length;
    if (this.total > this.limit)
      callback(
        new MediaMcpError('Generated output exceeds the 2 GiB download limit', {
          code: 'OUTPUT_TOO_LARGE',
        }),
      );
    else callback(null, chunk);
  }
}

async function downloadOne(response, destination, signal) {
  const temporary = `${destination}.tmp-${randomUUID()}`;
  try {
    const contentLength = response.headers.get('content-length')?.trim();
    const length =
      contentLength && /^[0-9]+$/.test(contentLength)
        ? Number(contentLength)
        : null;
    if (length !== null && length > MAX_OUTPUT_BYTES)
      throw new MediaMcpError(
        'Generated output exceeds the 2 GiB download limit',
        { code: 'OUTPUT_TOO_LARGE' },
      );
    if (length === 0)
      throw new MediaMcpError('Generated output is empty', {
        code: 'EMPTY_OUTPUT',
      });
    const contentType = response.headers.get('content-type');
    assertOutputContentType(contentType);
    const source = response.body
      ? Readable.fromWeb(response.body)
      : Readable.from([]);
    const byteLimit = new ByteLimitTransform(MAX_OUTPUT_BYTES);
    await pipeline(
      source,
      byteLimit,
      createWriteStream(temporary, { flags: 'wx' }),
      { signal },
    );
    if (byteLimit.total === 0)
      throw new MediaMcpError('Generated output is empty', {
        code: 'EMPTY_OUTPUT',
      });
    const mediaType = await detectMediaTypeFromFile(temporary);
    if (!mediaType)
      throw new MediaMcpError(
        'Generated output does not have a recognized media signature',
        { code: 'INVALID_OUTPUT_MEDIA' },
      );
    const declaredType = canonicalMediaType(contentType);
    if (
      declaredType &&
      declaredType !== 'application/octet-stream' &&
      declaredType !== mediaType
    )
      throw new MediaMcpError(
        `Generated output signature does not match content type: ${declaredType}`,
        { code: 'INVALID_OUTPUT_MEDIA' },
      );
    const published = await publishTemporaryFile(
      temporary,
      destinationForDetectedMediaType(destination, contentType, mediaType),
    );
    return {
      path: path.resolve(published),
      bytes: byteLimit.total,
      media_type: mediaType,
    };
  } catch (error) {
    await response.body?.cancel().catch(() => {});
    await unlink(temporary).catch(() => {});
    if (signal?.aborted)
      throw new MediaMcpError('Output download timed out', {
        code: 'DOWNLOAD_TIMEOUT',
        cause: error,
      });
    throw error;
  }
}

function outputUrls(output) {
  if (typeof output === 'string' && output.trim()) return [output];
  if (
    Array.isArray(output) &&
    output.length > 0 &&
    output.every((value) => typeof value === 'string' && value.trim())
  )
    return output;
  throw new MediaMcpError(
    'Completed prediction output must be a URL or an array of URLs',
    { code: 'INVALID_OUTPUT' },
  );
}

function expandHomePath(value) {
  const text = String(value);
  if (!/^~(?:$|[\\/])/.test(text)) return text;
  const home = homedir();
  return text === '~' ? home : path.join(home, text.slice(2));
}

export async function downloadPrediction(
  credentials,
  taskId,
  outputDir = path.join(process.cwd(), 'outputs', 'ergouzi-media-mcp'),
) {
  validateTaskId(taskId);
  const prediction = await getPrediction(credentials, taskId, 0);
  if (prediction?.status !== 'succeeded')
    throw new MediaMcpError(
      `Prediction ${taskId} is not succeeded (status: ${prediction?.status || 'unknown'})`,
      { code: 'PREDICTION_NOT_READY' },
    );
  const outputDirectory = path.resolve(expandHomePath(outputDir));
  await mkdir(outputDirectory, { recursive: true });
  const files = [];
  const downloads = [];
  for (const [index, source] of outputUrls(prediction.output).entries()) {
    const sourceUrl = source.startsWith('/')
      ? new URL(source, `${credentials.baseUrl}/`).toString()
      : source;
    const download = await fetchOutput(sourceUrl, credentials);
    try {
      const { response, target, signal } = download;
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new MediaMcpError(
          `Output download returned HTTP ${response.status}`,
          { code: 'DOWNLOAD_FAILED', status: response.status },
        );
      }
      const destination = path.join(
        outputDirectory,
        `result-${index + 1}${extensionFor(response.headers.get('content-type'), target.toString())}`,
      );
      const output = await downloadOne(response, destination, signal);
      files.push(output.path);
      downloads.push(output);
    } finally {
      download.release();
    }
  }
  const date = new Date().toISOString().slice(0, 10);
  const receiptDirectory = path.join(outputDirectory, 'receipts', date);
  await mkdir(receiptDirectory, { recursive: true });
  const receiptDestination = path.join(receiptDirectory, `${taskId}.json`);
  const receiptTemporary = `${receiptDestination}.tmp-${randomUUID()}`;
  await writeFile(
    receiptTemporary,
    `${JSON.stringify({ task_id: taskId, files, downloads, downloaded_at: new Date().toISOString() }, null, 2)}\n`,
    { flag: 'wx' },
  );
  let receipt;
  try {
    receipt = await publishTemporaryFile(receiptTemporary, receiptDestination);
  } catch (error) {
    await unlink(receiptTemporary).catch(() => {});
    throw error;
  }
  return {
    task_id: taskId,
    files,
    downloads,
    receipt: path.resolve(receipt),
  };
}

const OPEN_OBJECT_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
};

const PREDICTION_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    status: { type: 'string' },
  },
  additionalProperties: true,
};

const MODEL_SCHEMA_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    model: { type: 'string' },
    description: { type: ['string', 'null'] },
    version: {
      type: 'object',
      properties: {
        id: { type: ['string', 'null'] },
        cog_version: { type: ['string', 'null'] },
        created_at: { type: ['string', 'null'] },
      },
      required: ['id', 'cog_version', 'created_at'],
      additionalProperties: false,
    },
    input_schema: { type: ['object', 'null'] },
    output_schema: { type: ['object', 'null'] },
    default_input: { type: ['object', 'null'] },
  },
  required: [
    'model',
    'description',
    'version',
    'input_schema',
    'output_schema',
    'default_input',
  ],
  additionalProperties: false,
};

const CONFIGURATION_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    base_url: { type: 'string' },
    base_url_source: { type: 'string' },
    credential_source: { type: 'string' },
    config_file: { type: ['string', 'null'] },
    config_file_permissions: { type: ['string', 'null'] },
    warnings: { type: 'array', items: { type: 'string' } },
    api_access: { type: 'string' },
    visible_model_count: { type: 'integer', minimum: 0 },
  },
  required: [
    'base_url',
    'base_url_source',
    'credential_source',
    'config_file',
    'config_file_permissions',
    'warnings',
    'api_access',
    'visible_model_count',
  ],
  additionalProperties: false,
};

const DOWNLOAD_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    task_id: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
    downloads: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          bytes: { type: 'integer', minimum: 1 },
          media_type: { type: 'string' },
        },
        required: ['path', 'bytes', 'media_type'],
        additionalProperties: false,
      },
    },
    receipt: { type: 'string' },
  },
  required: ['task_id', 'files', 'downloads', 'receipt'],
  additionalProperties: false,
};

export function toolDefinitions() {
  return [
    {
      name: 'list_models',
      description:
        'List Ergouzi image and video models visible to the configured media API key.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      outputSchema: OPEN_OBJECT_OUTPUT_SCHEMA,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    {
      name: 'get_model_schema',
      description:
        'Read the current input and output schema for one Ergouzi image or video model.',
      inputSchema: {
        type: 'object',
        properties: {
          model: {
            type: 'string',
            description:
              'Model identifier such as ergouzi/e-image or ergouzi/e-video.',
          },
          refresh: {
            type: 'boolean',
            default: false,
            description: 'Bypass the short local schema cache.',
          },
        },
        required: ['model'],
        additionalProperties: false,
      },
      outputSchema: MODEL_SCHEMA_OUTPUT_SCHEMA,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    {
      name: 'create_prediction',
      description:
        'Create one billable Ergouzi image or video prediction after the user has explicitly requested it, then return its task ID without waiting indefinitely.',
      inputSchema: {
        type: 'object',
        properties: {
          model: {
            type: 'string',
            description:
              'Model identifier such as ergouzi/e-image or ergouzi/e-video.',
          },
          input: {
            type: 'object',
            description:
              'Model-specific input. Use {$local_file: absolutePath} only in documented media fields.',
          },
          idempotency_key: {
            type: 'string',
            minLength: 1,
            maxLength: 128,
            description:
              'Optional stable key for safe retry of one logical submission.',
          },
        },
        required: ['model', 'input'],
        additionalProperties: false,
      },
      outputSchema: PREDICTION_OUTPUT_SCHEMA,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    {
      name: 'get_prediction',
      description:
        'Read one prediction by task ID, optionally waiting for a bounded period.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: {
            type: 'string',
            description: 'Prediction task ID returned by create_prediction.',
          },
          wait_seconds: {
            type: 'integer',
            minimum: 0,
            maximum: MAX_WAIT_SECONDS,
            default: 0,
          },
        },
        required: ['task_id'],
        additionalProperties: false,
      },
      outputSchema: PREDICTION_OUTPUT_SCHEMA,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    {
      name: 'cancel_prediction',
      description:
        'Cancel one existing Ergouzi prediction after explicit user confirmation.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: {
            type: 'string',
            description: 'Prediction task ID to cancel.',
          },
        },
        required: ['task_id'],
        additionalProperties: false,
      },
      outputSchema: PREDICTION_OUTPUT_SCHEMA,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    {
      name: 'download_prediction',
      description:
        'Download successful prediction outputs into a local directory and write a receipt.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: {
            type: 'string',
            description: 'A succeeded prediction task ID.',
          },
          output_dir: {
            type: 'string',
            description:
              'Optional local directory; defaults to outputs/ergouzi-media-mcp.',
          },
        },
        required: ['task_id'],
        additionalProperties: false,
      },
      outputSchema: DOWNLOAD_OUTPUT_SCHEMA,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    {
      name: 'check_configuration',
      description:
        'Verify local media credentials and API access without exposing the API key.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      outputSchema: CONFIGURATION_OUTPUT_SCHEMA,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
  ];
}

export async function callTool(name, args = {}, credentials) {
  assertObject(args, 'Tool arguments must be a JSON object');
  if (!credentials)
    throw new MediaMcpError('Ergouzi media credentials are not configured', {
      code: 'MISSING_CREDENTIALS',
    });
  switch (name) {
    case 'list_models': {
      const models = await apiJson(credentials, 'GET', '/customer/v1/models');
      return Array.isArray(models) ? { results: models } : models;
    }
    case 'get_model_schema':
      return getModelSchema(credentials, args.model, {
        refresh: args.refresh ?? false,
      });
    case 'create_prediction':
      return createPrediction(
        credentials,
        args.model,
        args.input,
        args.idempotency_key || randomUUID(),
      );
    case 'get_prediction':
      return getPrediction(credentials, args.task_id, args.wait_seconds ?? 0);
    case 'cancel_prediction':
      return cancelPrediction(credentials, args.task_id);
    case 'download_prediction':
      return downloadPrediction(credentials, args.task_id, args.output_dir);
    case 'check_configuration':
      return checkConfiguration(credentials);
    default:
      throw new MediaMcpError(`Unknown tool: ${name}`, {
        code: 'UNKNOWN_TOOL',
      });
  }
}
