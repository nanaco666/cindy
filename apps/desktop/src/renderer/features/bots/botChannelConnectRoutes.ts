/** 「个人」分区里每张手风琴卡的 id(与 ImBotSection 的 expandedChannel 同一套)。 */
export type ImBotPersonalChannelId =
  'wechat' | 'wecom' | 'feishu' | 'discord' | 'telegram' | 'dingtalk';

/** `?imChannel=` 的解析(设置页消费)。未知值一律 `null`,不抛。 */
export function parseImBotPersonalChannel(
  value: string | null | undefined,
): ImBotPersonalChannelId | null {
  return value === 'wechat' ||
    value === 'wecom' ||
    value === 'feishu' ||
    value === 'discord' ||
    value === 'telegram' ||
    value === 'dingtalk'
    ? value
    : null;
}
