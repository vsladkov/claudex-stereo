import { readJsonFile } from '../shared/fs.ts';
import type { TurnCaptureState } from './turn-capture.ts';

export interface StructuredOutputFallback {
  status?: number;
  failureMessage?: string | null;
  [key: string]: unknown;
}

export interface StructuredOutputResult extends StructuredOutputFallback {
  parsed: unknown;
  parseError: string | null;
  rawOutput: string;
}

export function buildResultStatus(turnState: TurnCaptureState): number {
  return turnState.finalTurn?.status === 'completed' ? 0 : 1;
}

export function parseStructuredOutput(
  rawOutput: string | null | undefined,
  fallback: StructuredOutputFallback = {},
): StructuredOutputResult {
  // fallback supplies defaults (status, failureMessage); spread it first so
  // it can never clobber the computed parse outcome.
  if (!rawOutput) {
    return {
      ...fallback,
      parsed: null,
      parseError: fallback.failureMessage ?? 'Codex did not return a final structured message.',
      rawOutput: rawOutput ?? '',
    };
  }

  try {
    return {
      ...fallback,
      parsed: JSON.parse(rawOutput),
      parseError: null,
      rawOutput,
    };
  } catch (error) {
    return {
      ...fallback,
      parsed: null,
      parseError: (error as SyntaxError).message,
      rawOutput,
    };
  }
}

export function readOutputSchema(schemaPath: string): unknown {
  return readJsonFile(schemaPath);
}
