/**
 * effortResolution —— 「选中模型 / 切换来源后应落到哪一档 effort」的纯逻辑(跨端共享)。
 *
 * 从 apps/desktop renderer 的 sourceSwitch.ts 原样下沉:桌面 ModelSelector / ChatInput 与
 * 手机版模型选择列表都要用同一套落档优先级,避免两端各写一套后口径发散(手机对齐桌面的
 * 「逻辑完全相同」承诺依赖这里的单一实现)。语义与函数签名保持与桌面历史版本逐字一致。
 *
 * 类型注:参数用 `string` 而非本包的 `Effort` 字面量联合 —— 桌面 renderer 的 Effort 就是
 * `string` 别名(userPreferences.types),catalog 侧才是严格联合;两端都要直接消费本函数,
 * 取二者的公共形状。运行时语义只依赖「候选值 ∈ efforts」的成员判断,与联合收窄无关。
 */

type Effort = string;

/**
 * 解析「选中某模型后应落到哪一档 effort」—— 纯函数,集中 effort 优先级策略。
 *
 * 优先级(高 → 低),每一档都要求候选值仍在 `efforts` 列表里(不同模型 effort 档不同,旧值可能非法):
 *   0. 模型无 effort 档(efforts 为空)→ 'low'(占位,UI 不显示 effort segmented)。
 *   1. preferred:切来源时由 resolveSourceSwitch 带回的落点 hint(目标来源 lastModel 的 effort)。
 *   2. providerEffort:调用方提供的模型预设(桌面端现为 (agent, model) 全局预设;参数名为兼容保留)。
 *   3. rememberedEffort:per-model 记忆(provider 无关,跨来源兜底;手机端无此存储,恒不传)。
 *   4. activeEffort:当前 effort 仍被目标模型支持 → 沿用(切模型时少打扰用户)。
 *   5. 模型默认 defaultEffort(仍需 ∈ efforts;非法/缺失时落 efforts 首档)。
 *
 * 注:之所以用代码而非 prompt 固化这套优先级(规则 9),是为了让「选回来恢复上次选择」可预测、
 * 可单测。本函数只负责「在给定 efforts 下挑哪一档」,模型 efforts 由调用方按 catalog 提供。
 */
export function resolveEffort(args: {
  efforts: readonly Effort[];
  defaultEffort: Effort | null;
  activeEffort: Effort;
  preferred?: Effort;
  providerEffort?: Effort;
  rememberedEffort?: Effort;
}): Effort {
  const { efforts, defaultEffort, activeEffort, preferred, providerEffort, rememberedEffort } = args;
  if (efforts.length === 0) return 'low';
  const ok = (e: Effort | undefined): e is Effort => !!e && efforts.includes(e);
  if (ok(preferred)) return preferred;
  if (ok(providerEffort)) return providerEffort;
  if (ok(rememberedEffort)) return rememberedEffort;
  if (efforts.includes(activeEffort)) return activeEffort;
  // defaultEffort 同样要求 ∈ efforts(catalog 病态数据防御):非法/缺失时落 efforts 首档,
  // efforts.length === 0 已在上方 early return,这里 efforts[0] 必然存在。
  if (ok(defaultEffort ?? undefined)) return defaultEffort as Effort;
  return efforts[0];
}

/**
 * 「同模型只切来源」时落档。与 resolveEffort 的关键区别是没有 activeEffort 沿用档:
 * 有显式模型预设就按目标来源支持范围恢复;没有预设则回落模型默认,避免把当前会话 live 值
 * 意外写成全局默认。
 *
 * 优先级(高 → 低,每档都要求仍在 efforts 内):
 *   1. preferred:来源切换 hint(resolveSourceSwitch 带回的目标来源记忆档);当前 picker 行点击
 *      不传,保留以兼容未来带 hint 的调用方。
 *   2. providerEffort:调用方提供的模型预设(桌面端跨来源共享,再由 efforts 校验是否合法)。
 *   3. 模型默认 defaultEffort。
 *   4. efforts 首档。
 *   5. fallbackEffort:efforts 为空等极端兜底(通常 = 当前 activeEffort,该模型无 effort 档、UI 不显示)。
 */
export function resolveProviderSwitchEffort(args: {
  efforts: readonly Effort[];
  defaultEffort: Effort | null;
  providerEffort?: Effort;
  preferred?: Effort;
  fallbackEffort: Effort;
}): Effort {
  const { efforts, defaultEffort, providerEffort, preferred, fallbackEffort } = args;
  if (efforts.length === 0) return fallbackEffort;
  const ok = (e: Effort | undefined): e is Effort => !!e && efforts.includes(e);
  if (ok(preferred)) return preferred;
  if (ok(providerEffort)) return providerEffort;
  if (ok(defaultEffort ?? undefined)) return defaultEffort as Effort;
  return efforts[0];
}
