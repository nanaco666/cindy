import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/xdt-maker-test'),
  },
}));

vi.mock('../../maker-host/logger-adapter.js', () => ({
  desktopMakerLogger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
    }),
  },
}));

import { IM_DEFAULT_SETTINGS } from '../../../shared/imDefaultSettings.js';
import {
  __testing,
  resetImDefaultSettings,
  writeImDefaultSettingsPatch,
} from '../defaultSettingsStore';

const settingsDir = '/tmp/xdt-maker-test';
const settingsFile = path.join(settingsDir, 'im-default-settings.json');

describe('im default settings store', () => {
  beforeEach(() => {
    fs.mkdirSync(settingsDir, { recursive: true });
    resetImDefaultSettings();
  });

  afterEach(() => {
    resetImDefaultSettings();
    fs.rmSync(settingsDir, { recursive: true, force: true });
  });

  it('migrates legacy single-slot overrides after override defaults are merged', () => {
    const normalized = __testing.normalize({
      ...IM_DEFAULT_SETTINGS,
      agentKind: 'codex',
      providerId: 'openai',
      model: 'gpt-5.5',
      effort: 'medium',
    });

    expect(normalized.agents.codex).toEqual({
      providerId: 'openai',
      model: 'gpt-5.5',
      effort: 'medium',
    });
    expect(normalized.agents['claude-code']).toEqual(IM_DEFAULT_SETTINGS.agents['claude-code']);
  });

  it('persists only the changed agent override so untouched agents keep inheriting future defaults', () => {
    writeImDefaultSettingsPatch({
      agents: {
        codex: {
          providerId: 'openai',
          model: 'gpt-5.5',
          effort: 'high',
        },
      },
    });

    expect(JSON.parse(fs.readFileSync(settingsFile, 'utf-8'))).toEqual({
      agents: {
        codex: {
          providerId: 'openai',
          model: 'gpt-5.5',
          effort: 'high',
        },
      },
    });
  });

  it('preserves existing agent overrides when another agent is updated', () => {
    writeImDefaultSettingsPatch({
      agents: {
        'claude-code': {
          providerId: 'anthropic',
          model: 'claude-sonnet-4-8',
          effort: 'xhigh',
        },
      },
    });

    writeImDefaultSettingsPatch({
      agents: {
        codex: {
          providerId: 'openai',
          model: 'gpt-5.5',
          effort: 'high',
        },
      },
    });

    expect(JSON.parse(fs.readFileSync(settingsFile, 'utf-8'))).toEqual({
      agents: {
        'claude-code': {
          providerId: 'anthropic',
          model: 'claude-sonnet-4-8',
          effort: 'xhigh',
        },
        codex: {
          providerId: 'openai',
          model: 'gpt-5.5',
          effort: 'high',
        },
      },
    });
  });
});
