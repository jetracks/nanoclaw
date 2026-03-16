interface ShellCallRef {
  call_id?: string;
}

interface ShellCommandExecutionResult {
  stdout: string;
  stderr: string;
  outcome:
    | {
        type: 'exit';
        exit_code: number;
      }
    | {
        type: 'timeout';
      };
}

function truncateOutput(text: string, maxOutputLength?: number): string {
  if (
    typeof maxOutputLength !== 'number' ||
    maxOutputLength <= 0 ||
    text.length <= maxOutputLength
  ) {
    return text;
  }

  const suffix = '...[trunc]';
  if (maxOutputLength <= suffix.length) {
    return suffix.slice(0, maxOutputLength);
  }
  return `${text.slice(0, maxOutputLength - suffix.length)}${suffix}`;
}

export function resolveShellCallId(item: ShellCallRef): string {
  const shellCallId = item.call_id;

  if (!shellCallId) {
    throw new Error('Shell call is missing a call_id.');
  }

  return shellCallId;
}

export function createShellCallOutput(
  item: ShellCallRef,
  results: ShellCommandExecutionResult[],
  maxOutputLength?: number,
): Record<string, unknown> {
  return {
    type: 'shell_call_output',
    call_id: resolveShellCallId(item),
    output: results.map((result) => ({
      stdout: truncateOutput(result.stdout, maxOutputLength),
      stderr: truncateOutput(result.stderr, maxOutputLength),
      outcome: result.outcome,
    })),
    ...(typeof maxOutputLength === 'number'
      ? { max_output_length: maxOutputLength }
      : {}),
  };
}
