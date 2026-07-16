import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MOBILE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REQUIRED_MOBILE_ENV_KEYS = [
  'EXPO_PUBLIC_CINDY_AUTH_REGION',
  'EXPO_PUBLIC_CINDY_AUTH_BASE_URL',
  'EXPO_PUBLIC_XDT_API_BASE_URL',
  'EXPO_PUBLIC_XDT_DEVICE_LINK_API_BASE_URL',
];

export function ensureMobileEnv({
  mobileDir = MOBILE_DIR,
  envPath = resolve(mobileDir, '.env'),
  easJsonPath = resolve(mobileDir, 'eas.json'),
  envExamplePath = resolve(mobileDir, '.env.example'),
} = {}) {
  const defaults = readProductionEnv(easJsonPath);
  const exampleValues = existsSync(envExamplePath) ? readEnvFile(envExamplePath) : {};
  let content = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  const created = !existsSync(envPath);
  const addedKeys = [];

  for (const key of REQUIRED_MOBILE_ENV_KEYS) {
    const value = defaults[key];
    if (!String(value ?? '').trim()) throw new Error(`Missing ${key} in eas.json production profile env`);
    const next = upsertEnvValue(content, key, value, exampleValues[key]);
    if (next !== content) addedKeys.push(key);
    content = next;
  }

  if (created || addedKeys.length) {
    mkdirSync(dirname(envPath), { recursive: true });
    writeFileSync(envPath, content.endsWith('\n') ? content : `${content}\n`);
  }

  return { envPath, created, addedKeys };
}

export function formatMobileEnvStatus(result, rootDir = dirname(result.envPath)) {
  const envLabel = relative(rootDir, result.envPath) || result.envPath;
  if (result.created) return `==> Created mobile env: ${envLabel}`;
  if (result.addedKeys.length) return `==> Updated mobile env: ${envLabel} (${result.addedKeys.join(', ')})`;
  return `==> Checked mobile env: ${envLabel}`;
}

export function readProductionEnv(easJsonPath) {
  const easJson = JSON.parse(readFileSync(easJsonPath, 'utf8'));
  return resolveBuildProfile(easJson, 'production').env ?? {};
}

function upsertEnvValue(content, key, value, placeholderValue) {
  const lines = content ? content.split(/\r?\n/) : [];
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  let found = false;

  const next = lines.map((line) => {
    if (!pattern.test(line)) return line;
    found = true;
    const current = normalizeEnvValue(line.slice(line.indexOf('=') + 1));
    return current && current !== placeholderValue ? line : `${key}=${value}`;
  });

  if (!found) next.push(`${key}=${value}`);
  return next.join('\n');
}

function readEnvFile(envPath) {
  const out = {};
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    if (!line || line.trim().startsWith('#') || !line.includes('=')) continue;
    const index = line.indexOf('=');
    out[line.slice(0, index).trim()] = normalizeEnvValue(line.slice(index + 1));
  }
  return out;
}

function normalizeEnvValue(value) {
  const trimmed = String(value ?? '').trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1).trim();
    }
  }
  return trimmed;
}

function resolveBuildProfile(easJson, profileName, seen = new Set()) {
  const profile = easJson?.build?.[profileName];
  if (!profile) throw new Error(`Missing EAS build profile: ${profileName}`);
  if (seen.has(profileName)) throw new Error(`Circular EAS profile extends: ${[...seen, profileName].join(' -> ')}`);
  if (!profile.extends) return clone(profile);
  const parent = resolveBuildProfile(easJson, profile.extends, new Set([...seen, profileName]));
  return deepMerge(parent, withoutKey(profile, 'extends'));
}

function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) return clone(override);
  const out = clone(base);
  for (const [key, value] of Object.entries(override)) {
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? deepMerge(out[key], value) : clone(value);
  }
  return out;
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function withoutKey(object, key) {
  const copy = { ...object };
  delete copy[key];
  return copy;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
