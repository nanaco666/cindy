import { describe, expect, it } from 'vitest';

import { throwOrcaServiceFailure } from '../orcaServiceFailure';

describe('orca service failure IPC mapping', () => {
  it('maps Orca BUSY failures to SESSION_RUNNING instead of INTERNAL', () => {
    expect(() =>
      throwOrcaServiceFailure({
        ok: false,
        errorCode: 'BUSY',
        message: 'credential mode busy',
      }),
    ).toThrow(expect.objectContaining({ code: 'SESSION_RUNNING' }));
  });
});
