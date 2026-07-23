// coverage checker self-test 专用 fixture:同名用例 ×2,用于「testId 重名 → 败」负例
import { describe, expect, it } from 'vitest';

describe('coverage dup suite', () => {
  it('same name', () => {
    expect(true).toBe(true);
  });
  it('same name', () => {
    expect(1).toBe(1);
  });
});
