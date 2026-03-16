import { describe, expect, it } from 'vitest';

import {
  createShellCallOutput,
  resolveShellCallId,
} from './local-shell-call-output.js';

describe('local-shell-call-output', () => {
  it('formats shell call output using the call_id', () => {
    expect(
      createShellCallOutput(
        { call_id: 'shell_123' },
        [
          {
            stdout: 'ok',
            stderr: '',
            outcome: { type: 'exit', exit_code: 0 },
          },
        ],
      ),
    ).toEqual({
      type: 'shell_call_output',
      call_id: 'shell_123',
      output: [
        {
          stdout: 'ok',
          stderr: '',
          outcome: { type: 'exit', exit_code: 0 },
        },
      ],
    });
  });

  it('applies max_output_length truncation when requested', () => {
    expect(
      createShellCallOutput(
        { call_id: 'shell_123' },
        [
          {
            stdout: 'abcdefghijklmnopqrstuvwxyz',
            stderr: '',
            outcome: { type: 'exit', exit_code: 0 },
          },
        ],
        10,
      ),
    ).toEqual({
      type: 'shell_call_output',
      call_id: 'shell_123',
      max_output_length: 10,
      output: [
        {
          stdout: '...[trunc]',
          stderr: '',
          outcome: { type: 'exit', exit_code: 0 },
        },
      ],
    });
  });

  it('returns the shell call id', () => {
    expect(resolveShellCallId({ call_id: 'shell_123' })).toBe('shell_123');
  });
});
