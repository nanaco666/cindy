interface ShellToken {
  text: string;
  end: number;
}

interface PosixShellToken extends ShellToken {
  /** True when at least one part of the shell word was quoted. */
  quoted: boolean;
  /** Literal characters outside quotes make a wrapper script ambiguous. */
  hasUnquotedLiteral: boolean;
}

export interface CommandExecutionDisplayInput extends Record<string, unknown> {
  command: string;
  cwd?: string;
  displayCommand?: string;
  /** codex commandActions 原样透传（见 translator CommandExecutionItem 注释）。 */
  commandActions?: unknown[];
}

function readShellToken(input: string, start: number): ShellToken | null {
  let index = start;
  while (index < input.length && /\s/.test(input[index])) index += 1;
  if (index >= input.length) return null;

  const quote = input[index];
  if (quote === '"' || quote === "'") {
    index += 1;
    let text = '';
    while (index < input.length) {
      const ch = input[index];
      if (ch === quote) {
        if (quote === "'" && input[index + 1] === "'") {
          text += "'";
          index += 2;
          continue;
        }
        return { text, end: index + 1 };
      }
      if (quote === '"' && ch === '\\' && input[index + 1] === '"') {
        text += '"';
        index += 2;
        continue;
      }
      if (quote === '"' && ch === '`' && input[index + 1] === quote) {
        text += input[index + 1];
        index += 2;
        continue;
      }
      text += ch;
      index += 1;
    }
    return null;
  }

  const tokenStart = index;
  while (index < input.length && !/\s/.test(input[index])) index += 1;
  return { text: input.slice(tokenStart, index), end: index };
}

function readPowerShellCommandArgument(input: string, start: number): ShellToken | null {
  let index = start;
  while (index < input.length && /\s/.test(input[index])) index += 1;
  if (index >= input.length) return { text: '', end: input.length };
  const token = readShellToken(input, index);
  if (input[index] === '"' || input[index] === "'") return token;
  return { text: input.slice(index).trim(), end: input.length };
}

/**
 * Read one POSIX shell word and apply the quoting rules needed by Codex's
 * `/bin/zsh -lc '<script>'` wrapper. Shell words may concatenate quoted and
 * unquoted fragments, so this also handles the common `'can'\''t'` form.
 */
function readPosixShellToken(input: string, start: number): PosixShellToken | null {
  let index = start;
  while (index < input.length && /\s/.test(input[index])) index += 1;
  if (index >= input.length) return null;

  let text = '';
  let quoted = false;
  let hasUnquotedLiteral = false;
  while (index < input.length && !/\s/.test(input[index])) {
    const ch = input[index];
    if (ch === "'") {
      quoted = true;
      index += 1;
      while (index < input.length && input[index] !== "'") {
        text += input[index];
        index += 1;
      }
      if (index >= input.length) return null;
      index += 1;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      index += 1;
      while (index < input.length && input[index] !== '"') {
        if (input[index] === '\\') {
          const next = input[index + 1];
          if (next === undefined) return null;
          if (next === '$' || next === '`' || next === '"' || next === '\\' || next === '\n') {
            if (next === '\n') {
              index += 2;
              continue;
            }
            text += next;
            index += 2;
            continue;
          }
        }
        text += input[index];
        index += 1;
      }
      if (index >= input.length) return null;
      index += 1;
      continue;
    }
    if (ch === '\\') {
      const next = input[index + 1];
      if (next === undefined) return null;
      if (next !== '\n') text += next;
      index += 2;
      continue;
    }
    hasUnquotedLiteral = true;
    text += ch;
    index += 1;
  }
  return { text, end: index, quoted, hasUnquotedLiteral };
}

function isWindowsPowerShellWrapperExecutable(binary: string): boolean {
  if (!/(?:^|[\\/])(?:pwsh|powershell)\.exe$/i.test(binary)) return false;
  return /^[A-Za-z]:[\\/]/.test(binary) || /^[\\/]{2}/.test(binary) || /[\\/]WindowsApps[\\/]/i.test(binary);
}

function isPosixShellWrapperExecutable(binary: string): boolean {
  return /^(?:(?:\/bin|\/usr\/bin|\/usr\/local\/bin)\/)?(?:zsh|bash|sh)$/.test(binary);
}

function displayCommandFromPosixShellWrapper(command: string): string | null {
  const executable = readPosixShellToken(command, 0);
  if (!executable || !isPosixShellWrapperExecutable(executable.text)) return null;

  const option = readPosixShellToken(command, executable.end);
  if (!option || (option.text !== '-lc' && option.text !== '-c')) return null;

  const script = readPosixShellToken(command, option.end);
  // Requiring a quoted script avoids misreading `sh -c echo; destructive` as
  // one wrapper invocation. Codex's generated wrappers always quote this arg.
  if (!script?.quoted || script.hasUnquotedLiteral || !script.text) return null;
  if (command.slice(script.end).trim()) return null;
  return script.text;
}

export function displayCommandForCommandExecution(command: string): string {
  const posixDisplayCommand = displayCommandFromPosixShellWrapper(command);
  if (posixDisplayCommand !== null) return posixDisplayCommand;

  const executable = readShellToken(command, 0);
  if (!executable || !isWindowsPowerShellWrapperExecutable(executable.text)) return command;

  let index = executable.end;
  while (true) {
    const token = readShellToken(command, index);
    if (!token) return command;
    if (/^-(?:command|c)$/i.test(token.text)) {
      const displayCommand = readPowerShellCommandArgument(command, token.end);
      if (!displayCommand) return command;
      if (command.slice(displayCommand.end).trim()) return command;
      return displayCommand.text || command;
    }
    index = token.end;
  }
}

export function commandExecutionDisplayInput(command: string, cwd?: string): CommandExecutionDisplayInput {
  const displayCommand = displayCommandForCommandExecution(command);
  const input: CommandExecutionDisplayInput = { command };
  if (cwd !== undefined) input.cwd = cwd;
  if (displayCommand !== command) input.displayCommand = displayCommand;
  return input;
}
