const unitVitestScript = { type: 'packageScript', script: 'test' };
const vitestBin = (...args) => ({ type: 'packageBin', bin: 'vitest', args });
const noCollectableTestsReason = 'No collectable tests yet. Add tests and mark a tier required when this workspace gains testable logic.';
const desktopDbInclude = [
  'src/main/localDb/**/__tests__/*.test.ts',
  'src/main/scheduler-host/__tests__/*.db.test.ts',
  'src/main/__tests__/schemaDriftRepair.test.ts',
  'src/main/__tests__/betterSqliteFactory.test.ts',
  'src/main/__tests__/codexHistoryPromptInit.test.ts',
  'src/main/__tests__/orcaStaleIndexCleanup.test.ts',
  'src/main/__tests__/*LocalSessions.test.ts',
];
const desktopDbExclude = [
  'src/main/localDb/__tests__/migrationReplay.test.ts',
  'src/main/localDb/__tests__/drizzle-proxy-perf.test.ts',
];

const noCollectableWorkspace = (name, cwd, reason = noCollectableTestsReason) => ({
  name,
  cwd,
  status: 'notApplicable',
  reason,
  tiers: {},
});

const requiredUnitWorkspace = (name, cwd) => ({
  name,
  cwd,
  status: 'required',
  tiers: { unit: { status: 'required', command: unitVitestScript } },
});

export default {
  workspaces: [
    {
      name: 'desktop',
      cwd: 'apps/desktop',
      status: 'required',
      tiers: {
        unit: {
          status: 'required',
          // Desktop unit tests spawn many Git/filesystem subprocesses; cap workers so
          // Windows does not exhaust process and file-lock budgets under full-suite load.
          command: vitestBin('run', '--maxWorkers=4'),
          exclude: [
            'src/main/localDb/**',
            'src/main/__tests__/*Migration.test.ts',
            'src/main/__tests__/schemaDriftRepair.test.ts',
            'src/main/__tests__/betterSqliteFactory.test.ts',
            'src/main/__tests__/*LocalSessions.test.ts',
            'src/main/__tests__/codexHistoryPromptInit.test.ts',
            'src/main/__tests__/orcaStaleIndexCleanup.test.ts',
            'src/main/scheduler-host/__tests__/*.db.test.ts',
            'src/main/__tests__/directSessionSendGuard.test.ts',
            'src/main/__tests__/makerSendToSessionOrdering.test.ts',
            '**/*.bench.ts',
          ],
        },
        db: {
          status: 'manual',
          reason: 'Desktop DB tests remain an explicit DB tier because they bootstrap runtime assets and cover localDb behavior outside fast unit.',
          coverage: 'allowlist',
          preflight: [
            { type: 'packageScript', script: 'ensure-deps' },
            { type: 'packageScript', script: 'ensure-dev-runtime-assets' },
          ],
          command: vitestBin('run'),
          include: desktopDbInclude,
          exclude: desktopDbExclude,
        },
        migration: {
          status: 'manual',
          reason: 'Migration replay remains an explicit DB tier because it replays SQLite history fixtures outside fast unit.',
          coverage: 'allowlist',
          preflight: [
            { type: 'packageScript', script: 'ensure-deps' },
            { type: 'packageScript', script: 'ensure-dev-runtime-assets' },
          ],
          command: vitestBin('run'),
          include: [
            'src/main/localDb/__tests__/migrationReplay.test.ts',
            'src/main/__tests__/*Migration.test.ts',
          ],
        },
        'db-perf': {
          status: 'manual',
          reason: 'DB proxy performance is intentionally explicit because strict timing is host-sensitive.',
          coverage: 'allowlist',
          command: { type: 'packageScript', script: 'test:db-proxy-perf' },
          include: ['src/main/localDb/__tests__/drizzle-proxy-perf.test.ts'],
        },
        guard: {
          status: 'required',
          coverage: 'allowlist',
          command: vitestBin('run'),
          include: [
            'src/main/__tests__/directSessionSendGuard.test.ts',
            'src/main/__tests__/makerSendToSessionOrdering.test.ts',
          ],
        },
      },
    },
    requiredUnitWorkspace('mobile', 'apps/mobile'),
    requiredUnitWorkspace('@lizi/anthropic-compat-proxy', 'packages/anthropic-compat-proxy'),
    requiredUnitWorkspace('@lizi/anthropic-responses-bridge', 'packages/anthropic-responses-bridge'),
    requiredUnitWorkspace('@cindy/auth-client', 'packages/auth-client'),
    requiredUnitWorkspace('@lizi/browser-control-runtime', 'packages/browser-control-runtime'),
    requiredUnitWorkspace('cindy-tools', 'packages/cindy-tools'),
    requiredUnitWorkspace('@lizi/device-link', 'packages/device-link'),
    noCollectableWorkspace('@lizi/embedding-client', 'packages/embedding-client'),
    requiredUnitWorkspace('@lizi/file-browser-core', 'packages/file-browser-core'),
    noCollectableWorkspace('@lizi/github-client', 'packages/github-client'),
    noCollectableWorkspace('@lizi/gitlab-client', 'packages/gitlab-client'),
    noCollectableWorkspace('@lizi/heartbeat-client', 'packages/heartbeat-client'),
    requiredUnitWorkspace('lizi-im', 'packages/lizi-im'),
    requiredUnitWorkspace('lizi-mcps', 'packages/lizi-mcps'),
    requiredUnitWorkspace('@lizi/maker-cc-manager', 'packages/maker-cc-manager'),
    requiredUnitWorkspace('@lizi/maker-core', 'packages/maker-core'),
    requiredUnitWorkspace('@lizi/maker-remote-ssh', 'packages/maker-remote-ssh'),
    requiredUnitWorkspace('@lizi/maker-scheduler', 'packages/maker-scheduler'),
    requiredUnitWorkspace('@lizi/maker-shared', 'packages/maker-shared'),
    requiredUnitWorkspace('@lizi/model-providers', 'packages/model-providers'),
    {
      name: '@fmfsaisai/orca-workflow',
      cwd: 'packages/orca-workflow',
      status: 'required',
      tiers: {
        unit: {
          status: 'required',
          command: unitVitestScript,
          include: ['src/__tests__/**/*.test.ts'],
        },
      },
    },
    noCollectableWorkspace('project-context', 'packages/project-context'),
    requiredUnitWorkspace('@lizi/remote-file-service', 'packages/remote-file-service'),
    requiredUnitWorkspace('@lizi/voice-input-core', 'packages/voice-input-core'),
    noCollectableWorkspace('@cindy/device-link-protocol', 'cindy-protocol/packages/device-link-protocol'),
    requiredUnitWorkspace('@cindy/slack-hook-protocol', 'cindy-protocol/packages/slack-hook-protocol'),
  ],
};
