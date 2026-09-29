import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_ROOT = path.join(ROOT, 'plugins', 'stereo');

function read(relativePath: string): string {
  return fs.readFileSync(path.join(PLUGIN_ROOT, relativePath), 'utf8');
}

// Structural wiring only. Prose is deliberately unpinned: regex-freezing doc
// sentences preserved stale text (a pinned README example once asserted a
// model name that no longer existed) while taxing every legitimate edit.

test('the command surface is exactly the fifteen stereo commands', () => {
  const commandFiles = fs.readdirSync(path.join(PLUGIN_ROOT, 'commands')).sort();
  assert.deepEqual(commandFiles, [
    'adversarial-review.md',
    'cancel.md',
    'config.md',
    'doctor.md',
    'implement.md',
    'plan-state.md',
    'plan.md',
    'quick.md',
    'rescue.md',
    'result.md',
    'review.md',
    'setup.md',
    'status.md',
    'tournament.md',
    'transfer.md',
  ]);
});

test('every command wires the companion entry point it documents', () => {
  const wiring: Record<string, RegExp | RegExp[]> = {
    'adversarial-review.md': /codex-companion\.ts" adversarial-review <reviewArgs> <focusFileArg>/,
    'cancel.md':
      /codex-companion\.ts" cancel --args-stdin <<'STEREO_ARGS_Q7X2'\n\$ARGUMENTS\nSTEREO_ARGS_Q7X2\n/,
    'config.md':
      /codex-companion\.ts" config --args-stdin <<'STEREO_ARGS_Q7X2'\n\$ARGUMENTS\nSTEREO_ARGS_Q7X2\n/,
    'doctor.md': /codex-companion\.ts" doctor --json <doctorFlags>/,
    'implement.md': [
      /plan-state --json <slotArg>/,
      /implement-state --record --state-file '<statePayloadFile>' --json <slotArg>/,
      /implement-state --json/,
    ],
    'plan-state.md': [
      /codex-companion\.ts" plan-state\b/,
      /plan-state --list/,
      /plan-state --compare/,
      /plan-state --clear/,
      /plan-state --mark-implemented/,
    ],
    'plan.md': [
      /plan-state --metadata --json <slotArg>/,
      /plan-state --json <slotArg>/,
      /plan-store --json/,
    ],
    'quick.md': [
      /plan-state --metadata --json <slotArg>/,
      /plan-state --mark-implemented --json <slotArg>/,
    ],
    'rescue.md': /task-resume-candidate --json/,
    'result.md':
      /codex-companion\.ts" result --args-stdin <<'STEREO_ARGS_Q7X2'\n\$ARGUMENTS\nSTEREO_ARGS_Q7X2\n/,
    'review.md': /codex-companion\.ts" review <reviewArgs> <focusFileArg>/,
    'setup.md': /codex-companion\.ts" setup --json <setupFlags>/,
    'status.md':
      /codex-companion\.ts" status --args-stdin <<'STEREO_ARGS_Q7X2'\n\$ARGUMENTS\nSTEREO_ARGS_Q7X2\n/,
    'tournament.md': [
      /plan-state --json <slotArg>/,
      /tournament-state --record --state-file '<statePayloadFile>'/,
      /tournament-state --json/,
    ],
    'transfer.md':
      /codex-companion\.ts" transfer --args-stdin <<'STEREO_ARGS_Q7X2'\n\$ARGUMENTS\nSTEREO_ARGS_Q7X2\n/,
  };
  for (const [file, required] of Object.entries(wiring)) {
    const source = read(path.join('commands', file));
    assert.match(source, /codex-companion\.ts/, `${file} must reference the companion entry point`);
    for (const token of Array.isArray(required) ? required : [required]) {
      assert.match(source, token, `${file} runtime wiring drifted`);
    }
  }
});

test('raw slash-command arguments reach the companion only through a quoted stdin heredoc', () => {
  // `$ARGUMENTS` is substituted as literal text, so it must never sit in a shell
  // string: its own line inside a heredoc with a quoted delimiter keeps every
  // character (an apostrophe, `$`, a backtick) away from the shell.
  for (const file of fs.readdirSync(path.join(PLUGIN_ROOT, 'commands'))) {
    const lines = read(path.join('commands', file)).split('\n');
    for (const [index, line] of lines.entries()) {
      if (!line.includes('$ARGUMENTS') || !lines[index - 1]?.includes('codex-companion.ts')) {
        continue;
      }
      assert.equal(line, '$ARGUMENTS', `${file}:${index + 1}`);
      assert.match(
        lines[index - 1] as string,
        /--args-stdin <<'STEREO_ARGS_Q7X2'$/,
        `${file}:${index}`,
      );
      assert.equal(lines[index + 1], 'STEREO_ARGS_Q7X2', `${file}:${index + 2}`);
    }
    for (const [index, line] of lines.entries()) {
      if (line.includes('codex-companion.ts')) {
        assert.doesNotMatch(line, /\$ARGUMENTS/, `${file}:${index + 1}`);
      }
    }
  }
});

test('the review commands compose one foreground and one background companion line', () => {
  for (const file of ['adversarial-review.md', 'review.md']) {
    const lines = read(path.join('commands', file))
      .split('\n')
      .filter((line) => line.startsWith('node ') && line.includes('codex-companion.ts'));
    assert.equal(lines.length, 2, `${file} has one foreground and one background line`);
    for (const line of lines) {
      assert.match(line, /<reviewArgs>( --background)? <focusFileArg>$/, file);
    }
  }
});

test('every command disables model invocation of the command file', () => {
  for (const file of fs.readdirSync(path.join(PLUGIN_ROOT, 'commands'))) {
    assert.match(read(path.join('commands', file)), /^disable-model-invocation:\s*true$/m, file);
  }
});

const ROUTING_DIR = path.join('skills', 'model-routing');

// Companion invocations, list-indented or not, without the entry-point prefix.
function nodeLines(source: string): string[] {
  return source
    .split('\n')
    .map((line) => line.trimStart())
    .filter((line) => line.startsWith('node ') && line.includes('codex-companion.ts'))
    .map((line) =>
      line.replace(/^node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/codex-companion\.ts" /, ''),
    );
}

test('the routing files keep the shared job protocol and launch wiring', () => {
  const routing = read(path.join(ROUTING_DIR, 'SKILL.md'));
  const planProcedures = read(path.join(ROUTING_DIR, 'plan-procedures.md'));
  const implementProcedures = read(path.join(ROUTING_DIR, 'implement-procedures.md'));
  const worktreeProcedure = read(path.join(ROUTING_DIR, 'worktree-procedure.md'));

  // One job protocol for both runtimes: a bounded brief poll, then one full result fetch.
  assert.deepEqual(nodeLines(routing), [
    'config --json',
    'status <jobId> --wait --timeout-ms 90000 --brief',
    'result <jobId> --json',
  ]);
  // Named Claude roles are companion jobs; no Agent-tool template remains.
  assert.match(routing, /\|\s*`claude:<family>\[-<version>\]`\s*\|/);
  assert.match(routing, /\|\s*`claude:session`\s*\|/);
  assert.match(
    routing,
    /--role <planner\|implementer\|plan-reviewer\|implementation-reviewer\|reviewer\|adversarial-reviewer>/,
  );
  for (const file of fs.readdirSync(path.join(PLUGIN_ROOT, ROUTING_DIR))) {
    const source = read(path.join(ROUTING_DIR, file));
    for (const removed of [/subagent_type/, /run_in_background/, /\|\s*`claude:inherit`\s*\|/]) {
      assert.doesNotMatch(source, removed, file);
    }
  }

  // The planner draft, its retry, both plan-review rounds, and the canonical inline
  // persist, which reads the plan from stdin, names no thread (plan-store takes
  // none), and delivers every metadata array by its own file.
  const planLines = nodeLines(planProcedures);
  assert.deepEqual(planLines.slice(0, 4), [
    "task --background --json <plannerSelectionArgs> --prompt-file '<payloadFile>'",
    "task --background --json --thread <plannerThreadId> <plannerSelectionArgs> --prompt-file '<retryPayloadFile>'",
    "plan-review --background --json --round 1 <slotArg> <reviewSelectionArgs> --plan-file '<payloadFile>'",
    "plan-review --background --json --thread <planReviewThreadId> --round <n> <slotArg> <reviewSelectionArgs> --plan-file '<payloadFile>'",
  ]);
  assert.equal(planLines.length, 5);
  const persist = planLines[4] ?? '';
  assert.match(persist, /^plan-store .* < '<payloadFile>'$/);
  assert.doesNotMatch(persist, /--(no-)?thread\b/);
  for (const flag of [
    '--summary-file',
    '--findings-file',
    '--open-questions-file',
    '--residual-risks-file',
  ]) {
    assert.match(persist, new RegExp(`${flag} '<[A-Za-z]+PayloadFile>'`), flag);
  }

  // Every implementer turn and every implementation review replays its pinned
  // launch arguments, with the worktree flags on the command line beside them;
  // the review keeps runtime schema enforcement.
  assert.deepEqual(
    nodeLines(implementProcedures).filter((line) => line.includes('--background')),
    [
      "task --background --json --write --launch-args-file '<launchArgsFile>' <isolationArgs> --prompt-file '<payloadFile>'",
      "task --background --json --write --thread <implementationThreadId> --launch-args-file '<launchArgsFile>' <isolationArgs> --prompt-file '<payloadFile>'",
      "task --background --json --launch-args-file '<reviewLaunchArgsFile>' --output-schema \"${CLAUDE_PLUGIN_ROOT}/schemas/implementation-review-output.schema.json\" <isolationArgs> --prompt-file '<payloadFile>'",
    ],
  );

  // Isolated worktrees are created and removed by the companion's worktree subcommand.
  assert.deepEqual(nodeLines(worktreeProcedure), [
    "worktree create --main '<mainRoot>' --json",
    "worktree remove --main '<mainRoot>' --path '<worktreePath>' --json",
  ]);
  assert.match(worktreeProcedure, /git -C '<mainRoot>' apply --3way --check '<patchFile>'/);
  assert.match(worktreeProcedure, /--cwd '<worktreePath>' --workspace '<mainRoot>'/);
});

test('pair commands keep their durable-state wiring and cite every launch', () => {
  const plan = read('commands/plan.md');
  const implement = read('commands/implement.md');
  const quick = read('commands/quick.md');
  const tournament = read('commands/tournament.md');

  assert.deepEqual(
    nodeLines(plan).filter((line) => line.startsWith('plan-store')),
    [
      "plan-store --json <slotArg> --verdict 'draft' --round 0 --summary-file '<summaryPayloadFile>' < '<payloadFile>'",
    ],
    'Plan keeps only its draft-only store, delivered by stdin redirect',
  );
  for (const action of ['record', 'update', 'complete']) {
    assert.match(
      implement,
      new RegExp(`implement-state --${action} --state-file '<statePayloadFile>'`),
    );
  }
  assert.match(implement, /implement-state --clear --json/);
  assert.doesNotMatch(tournament, /implement-state --record/);
  assert.doesNotMatch(quick, /plan-store --json/);

  for (const [file, source] of [
    ['plan.md', plan],
    ['implement.md', implement],
    ['quick.md', quick],
    ['tournament.md', tournament],
  ] as const) {
    const allowedTools = source.match(/^allowed-tools:.*$/m)?.[0] ?? '';
    assert.match(allowedTools, /\bWrite\b/, file);
    // The orchestrator never edits: Claude writes stay in the contained implementer role.
    assert.doesNotMatch(allowedTools, /\bEdit\b/, file);
    if (file !== 'plan.md') {
      assert.match(allowedTools, /Bash\(npm:\*\)/, file);
    }
    // Every draft, review, and implementer launch is cited from the procedures.
    assert.equal(
      nodeLines(source).filter((line) => line.includes('--background')).length,
      0,
      `${file} cites every background launch from the procedures`,
    );
    // Effort is per role on the pair commands.
    assert.doesNotMatch(
      source.match(/^argument-hint:.*$/m)?.[0] ?? '',
      /\[--effort <effort>\]/,
      `${file} has no command-wide --effort`,
    );
  }

  for (const [file, brief] of [
    ['review.md', 'review.md'],
    ['adversarial-review.md', 'adversarial-review.md'],
  ] as const) {
    const source = read(path.join('commands', file));
    assert.match(source.replace(/\s+/g, ' '), /"Standalone review procedure"/, file);
    assert.match(source, new RegExp(`prompts/${brief.replace('.', '\\.')}`), file);
    assert.match(source, /schemas\/review-output\.schema\.json/, file);
    // The review commands pre-approve only `gh pr view` and the read-only git
    // subcommands their procedure runs, never the whole of `gh` or `git`.
    const allowedTools = source.match(/^allowed-tools:.*$/m)?.[0] ?? '';
    assert.match(allowedTools, /Bash\(gh pr view:\*\)/, file);
    assert.doesNotMatch(allowedTools, /Bash\((gh|git):\*\)/, file);
    for (const rule of allowedTools.matchAll(/Bash\(git ([a-z-]+)[^)]*\)/g)) {
      assert.ok(
        [
          'status',
          'diff',
          'log',
          'show',
          'rev-parse',
          'check-ref-format',
          'show-ref',
          'symbolic-ref',
        ].includes(rule[1] ?? ''),
        `${file}: ${rule[0]} is not a read subcommand the review procedure runs`,
      );
    }
  }
  const reviewProcedure = read(path.join(ROUTING_DIR, 'review-procedure.md'));
  assert.match(
    reviewProcedure,
    /gh pr view '<n>' --json number,headRefName,headRefOid,baseRefName,state,url/,
  );
  assert.match(reviewProcedure, /git rev-parse --verify 'origin\/<baseRefName>\^\{commit\}'/);
});

test('every quoted routing heading resolves in a routing file its reader loads', () => {
  const routingFiles = fs
    .readdirSync(path.join(PLUGIN_ROOT, ROUTING_DIR))
    .filter((file) => file.endsWith('.md'))
    .sort();
  assert.deepEqual(routingFiles, [
    'SKILL.md',
    'implement-procedures.md',
    'pair-procedures.md',
    'plan-procedures.md',
    'review-procedure.md',
    'worktree-procedure.md',
  ]);
  const headings = new Map(
    routingFiles.map((file) => [
      file,
      new Set(
        [...read(path.join(ROUTING_DIR, file)).matchAll(/^#{1,6} (.+)$/gm)].map((match) =>
          (match[1] ?? '').trim(),
        ),
      ),
    ]),
  );
  // No heading is defined twice, so a citation names exactly one section.
  const allHeadings = routingFiles.flatMap((file) => [...(headings.get(file) ?? [])]);
  assert.deepEqual(
    allHeadings.filter((heading, index) => allHeadings.indexOf(heading) !== index),
    [],
  );
  // A citation is a capitalized phrase in double quotes ("Launch errors"),
  // possibly wrapped across lines; code such as "${CLAUDE_PLUGIN_ROOT}/..."
  // or "Bash(npm test)" never matches.
  const citations = (source: string): string[] => [
    ...new Set(
      [...source.replace(/\s+/g, ' ').matchAll(/"([A-Z][A-Za-z-]*(?: [A-Za-z-]+)*)"/g)].map(
        (match) => match[1] ?? '',
      ),
    ),
  ];
  const assertResolves = (label: string, source: string, readable: readonly string[]): void => {
    const available = new Set(readable.flatMap((file) => [...(headings.get(file) ?? [])]));
    for (const citation of citations(source)) {
      assert.ok(
        available.has(citation),
        `${label} cites "${citation}", which is not a heading of ${readable.join(' or ')}`,
      );
    }
  };

  // Which routing files each routed command reads (worktree-procedure.md only
  // for an isolated run in implement and quick, always in tournament).
  const readers: Record<string, readonly string[]> = {
    'plan.md': ['SKILL.md', 'pair-procedures.md', 'plan-procedures.md'],
    'implement.md': [
      'SKILL.md',
      'pair-procedures.md',
      'implement-procedures.md',
      'worktree-procedure.md',
    ],
    'quick.md': [
      'SKILL.md',
      'pair-procedures.md',
      'plan-procedures.md',
      'implement-procedures.md',
      'worktree-procedure.md',
    ],
    'tournament.md': [
      'SKILL.md',
      'pair-procedures.md',
      'implement-procedures.md',
      'worktree-procedure.md',
    ],
    'review.md': ['review-procedure.md'],
    'adversarial-review.md': ['review-procedure.md'],
  };
  for (const file of fs.readdirSync(path.join(PLUGIN_ROOT, 'commands'))) {
    const source = read(path.join('commands', file));
    const readable = routingFiles.filter((routingFile) =>
      source.includes(`skills/model-routing/${routingFile}`),
    );
    assert.deepEqual(readable, [...(readers[file] ?? [])].sort(), `${file} routing files`);
    assertResolves(`commands/${file}`, source, readable);
  }
  // Each second-tier file cites only what its readers also load; the
  // implementation procedures cite the worktree procedure for isolated mode only.
  const secondTier: Record<string, readonly string[]> = {
    'pair-procedures.md': ['SKILL.md', 'pair-procedures.md'],
    'plan-procedures.md': ['SKILL.md', 'pair-procedures.md', 'plan-procedures.md'],
    'implement-procedures.md': [
      'SKILL.md',
      'pair-procedures.md',
      'implement-procedures.md',
      'worktree-procedure.md',
    ],
    'worktree-procedure.md': [
      'SKILL.md',
      'pair-procedures.md',
      'implement-procedures.md',
      'worktree-procedure.md',
    ],
    'review-procedure.md': ['review-procedure.md'],
    'SKILL.md': routingFiles.filter((file) => file !== 'review-procedure.md'),
  };
  for (const [file, readable] of Object.entries(secondTier)) {
    assertResolves(file, read(path.join(ROUTING_DIR, file)), readable);
  }
});

test('pair commands fill the canonical role briefs', () => {
  const planProcedures = read(path.join(ROUTING_DIR, 'plan-procedures.md'));
  const implementProcedures = read(path.join(ROUTING_DIR, 'implement-procedures.md'));
  const tournament = read('commands/tournament.md');

  // The planner and plan-review briefs are filled once, in the plan procedures;
  // plan and quick each supply their own size contract.
  assert.match(planProcedures, /prompts\/plan-draft\.md/);
  assert.match(planProcedures, /prompts\/plan-review\.md/);
  assert.match(planProcedures, /schemas\/plan-review-output\.schema\.json/);
  for (const token of [
    '{{TASK_TEXT}}',
    '{{SIZE_CONTRACT}}',
    '{{PLAN_INPUT}}',
    '{{ROUND_NUMBER}}',
    '{{REVISION_CONTEXT}}',
    '{{REPO_MAP}}',
  ]) {
    assert.equal(planProcedures.includes(token), true, `the plan procedures fill ${token}`);
  }
  for (const file of ['plan.md', 'quick.md']) {
    assert.equal(read(path.join('commands', file)).includes('{{SIZE_CONTRACT}}'), true, file);
  }

  // The implementation-review brief is filled in the implementation
  // procedures; the per-contestant (tournament) fill is its own.
  assert.match(implementProcedures, /prompts\/implementation-review\.md/);
  assert.match(implementProcedures, /schemas\/implementation-review-output\.schema\.json/);
  for (const [file, source] of [
    ['tournament.md', tournament],
    ['implement-procedures.md', implementProcedures],
  ] as const) {
    for (const token of [
      '{{PLAN_INPUT}}',
      '{{BASELINE_CONTEXT}}',
      '{{REVIEW_CONTEXT}}',
      '{{HOST_RESULTS}}',
      '{{GRANTED_COMMANDS}}',
    ]) {
      assert.equal(source.includes(token), true, `${file} must name the ${token} fill`);
    }
  }
});

test('role definitions live outside agents/ and keep their tool and output contracts', () => {
  // Claude Code registers every agents/*.md as an Agent type; the six roles
  // run only as companion jobs, so only the rescue bridge lives there.
  assert.deepEqual(fs.readdirSync(path.join(PLUGIN_ROOT, 'agents')).sort(), ['codex-rescue.md']);
  const roles = [
    'adversarial-reviewer',
    'implementation-reviewer',
    'implementer',
    'plan-reviewer',
    'planner',
    'reviewer',
  ];
  assert.deepEqual(
    fs.readdirSync(path.join(PLUGIN_ROOT, 'roles')).sort(),
    roles.map((role) => `${role}.md`),
  );
  for (const role of roles) {
    const frontmatter = read(`roles/${role}.md`).match(/^---\n[\s\S]*?\n---/)?.[0] ?? '';
    // Model and effort are pinned per run by the companion, never by the role.
    assert.doesNotMatch(frontmatter, /^(model|effort):/m, role);
    assert.match(
      frontmatter,
      role === 'implementer'
        ? /^tools:\s*Read, Glob, Grep, Edit, Write, Bash$/m
        : /^tools:\s*Read, Glob, Grep, Bash$/m,
      role,
    );
  }
  for (const [role, schema] of [
    ['plan-reviewer', 'plan-review-output'],
    ['implementation-reviewer', 'implementation-review-output'],
    ['reviewer', 'review-output'],
    ['adversarial-reviewer', 'review-output'],
  ] as const) {
    assert.match(read(`roles/${role}.md`), new RegExp(`schemas/${schema}\\.schema\\.json`), role);
    assert.doesNotThrow(() => JSON.parse(read(`schemas/${schema}.schema.json`)));
  }

  const rescueAgent = read('agents/codex-rescue.md');
  assert.match(rescueAgent, /^tools:\s*Read, Bash$/m);
  const rescueFrontmatter = rescueAgent.match(/^---\n[\s\S]*?\n---/)?.[0] ?? '';
  for (const skill of ['codex-cli-runtime', 'codex-prompting', 'codex-result-handling']) {
    assert.match(rescueFrontmatter, new RegExp(`^  - ${skill}$`, 'm'));
  }
});

test('rescue routes through the subagent transport, never Skill recursion', () => {
  const rescue = read('commands/rescue.md');
  // Regression for #234: `Skill(stereo:rescue)` from the main agent recursed
  // because rescue.md named the routing with ambiguous prose while running
  // under `context: fork` — forked general-purpose subagents do not expose
  // the `Agent` tool, so the fork fell back to `Skill` and re-entered this
  // command. Pin the explicit transport and the inline (no-fork) execution.
  assert.match(rescue, /subagent_type: "stereo:codex-rescue"/);
  assert.match(rescue, /do not call `Skill\(stereo:codex-rescue\)`/i);
  assert.doesNotMatch(rescue, /^context:\s*fork\b/m);
  // The forwarder passes flags as arguments and the task text on stdin, never
  // inside a shell string.
  const runtime = read('skills/codex-cli-runtime/SKILL.md');
  assert.match(runtime, /^node .*codex-companion\.ts" task <taskFlags> <<'STEREO_EOF'$/m);
  assert.match(runtime, /^STEREO_EOF$/m);
  assert.doesNotMatch(runtime, /task "<raw arguments>"/);
});

test('hooks keep session-end cleanup and stop gating enabled', () => {
  const source = read('hooks/hooks.json');
  assert.match(source, /SessionStart/);
  assert.match(source, /SessionEnd/);
  assert.match(source, /stop-review-gate-hook\.cjs/);
  assert.match(source, /session-lifecycle-hook\.cjs/);

  const hooks = JSON.parse(source) as {
    hooks: {
      SessionStart: Array<{ hooks?: Array<{ timeout: number }> }>;
      SessionEnd: Array<{ hooks?: Array<{ timeout: number }> }>;
    };
  };
  const sessionStart = hooks.hooks.SessionStart.flatMap((entry) => entry.hooks ?? [])[0];
  const sessionEnd = hooks.hooks.SessionEnd.flatMap((entry) => entry.hooks ?? [])[0];
  assert.ok(sessionStart);
  assert.ok(sessionEnd);
  assert.equal(sessionStart.timeout, 5);
  // The SessionEnd hook only starts the sweep.
  assert.equal(sessionEnd.timeout, 5);
});

test('only the rescue bridge still launches an agent; every other command is companion-only', () => {
  const commandDir = path.join(PLUGIN_ROOT, 'commands');
  for (const file of fs.readdirSync(commandDir).filter((name) => name.endsWith('.md'))) {
    const source = read(path.join('commands', file));
    const allowedTools = source.match(/^allowed-tools:.*$/m)?.[0] ?? '';
    if (file === 'rescue.md') {
      assert.match(allowedTools, /\bAgent\b/, file);
      assert.match(source, /subagent_type: "stereo:codex-rescue"/, file);
      continue;
    }
    assert.doesNotMatch(allowedTools, /\bAgent\b/, file);
    assert.doesNotMatch(source, /subagent_type|run_in_background/, file);
  }
});
