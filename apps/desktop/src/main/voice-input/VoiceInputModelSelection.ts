import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import { createLogger } from '../logger.js';
import {
  DEFAULT_VOICE_INPUT_ASR_PROVIDER_CHAIN,
  DEFAULT_VOICE_INPUT_PROVIDER_KIND,
  resolveVoiceInputProviderKindAlias,
  type VoiceInputProviderKind,
} from './voiceInputAsrConfig.js';
import {
  DEFAULT_VOICE_INPUT_REFINER_PROVIDER_CHAIN,
  DEFAULT_VOICE_INPUT_REFINER_PROVIDER_KIND,
  resolveVoiceInputRefinerProviderKindAlias,
  type VoiceInputRefinerProviderKind,
} from '../../shared/voiceInputRefinerProfiles.js';

const log = createLogger('voice-input:model-selection');
const CONFIG_FILE_NAME = 'voice-input-models.json';

export type VoiceInputProviderChainSource = 'default' | 'configured';

export type VoiceInputModelSelectionValues = {
  asrProvider: VoiceInputProviderKind;
  refinerProvider: VoiceInputRefinerProviderKind;
  refinerModel?: string;
  /**
   * Effective ASR fallback chain, highest priority first, deduped, always
   * starting with `asrProvider`. Built from the explicit chain config
   * (`asrProviderChain` file field / XDT_VOICE_INPUT_ASR_PROVIDER_CHAIN env,
   * comma separated) when present, otherwise from the built-in default chain.
   */
  asrProviderChain: VoiceInputProviderKind[];
  /** Effective refiner fallback chain; same resolution rules as asrProviderChain. */
  refinerProviderChain: VoiceInputRefinerProviderKind[];
  refinerProviderChainSource: VoiceInputProviderChainSource;
};

export type VoiceInputModelSelection = VoiceInputModelSelectionValues & {
  configPath: string;
};

export type VoiceInputModelSelectionPatch = {
  asrProvider?: VoiceInputProviderKind | null;
  refinerProvider?: VoiceInputRefinerProviderKind | null;
  refinerModel?: string | null;
};

export type VoiceInputModelSelectionWarning = {
  field: 'asrProvider' | 'refinerProvider' | 'asrProviderChain' | 'refinerProviderChain';
  value: string;
  fallback: string;
};

type VoiceInputModelSelectionResolution = {
  values: VoiceInputModelSelectionValues;
  warnings: VoiceInputModelSelectionWarning[];
};

type RawVoiceInputModelSelectionFile = {
  asrProvider?: unknown;
  utilityModelProvider?: unknown;
  utilityModel?: unknown;
  utilityModelProviderChain?: unknown;
  refinerProvider?: unknown;
  refinerModel?: unknown;
  asrProviderChain?: unknown;
  refinerProviderChain?: unknown;
};

let cachedConfig: VoiceInputModelSelection | null = null;
let cachedMtimeMs = -1;

export function getVoiceInputModelSelectionConfigPath(): string {
  return path.join(app.getPath('userData'), CONFIG_FILE_NAME);
}

export function resolveVoiceInputModelSelectionValues(
  raw: RawVoiceInputModelSelectionFile | null | undefined,
  env: NodeJS.ProcessEnv = readDefaultVoiceInputModelSelectionEnv(),
): VoiceInputModelSelectionResolution {
  warnIgnoredLegacyAsrProviderEnv(env);
  const asrProvider = resolveAsrProvider(readConfigString(raw, 'asrProvider') ?? env.XDT_VOICE_INPUT_ASR_PROVIDER ?? '');
  const refinerProvider = resolveRefinerProvider(
    readConfigString(raw, 'utilityModelProvider')
      ?? readConfigString(raw, 'refinerProvider')
      ?? env.XDT_UTILITY_MODEL_PROVIDER
      ?? env.XDT_VOICE_INPUT_REFINER_PROVIDER
      ?? '',
  );
  const refinerModel = normalizeOptionalString(
    readConfigString(raw, 'utilityModel')
      ?? readConfigString(raw, 'refinerModel')
      ?? env.XDT_UTILITY_MODEL
      ?? env.XDT_VOICE_INPUT_REFINER_MODEL,
  );
  const asrChain = resolveProviderChain({
    field: 'asrProviderChain',
    rawEntries: readConfigStringList(raw, 'asrProviderChain')
      ?? splitCommaList(env.XDT_VOICE_INPUT_ASR_PROVIDER_CHAIN),
    head: asrProvider.value,
    defaultChain: DEFAULT_VOICE_INPUT_ASR_PROVIDER_CHAIN,
    resolveAlias: resolveVoiceInputProviderKindAlias,
  });
  const refinerChain = resolveProviderChain({
    field: 'refinerProviderChain',
    rawEntries: readConfigStringList(raw, 'utilityModelProviderChain')
      ?? readConfigStringList(raw, 'refinerProviderChain')
      ?? splitCommaList(env.XDT_UTILITY_MODEL_PROVIDER_CHAIN)
      ?? splitCommaList(env.XDT_VOICE_INPUT_REFINER_PROVIDER_CHAIN),
    head: refinerProvider.value,
    defaultChain: DEFAULT_VOICE_INPUT_REFINER_PROVIDER_CHAIN,
    resolveAlias: resolveVoiceInputRefinerProviderKindAlias,
  });
  return {
    values: {
      asrProvider: asrProvider.value,
      refinerProvider: refinerProvider.value,
      refinerModel,
      asrProviderChain: asrChain.value,
      refinerProviderChain: refinerChain.value,
      refinerProviderChainSource: refinerChain.source,
    },
    warnings: [
      ...(asrProvider.warning ? [asrProvider.warning] : []),
      ...(refinerProvider.warning ? [refinerProvider.warning] : []),
      ...asrChain.warnings,
      ...refinerChain.warnings,
    ],
  };
}

/**
 * Builds the effective fallback chain: the user-selected primary provider is
 * always the head; the rest comes from the explicit chain config when present,
 * otherwise from the built-in default chain. Unknown entries are dropped with
 * a warning instead of failing the whole selection.
 */
function resolveProviderChain<K extends string>(input: {
  field: 'asrProviderChain' | 'refinerProviderChain';
  rawEntries: string[] | undefined;
  head: K;
  defaultChain: readonly K[];
  resolveAlias: (value: string) => K | null;
}): { value: K[]; source: VoiceInputProviderChainSource; warnings: VoiceInputModelSelectionWarning[] } {
  const warnings: VoiceInputModelSelectionWarning[] = [];
  const tailSource: K[] = [];
  if (input.rawEntries && input.rawEntries.length > 0) {
    for (const entry of input.rawEntries) {
      const resolved = input.resolveAlias(entry);
      if (resolved) {
        tailSource.push(resolved);
      } else {
        warnings.push({ field: input.field, value: entry, fallback: '<dropped>' });
      }
    }
  }
  const source: VoiceInputProviderChainSource = tailSource.length > 0 ? 'configured' : 'default';
  if (tailSource.length === 0) tailSource.push(...input.defaultChain);
  const chain: K[] = [input.head];
  for (const entry of tailSource) {
    if (!chain.includes(entry)) chain.push(entry);
  }
  return { value: chain, source, warnings };
}

function readDefaultVoiceInputModelSelectionEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // Electron main is bundled by Vite. vite.main.config.ts injects XDT_*
    // values by replacing direct process.env.XDT_* reads, so keep these
    // explicit instead of only passing the process.env object through.
    XDT_VOICE_INPUT_ASR_PROVIDER: process.env.XDT_VOICE_INPUT_ASR_PROVIDER,
    XDT_UTILITY_MODEL_PROVIDER: process.env.XDT_UTILITY_MODEL_PROVIDER,
    XDT_UTILITY_MODEL: process.env.XDT_UTILITY_MODEL,
    XDT_UTILITY_MODEL_PROVIDER_CHAIN: process.env.XDT_UTILITY_MODEL_PROVIDER_CHAIN,
    XDT_VOICE_INPUT_REFINER_PROVIDER: process.env.XDT_VOICE_INPUT_REFINER_PROVIDER,
    XDT_VOICE_INPUT_REFINER_MODEL: process.env.XDT_VOICE_INPUT_REFINER_MODEL,
    XDT_VOICE_INPUT_ASR_PROVIDER_CHAIN: process.env.XDT_VOICE_INPUT_ASR_PROVIDER_CHAIN,
    XDT_VOICE_INPUT_REFINER_PROVIDER_CHAIN: process.env.XDT_VOICE_INPUT_REFINER_PROVIDER_CHAIN,
  };
}

export function getVoiceInputModelSelection(): VoiceInputModelSelection {
  ensureVoiceInputModelSelectionFile();
  const configPath = getVoiceInputModelSelectionConfigPath();
  const mtimeMs = readConfigMtimeMs(configPath);
  if (!cachedConfig || cachedMtimeMs !== mtimeMs) {
    cachedConfig = loadVoiceInputModelSelection(configPath, mtimeMs);
  }
  return cachedConfig;
}

export function reloadVoiceInputModelSelection(): VoiceInputModelSelection {
  cachedConfig = null;
  cachedMtimeMs = -1;
  return getVoiceInputModelSelection();
}

export function setVoiceInputModelSelection(patch: VoiceInputModelSelectionPatch): VoiceInputModelSelection {
  ensureVoiceInputModelSelectionFile();
  const configPath = getVoiceInputModelSelectionConfigPath();
  const current = readVoiceInputModelSelectionFile(configPath) ?? defaultRuntimeConfigFile();
  const next: RawVoiceInputModelSelectionFile = { ...current };
  if ('asrProvider' in patch) next.asrProvider = patch.asrProvider ?? '';
  if ('refinerProvider' in patch) next.refinerProvider = patch.refinerProvider ?? '';
  if ('refinerModel' in patch) next.refinerModel = patch.refinerModel?.trim() ?? '';
  fs.writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  log.info('voice input model selection written', {
    path: configPath,
    asrProvider: next.asrProvider,
    refinerProvider: next.refinerProvider,
    refinerModel: next.refinerModel,
  });
  return reloadVoiceInputModelSelection();
}

export function voiceInputModelSelectionSignature(config: VoiceInputModelSelectionValues): string {
  return JSON.stringify({
    asrProvider: config.asrProvider,
    refinerProvider: config.refinerProvider,
    refinerModel: config.refinerModel ?? '',
    asrProviderChain: config.asrProviderChain,
    refinerProviderChain: config.refinerProviderChain,
    refinerProviderChainSource: config.refinerProviderChainSource,
  });
}

function resolveAsrProvider(value: string): {
  value: VoiceInputProviderKind;
  warning?: VoiceInputModelSelectionWarning;
} {
  const normalized = value.trim();
  const resolved = resolveVoiceInputProviderKindAlias(normalized);
  if (resolved) return { value: resolved };
  return {
    value: DEFAULT_VOICE_INPUT_PROVIDER_KIND,
    warning: {
      field: 'asrProvider',
      value: normalized,
      fallback: DEFAULT_VOICE_INPUT_PROVIDER_KIND,
    },
  };
}

function resolveRefinerProvider(value: string): {
  value: VoiceInputRefinerProviderKind;
  warning?: VoiceInputModelSelectionWarning;
} {
  const normalized = value.trim();
  const resolved = resolveVoiceInputRefinerProviderKindAlias(normalized);
  if (resolved) return { value: resolved };
  return {
    value: DEFAULT_VOICE_INPUT_REFINER_PROVIDER_KIND,
    warning: {
      field: 'refinerProvider',
      value: normalized,
      fallback: DEFAULT_VOICE_INPUT_REFINER_PROVIDER_KIND,
    },
  };
}

function loadVoiceInputModelSelection(configPath: string, mtimeMs: number): VoiceInputModelSelection {
  const raw = readVoiceInputModelSelectionFile(configPath);
  const resolution = resolveVoiceInputModelSelectionValues(raw);
  for (const warning of resolution.warnings) {
    log.warn('unknown voice input model selection value, falling back', warning);
  }
  const config: VoiceInputModelSelection = {
    ...resolution.values,
    configPath,
  };
  cachedMtimeMs = mtimeMs;
  log.info('voice input model selection loaded', {
    path: configPath,
    asrProvider: config.asrProvider,
    refinerProvider: config.refinerProvider,
    refinerModel: config.refinerModel,
    asrProviderChain: config.asrProviderChain,
    refinerProviderChain: config.refinerProviderChain,
    refinerProviderChainSource: config.refinerProviderChainSource,
  });
  return config;
}

function readVoiceInputModelSelectionFile(configPath: string): RawVoiceInputModelSelectionFile | null {
  try {
    const text = fs.readFileSync(configPath, 'utf8');
    const parsed: unknown = JSON.parse(text);
    if (!isPlainObject(parsed)) {
      log.warn('voice input model selection file is not an object, using defaults', { path: configPath });
      return null;
    }
    return parsed;
  } catch (error) {
    log.warn('voice input model selection read failed, using defaults', {
      path: configPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function ensureVoiceInputModelSelectionFile(): void {
  const configPath = getVoiceInputModelSelectionConfigPath();
  if (fs.existsSync(configPath)) return;
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(defaultRuntimeConfigFile(), null, 2)}\n`, 'utf8');
    log.info('voice input model selection file created', { path: configPath });
  } catch (error) {
    log.warn('voice input model selection file create failed', {
      path: configPath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function readConfigMtimeMs(configPath: string): number {
  try {
    return fs.statSync(configPath).mtimeMs;
  } catch {
    return 0;
  }
}

function defaultRuntimeConfigFile(): RawVoiceInputModelSelectionFile {
  // Empty strings / arrays intentionally mean "use the app default / env
  // fallback". Keeping the generated file sparse avoids freezing future
  // default model changes for users who never explicitly customize voice
  // input models.
  return {
    asrProvider: '',
    refinerProvider: '',
    refinerModel: '',
    asrProviderChain: [],
    refinerProviderChain: [],
  };
}

function readConfigString(raw: RawVoiceInputModelSelectionFile | null | undefined, key: keyof RawVoiceInputModelSelectionFile): string | undefined {
  if (!raw || !(key in raw)) return undefined;
  const value = raw[key];
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized ? normalized : undefined;
}

// Chain fields accept a JSON string array; an empty / missing array means
// "use the built-in default chain". Non-string entries are dropped here and
// unknown provider names are dropped (with a warning) during resolution.
function readConfigStringList(
  raw: RawVoiceInputModelSelectionFile | null | undefined,
  key: 'asrProviderChain' | 'refinerProviderChain' | 'utilityModelProviderChain',
): string[] | undefined {
  if (!raw || !(key in raw)) return undefined;
  const value = raw[key];
  if (!Array.isArray(value)) return undefined;
  const entries = value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries.length > 0 ? entries : undefined;
}

function splitCommaList(value: string | undefined): string[] | undefined {
  const entries = (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries.length > 0 ? entries : undefined;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function warnIgnoredLegacyAsrProviderEnv(env: NodeJS.ProcessEnv): void {
  const legacyEnvEntries: Array<[string, string | undefined]> = [
    ['XDT_VOICE_INPUT_PROVIDER', env.XDT_VOICE_INPUT_PROVIDER],
    ['VOICE_INPUT_PROVIDER', env.VOICE_INPUT_PROVIDER],
  ];
  const legacyEnvVars = legacyEnvEntries
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim().length > 0)
    .map(([name]) => name);
  if (legacyEnvVars.length === 0) return;
  log.warn('legacy voice input ASR provider env ignored', {
    legacyEnvVars,
    replacementEnvVar: 'XDT_VOICE_INPUT_ASR_PROVIDER',
    runtimeConfigFile: CONFIG_FILE_NAME,
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
