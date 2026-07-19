import { normalizeDisplayCommand } from '@lizi/maker-shared/command-display';

export interface CommandExecutionDisplayInput extends Record<string, unknown> {
  command: string;
  cwd?: string;
  displayCommand?: string;
  /** codex commandActions 原样透传（见 translator CommandExecutionItem 注释）。 */
  commandActions?: unknown[];
}

export function displayCommandForCommandExecution(command: string): string {
  return normalizeDisplayCommand(command) ?? command;
}

export function commandExecutionDisplayInput(command: string, cwd?: string): CommandExecutionDisplayInput {
  const displayCommand = displayCommandForCommandExecution(command);
  const input: CommandExecutionDisplayInput = { command };
  if (cwd !== undefined) input.cwd = cwd;
  if (displayCommand !== command) input.displayCommand = displayCommand;
  return input;
}
