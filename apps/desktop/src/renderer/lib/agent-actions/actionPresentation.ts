import { truncateToolText, type ToolUseDescriptor } from '@lizi/maker-shared';

/** Lightweight human-readable parameter shared by full tool rows and live previews. */
export interface DisplayParam {
  text: string;
  fullTitle?: string;
}

export interface DisplayParamOptions {
  /** 工作动作行优先直显真实命令,不让模型 description 替代命令文本。 */
  preferRawCommand?: boolean;
}

/**
 * Tool input → concise human-readable label. Keeping this pure formatter shared
 * prevents the rolling live preview from drifting from AgentActionRow wording.
 *
 * - command with description: model-authored sentence, command kept as title;
 * - Codex command intent: intent target with the raw command/path in title;
 * - MCP / dynamic / collab: readable namespace and tool labels;
 * - file/search/web: the most useful target parameter.
 */
export function extractDisplayParam(
  descriptor: ToolUseDescriptor,
  options: DisplayParamOptions = {},
): DisplayParam | null {
  switch (descriptor.kind) {
    case 'command': {
      if (options.preferRawCommand && descriptor.command) {
        return {
          text: truncateToolText(descriptor.command, 60),
          fullTitle: descriptor.command,
        };
      }
      if (descriptor.description) {
        return {
          text: descriptor.description,
          ...(descriptor.command ? { fullTitle: descriptor.command } : {}),
        };
      }
      const intent = descriptor.intent;
      if (intent?.target && descriptor.command) {
        return {
          text: truncateToolText(intent.target, 60),
          fullTitle:
            intent.path && intent.path !== intent.target
              ? `${descriptor.command}\n${intent.path}`
              : descriptor.command,
        };
      }
      if (!descriptor.command) return null;
      return { text: truncateToolText(descriptor.command, 60), fullTitle: descriptor.command };
    }
    case 'file':
      return { text: descriptor.fileName, fullTitle: descriptor.filePath };
    case 'search':
      return { text: descriptor.pattern };
    case 'web':
      return { text: descriptor.target };
    case 'todo':
      return null;
    case 'task':
      return descriptor.description ? { text: descriptor.description } : null;
    case 'mcp':
      return {
        text: `${descriptor.serverLabel} · ${descriptor.toolLabel}`,
        fullTitle: descriptor.detail
          ? `${descriptor.toolName}\n${descriptor.detail}`
          : descriptor.toolName,
      };
    case 'dynamic':
      return {
        text: descriptor.namespace
          ? `${descriptor.namespace} · ${descriptor.toolLabel}`
          : descriptor.toolLabel,
        fullTitle: descriptor.detail
          ? `${descriptor.toolName}\n${descriptor.detail}`
          : descriptor.toolName,
      };
    case 'collab':
      return {
        text: descriptor.toolLabel,
        fullTitle: descriptor.detail
          ? `${descriptor.toolName}\n${descriptor.detail}`
          : descriptor.toolName,
      };
    case 'generic':
      return { text: descriptor.toolName };
  }
}
