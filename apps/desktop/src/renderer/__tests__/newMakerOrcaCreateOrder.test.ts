import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const source = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'NewMakerDraftRoute.tsx'),
  'utf8',
);

describe('NewMakerDraftRoute Orca worker create order', () => {
  it('delegates worker creation to enableOrca and defers tab reveal until the new route is current', () => {
    const collabBranch = source.indexOf('if (effectiveCollabEnabled)');
    const enableOrca = source.indexOf('const result = await window.electronAPI.maker.enableOrca', collabBranch);
    const revealState = source.indexOf('orcaWorkersRevealState = { focusWorkerSessionId: result.workerSessionId };', enableOrca);
    const navigate = source.indexOf('navigate(orcaNavTarget ?? `/cc-agent/${newSession.id}`', revealState);

    expect(collabBranch).toBeGreaterThan(-1);
    expect(enableOrca).toBeGreaterThan(collabBranch);
    expect(revealState).toBeGreaterThan(enableOrca);
    expect(navigate).toBeGreaterThan(revealState);
    expect(source).toContain('state: orcaWorkersRevealState');
    expect(source).toContain('orcaWorkersReveal: orcaWorkersRevealState');
    expect(source).not.toContain('/cc-agent/orca/${newSession.id}');
    expect(source).not.toContain('workerAgent=${workerAgent}');
    expect(source).not.toContain('window.electronAPI.localDb.orcaWorkflows.addWorker');
    expect(source).not.toContain('markOrcaRole(worker.sessionId');
  });

  it('uses the shared collaboration error i18n mapper for both draft enable paths', () => {
    const mappedFallbacks = source.match(/getCollaborationStartErrorMessage\(err, t, \{ continueAsSingleSession: true \}\)/g) ?? [];

    expect(mappedFallbacks).toHaveLength(2);
    expect(source).not.toContain("toast.error(t('newChat.collaboration.startFailed'");
  });
});
