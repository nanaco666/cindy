// coverage checker self-test 专用 fixture(不进正式测试树:根编排为显式文件清单+workspace include,不收本目录)
import { describe, expect, it } from 'vitest';

describe('coverage fixture suite', () => {
  it('passes one', () => {
    expect(1 + 1).toBe(2);
  });
  it('passes two', () => {
    expect('cindy'.length).toBe(5);
  });
});
