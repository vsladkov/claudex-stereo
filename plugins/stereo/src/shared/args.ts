export interface ParseArgsConfig {
  valueOptions?: readonly string[];
  arrayOptions?: readonly string[];
  booleanOptions?: readonly string[];
  aliasMap?: Readonly<Record<string, string>>;
}

export type ParsedOptionValue = string | string[] | boolean;

export interface ParsedArgs {
  options: Record<string, ParsedOptionValue>;
  positionals: string[];
}

export function parseArgs(argv: readonly string[], config: ParseArgsConfig = {}): ParsedArgs {
  const valueOptions = new Set(config.valueOptions ?? []);
  const arrayOptions = new Set(config.arrayOptions ?? []);
  const booleanOptions = new Set(config.booleanOptions ?? []);
  const aliasMap = config.aliasMap ?? {};
  const options: Record<string, ParsedOptionValue> = {};
  const positionals: string[] = [];
  let passthrough = false;

  const appendArrayOption = (key: string, value: string): void => {
    const current = options[key];
    options[key] = Array.isArray(current) ? [...current, value] : [value];
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) {
      continue;
    }

    if (passthrough) {
      positionals.push(token);
      continue;
    }

    if (token === '--') {
      passthrough = true;
      continue;
    }

    if (!token.startsWith('-') || token === '-') {
      positionals.push(token);
      continue;
    }

    if (token.startsWith('--')) {
      const [rawKey = '', inlineValue] = token.slice(2).split('=', 2);
      const key = aliasMap[rawKey] ?? rawKey;

      if (booleanOptions.has(key)) {
        options[key] = inlineValue === undefined ? true : inlineValue !== 'false';
        continue;
      }

      if (arrayOptions.has(key)) {
        const nextValue = inlineValue ?? argv[index + 1];
        if (nextValue === undefined || (inlineValue === undefined && looksLikeFlag(nextValue))) {
          throw new Error(`Missing value for --${rawKey}`);
        }
        appendArrayOption(key, nextValue);
        if (inlineValue === undefined) {
          index += 1;
        }
        continue;
      }

      if (valueOptions.has(key)) {
        const nextValue = inlineValue ?? argv[index + 1];
        if (nextValue === undefined || (inlineValue === undefined && looksLikeFlag(nextValue))) {
          throw new Error(`Missing value for --${rawKey}`);
        }
        options[key] = nextValue;
        if (inlineValue === undefined) {
          index += 1;
        }
        continue;
      }

      positionals.push(token);
      continue;
    }

    const shortKey = token.slice(1);
    const key = aliasMap[shortKey] ?? shortKey;

    if (booleanOptions.has(key)) {
      options[key] = true;
      continue;
    }

    if (arrayOptions.has(key)) {
      const nextValue = argv[index + 1];
      if (nextValue === undefined || looksLikeFlag(nextValue)) {
        throw new Error(`Missing value for -${shortKey}`);
      }
      appendArrayOption(key, nextValue);
      index += 1;
      continue;
    }

    if (valueOptions.has(key)) {
      const nextValue = argv[index + 1];
      if (nextValue === undefined || looksLikeFlag(nextValue)) {
        throw new Error(`Missing value for -${shortKey}`);
      }
      options[key] = nextValue;
      index += 1;
      continue;
    }

    positionals.push(token);
  }

  return { options, positionals };
}

// A value option must never silently swallow the next flag as its value:
// `status abc --timeout-ms --json` would otherwise set timeout-ms='--json'
// (NaN, silent default) AND lose the JSON request. Only double-dash tokens
// count as flags — single-dash prose values (`-leading-dash` risks) and
// negative numbers stay legal, and a genuine `--`-leading value can always
// use the inline `--option=value` form, which skips this guard.
function looksLikeFlag(token: string): boolean {
  return /^--[a-zA-Z]/.test(token);
}

export function splitRawArgumentString(raw: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: string | null = null;
  let escaping = false;

  for (const character of raw) {
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }

    if (character === '\\') {
      escaping = true;
      continue;
    }

    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }

    if (/\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += character;
  }

  if (escaping) {
    current += '\\';
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}
