# Harness Forge

**A recursive harness optimiser with the model frozen.**

Give it four underspecified briefs and a one line prompt. A fixed model scores 19.4 percent. Then a loop reads its own grader failures, rewrites the harness around the model, and the same frozen weights score 97.5 percent, including on a holdout set with values it has never seen.

This is a small, runnable take on [Harness²](https://github.com/google-research/harness2) (Google Research, arXiv 2610.14224), where the harness is everything around the model (system prompt, guardrails, tool guidance, memory, skills) and the weights never move.

<img width="2984" height="3232" alt="screencapture-localhost-5199-2026-10-18-23_15_49" src="https://github.com/user-attachments/assets/9867e512-f9c0-4bba-9503-a763cf7452c3" />
<img width="2984" height="2518" alt="screencapture-localhost-5199-2026-10-18-23_14_05" src="https://github.com/user-attachments/assets/ccf9a1fc-3e96-42c5-92ea-3f70a50cf9b2" />
<img width="2984" height="2514" alt="screencapture-localhost-5199-2026-10-18-23_14_26" src="https://github.com/user-attachments/assets/aad19e57-a2e1-48a7-bdeb-09b227e63397" />
<img width="1458" height="1248" alt="Screenshot at Oct 18 23-15-20" src="https://github.com/user-attachments/assets/bc35e9e3-6ce4-440c-a639-19715ffde8f0" />
<img width="2984" height="6672" alt="screencapture-localhost-5199-2026-10-18-23_15_26" src="https://github.com/user-attachments/assets/07f4b118-caf3-432f-9d2d-404206feb849" />
<img width="2984" height="2576" alt="screencapture-localhost-5199-2026-10-18-23_15_36" src="https://github.com/user-attachments/assets/6478872f-f572-4cd7-8aa8-52962b40cb2b" />


## Contents

- [Harness Forge](#harness-forge)
  - [Contents](#contents)
  - [The result](#the-result)
  - [Why it exists](#why-it-exists)
  - [Architecture](#architecture)
  - [Tech stack and why](#tech-stack-and-why)
  - [Code walkthrough](#code-walkthrough)
    - [The task contract](#the-task-contract)
    - [Turning the harness into a prompt](#turning-the-harness-into-a-prompt)
    - [The editor call](#the-editor-call)
    - [Elite selection](#elite-selection)
    - [The retry that saved the demo](#the-retry-that-saved-the-demo)
    - [Concurrency without a dependency grab bag](#concurrency-without-a-dependency-grab-bag)
  - [Project structure](#project-structure)
  - [The graded suite](#the-graded-suite)
  - [Scoring](#scoring)
  - [The holdout, or how this stays honest](#the-holdout-or-how-this-stays-honest)
  - [Differences from Harness²](#differences-from-harness)
  - [Run it](#run-it)
    - [Why there is a proxy](#why-there-is-a-proxy)
  - [Fork it and contribute](#fork-it-and-contribute)
    - [Adding a task](#adding-a-task)
    - [Pull request checklist](#pull-request-checklist)
  - [Troubleshooting](#troubleshooting)
  - [License](#license)

## The result

A recorded run, one command, real API calls, nothing cached. Model `deepseek-v41-flash-1017`, temperature 0 for every call.

| stage | score | what changed |
| --- | --- | --- |
| naked harness | **19.4%** | one line: "You are a helpful assistant" |
| after step 1 | **97.5%** | 8 guardrails, 4 skills, 3 lessons, all written from failure messages |
| after step 2 | 97.5% | nothing left to win, the composition tied and the incumbent was kept |
| holdout | **97.5%** | same rules, different values |

32 calls, 53k tokens in, 50k out, 70.8 seconds. The raw record, including every attempt and every harness version, is committed at `evidence/sample-run.json`.

The only task below 100 percent was the email, at 90: the model kept dropping the required signature. The reflector noticed and wrote "required literals are graded content and must be physically present," then on the next step, "use deterministic post-processing to append or verify required signatures instead of relying on prompt wording." That is the conclusion most harness engineers reach after a day of fiddling, and the loop reached it in two minutes from a failure string.

## Why it exists

My first suite was six tidy, fully specified tasks. A one line prompt scored **100 percent** on all of them, first try. Harness optimisation had nothing to do, and the demo was a flat line.

That is the finding, not a bug. On short, well specified work, a frontier model does not need a harness. Gains show up where real work lives: ambiguous briefs, house styles, format contracts that only exist in a grader, and long constraint lists where the tenth rule gets dropped.

So the briefs became underspecified on purpose. They read like a colleague's message. The house rules live in the grader, which is how a real eval or CI check works, and the editor only ever sees what the grader said went wrong.

**The harness is not where the intelligence is. It is where the compliance is.**

## Architecture

Two levels of recursion, as in the paper. Task level recursion happens inside a step; harnessing level recursion carries lessons across steps.

```
                         +---------------------------+
                         |  frozen model endpoint    |
                         |  OpenAI compatible, no    |
                         |  weight changes, temp 0   |
                         +-------------+-------------+
                                       ^
                                       | chat(messages)
+--------------------------+           |
|  src/tasks.ts            |    +------+---------------------------+
|  4 tasks x 2 fixtures    |    |  src/loop.ts                     |
|  public + holdout        |    |                                  |
|  grader: (raw, expected) |<---|  baseline -> step(k) -> holdout  |
|         -> {score, fails}|    |                                  |
+--------------------------+    |  step = PROPOSE -> PROBE ->      |
                                |         COMPOSE -> EVALUATE ->    |
                                |         REFLECT                  |
                                +------+---------------------------+
                                       |
                     reads/writes      |     evidence out
                +----------------------+-------------------+
                |                      |                   |
        +-------v-------+      +-------v------+    +-------v--------+
        | src/harness.ts|      | src/llm.ts   |    | React UI       |
        | composeMessages|     | fetch, retry |    | chart, trace,  |
        | mergeHarness  |      | pool()       |    | matrix, export |
        | diff, markdown|      +--------------+    +----------------+
        +---------------+
```

Inside one step:

```
              +------------------+     +------------------+
              | editor: invariant|     | editor: domain   |
              | (general habits) |     | (artifact rules) |
              +--------+---------+     +---------+--------+
                       |                       |
                       v                       v
              +------------------+     +------------------+
              | probe on 2 worst |     | probe on 2 worst |
              | tasks, for real  |     | tasks, for real  |
              +--------+---------+     +---------+--------+
                       |                       |
                       +-----------+-----------+
                                   v
                          +------------------+
                          | composer         |
                          | merge by evidence|
                          +--------+---------+
                                   v
                          +------------------+
                          | evaluate, full   |
                          | suite, real calls|
                          +--------+---------+
                                   v
                          +------------------+
                          | reflector        |
                          | lessons -> memory|
                          +------------------+
```

The request path at runtime:

```
browser --> POST /api/llm/chat/completions --> server.mjs or vite proxy --> provider
            (key in Authorization)              (no key stored)
```

## Tech stack and why

| layer | choice | why |
| --- | --- | --- |
| language | TypeScript 5.8, strict | the harness is a data structure, and a bad edit should fail at compile time |
| UI | React 19 + Vite 7 | no framework, no router, no state library; the whole app is one reducer-shaped component |
| chart | hand rolled SVG | a chart library is 100KB for one line chart with six points |
| styling | plain CSS with custom properties | one file, no build step, no utility class soup |
| model client | `fetch`, no SDK | works against any OpenAI compatible endpoint, including local servers |
| backend | `node:http` in `server.mjs` | serves `dist/` and forwards `/api/llm`; zero dependencies |
| tests | Vitest 3 | graders are pure functions, so testing them needs no browser and no network |
| E2E | Playwright against Chrome | the only way to prove CORS, clipboard and download paths work |
| persistence | `localStorage` | endpoint config belongs on the user's machine, not a database |

Deliberate non-choices: no Next.js (nothing needs SSR), no Tailwind (one screen), no ORM (no database), no telemetry (an eval tool that phones home is a liability).

## Code walkthrough

### The task contract

A task is a fixture pair plus a pure grader. That is the whole extension surface.

```ts
// src/types.ts
export interface TaskSpec {
  id: string;
  title: string;
  domain: string;
  /** What the grader would accept, shown in the UI so the loop is auditable. */
  contract: string;
  variants: Record<'public' | 'holdout', Fixture>;
  grade: (raw: string, expected: unknown) => Grade;
}
```

Graders return partial credit and specific failure text, because that text is the learning signal.

```ts
// src/tasks.ts, the invoice grader (abridged)
const failures: string[] = [];
exp.forEach((want, i) => {
  const item = (got as Record<string, unknown>[])[i];
  if (item.vendor === want.vendor) hits++;
  else failures.push(`row ${i + 1}: expected vendor ${want.vendor}, got ${JSON.stringify(item.vendor)}`);
  if (item.amountCents === want.amountCents) hits++;
  else failures.push(
    `row ${i + 1} (${want.vendor}): amountCents expected ${want.amountCents}, got ${JSON.stringify(item.amountCents)}`,
  );
});
return fail(hits / total, failures);
```

### Turning the harness into a prompt

The harness is not a string. It is five fields, composed in a fixed order so a change to one component is attributable.

```ts
// src/harness.ts
export function composeMessages(harness: Harness, taskInput: string) {
  const parts: string[] = [harness.systemPrompt.trim()];
  if (harness.guardrails.length) {
    parts.push('GUARDRAILS (must hold in every answer):\n' + harness.guardrails.map((g) => `- ${g}`).join('\n'));
  }
  if (harness.toolGuidance.trim()) parts.push('OUTPUT CONTRACT:\n' + harness.toolGuidance.trim());
  if (harness.skills.length) parts.push('SKILLS (apply when relevant):\n' + renderSkills(harness.skills));
  if (harness.memory.length) parts.push('MEMORY (lessons from earlier tasks):\n' + renderList(harness.memory));
  return [
    { role: 'system' as const, content: parts.filter(Boolean).join('\n\n') },
    { role: 'user' as const, content: taskInput },
  ];
}
```

### The editor call

Two editors run in parallel from the same incumbent, with different instructions. Both receive the failure evidence, the grader rule for each failing task, and the harness shape they must return.

```ts
// src/loop.ts, propose() (abridged)
const { content } = await call(
  [
    { role: 'system', content: `You are the harness editor in a recursive harness optimizer. ${editorRules}` },
    { role: 'user', content: `Current harness (score ${pct(currentScore)}):\n${harnessForPrompt(current)}

Failure evidence from the last evaluation:
${failingEvidence}

${focus}

Return the complete revised harness JSON now.` },
  ],
  4500,
  0.8,
  true,
);
```

`mergeHarness` then fills any component the model forgot, and caps every field so one runaway generation cannot blow the context window on the next call.

### Elite selection

A composition that measures worse than the incumbent is discarded, and the trace says so. Without this the curve is not monotonic and a run can end worse than it started.

```ts
// src/loop.ts
if (composedScore < currentScore) {
  emit({ type: 'log', level: 'warn', message: `composition regressed, incumbent kept at ${pct(currentScore)}` });
  composed = current;
  composedScore = currentScore;
  composedAttempts = currentAttempts;
}
```

### The retry that saved the demo

Reasoning models spend `max_tokens` on hidden tokens. An answer can come back empty with `finish_reason: length`, which looks like a model failure and is actually a budget failure.

```ts
// src/llm.ts
if (!content.trim()) {
  const hitCap = choice?.finish_reason === 'length';
  lastError = new Error(`empty completion (finish_reason: ${choice?.finish_reason ?? 'unknown'})`);
  if (hitCap && attempt < attempts) {
    maxTokens *= 3;
    continue;
  }
  throw lastError;
}
```

### Concurrency without a dependency grab bag

Every evaluation phase runs a small worker pool. Six in flight keeps a run under 90 seconds without hammering the provider.

```ts
// src/llm.ts
export async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const i = cursor++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}
```

## Project structure

```
harness-forge/
  src/
    types.ts        Harness, TaskSpec, Attempt, RunEvent, StepResult
    tasks.ts        nine graded tasks, four of them in the shipped suite
    harness.ts      prompt composition, merge, caps, diff, markdown export
    llm.ts          OpenAI compatible client, budget retry, worker pool
    loop.ts         baseline, propose, probe, compose, evaluate, reflect
    App.tsx         the whole UI: config, chart, steps, tabs, trace
    components/     ScoreChart, ScoreBars, TaskMatrix, HarnessView
    styles.css      dark instrument theme, one file
  scripts/
    run-loop.ts     headless runner, writes runs/<timestamp>.json
  tests/
    tasks.test.ts   45 checks: graders, parsers, merge, export
  server.mjs        static server plus /api/llm proxy
  RUNBOOK.md        run it on a fresh machine, copy and paste
  evidence/         screenshots and one recorded run
```

## The graded suite

Nine tasks are in the repo. Four ship in the default run, one per artifact type, because a single harness has to hold four contracts without turning into a wall of rules.

| task | artifact | what the grader enforces |
| --- | --- | --- |
| Ledger entry from a messy invoice folder | JSON array | dedupe, credit note exclusion, discount arithmetic, integer cents, due date sort |
| Repair a broken CSV export | delimited text | exact header, dedupe, numeric sort, two decimals, quote only when needed |
| Release notes in the house style | markdown | exact headings and order, one reference per bullet, chore exclusion, word caps, banned punctuation |
| Outreach email under a strict style contract | prose | subject and body word caps, exactly one question mark, banned openers, required figures, sign off |

Extra coverage, same file: mixed format date normalisation, order totals with tiered discounts, clause risk tiering, subscription payload assembly, and a customer incident update. `npm run loop -- --tasks 9` runs all of them.

Each task has two fixtures. `public` is used for the baseline, probes and step evaluation. `holdout` is used once, at the end, with the same rules and different values.

## Scoring

- Per task, 0 to 1. Structured tasks grade field by field, so a forgotten discount costs one field, not the whole task.
- Writing tasks grade an independent checklist, so an em dash costs one of eight checks.
- The suite score is the mean of task scores, which is what the chart plots.

Two rules keep the numbers meaningful: a near miss must score strictly below a pass, and an empty answer must score near zero. Both are asserted in `tests/tasks.test.ts`, because a grader that hands out free points makes the whole loop look better than it is.

## The holdout, or how this stays honest

The editor reads grader diffs. Those diffs contain expected values, because that is what a useful failure message looks like. So the loop can absolutely memorise: put yesterday's invoice amounts into the guardrails and the public score goes to 100.

The holdout is the answer. Same grader, same rules, different vendors, amounts, dates and names, run only at the end. A harness that learned rules transfers; one that learned answers collapses. The UI prints the gap before the tuned score:

- under 5 points: the rules transfer
- 5 to 15: partly memorised
- over 15: treat the tuned score as inflated

Without the holdout this is a benchmark gaming machine. With it, it is an instrument.

## Differences from Harness²

| Harness² | Harness Forge |
| --- | --- |
| three professional benchmarks, real executors (OpenCode, Codex) | a small graded suite, no code execution |
| eight editable components | five, the ones a single turn task can use |
| parallel and sequential recursion budgets | k steps, parallel candidates, elite selection |
| benchmark specific harness state | one harness per run, exportable as markdown |
| model credentials plus cloud tooling | any OpenAI compatible endpoint |

Faithful: fixed weights, edits driven by measured failures, propose, probe, compose, lessons carried across steps, and a score you can reproduce.

Not faithful: no tool loop, so subagents, scripts and plugins are out of scope. This is a lab instrument for understanding the mechanism, not a replacement for the research code.

## Run it

Moving this to a second machine? See [RUNBOOK.md](RUNBOOK.md) for the copy and paste version.

Prerequisites: Node 20 or newer.

```bash
npm install
npm run dev          # http://localhost:5199, proxy included
```

Production, one port:

```bash
npm run build
npm run serve        # http://localhost:8787
```

Headless, records a full run:

```bash
export HARNESS_API_KEY=...
npm run loop -- --k 2 --tasks 4 --probe 2
```

Checks:

```bash
npm run test         # 45 tests, no network
npm run typecheck
```

### Why there is a proxy

Particle, the default upstream, sends no CORS headers, so a browser cannot call it. `vite.config.ts` and `server.mjs` both forward `/api/llm/*` to the upstream using the browser's own `Authorization` header. The key is never stored server side.

| preset | base URL | note |
| --- | --- | --- |
| Particle (proxy) | `/api/llm` | default, model `deepseek-v41-flash-1017` |
| Gemini (direct) | `https://generativelanguage.googleapis.com/v1beta/openai` | allows browser calls |
| LM Studio | `http://localhost:1234/v1` | local, no key |
| Ollama | `http://localhost:11434/v1` | local, no key |

Endpoint config lives in `localStorage`. There is no backend config file and no env file for the app; environment variables are read only by the headless runner and the static server.

## Fork it and contribute

The interesting work is in making the loop smarter, not painting the UI. Every item below is scoped to a file and a rough size.

| feature | where | size | note |
| --- | --- | --- | --- |
| per task harnesses | `src/loop.ts` | M | run the recursion per task and share only `memory`, which is what the paper actually does |
| a real executor | `src/llm.ts` + new `src/tools.ts` | L | replace the single call with a tool loop, then tool guidance and scripts become editable components |
| sequential recursion mode | `src/loop.ts` | S | carry the refined harness through k steps instead of composing from parallel probes |
| cost aware objective | `src/loop.ts` | S | climb `score - lambda * tokens` and plot both, so a harness that gets quiet wins |
| harness seed import | `src/harness.ts`, `App.tsx` | S | paste an existing `harness.md` to start from your production prompt instead of the bare harness |
| more artifact types | `src/tasks.ts` | S each | a SQL query, a migration plan, a customer email in another language; two fixtures and one grader |
| two model race | `src/App.tsx` | M | same suite, same harness, two models side by side; answers the "is it the harness or the model" question |
| trace export | `App.tsx` | XS | download the run as JSON or the trace as text, for a bug report |

### Adding a task

1. Write the fixture pair in `src/tasks.ts`: a realistic brief, and expected values you computed independently.
2. Write `grade(raw, expected)` returning `{ score, passed, failures }` with failures specific enough to teach a rule.
3. Add it to `SUITE` if it should ship in the default run.
4. Add two assertions in `tests/tasks.test.ts`: a perfect answer scores 1, and a near miss scores strictly below 1. The generic tests pick up the rest.

Grader rules that keep this honest: never accept a superset (extra keys are failures), always report the expected value in the failure message, and use partial credit by field rather than by task.

### Pull request checklist

- `npm run test`, `npm run typecheck` and `npm run build` all pass.
- No network calls in tests. Graders are pure.
- No secrets, no absolute paths, no LAN IPs in defaults.
- New UI states get a screenshot in `evidence/` and a check at 420, 900 and 1500 px.
- Prose has no em or en dashes. Count them, do not eyeball.
- One language per project. TypeScript here, not TypeScript plus Python.

## Troubleshooting

| symptom | cause | fix |
| --- | --- | --- |
| `empty completion (finish_reason: length)` | reasoning model spent the budget on hidden tokens | the client retries with three times the budget twice; raise the cap in `src/llm.ts` if it persists |
| `401` from `/api/llm` | no key, or the proxy is not running | use `npm run dev` or `npm run serve`, then paste a key |
| `Failed to fetch` | opened `dist/index.html` directly, or called a provider with no CORS | serve it, never `file://` |
| every task at 0 with parse errors | the model wraps artifacts in prose | a legitimate failure; the loop learns the artifact-only rule from it |
| no score movement | the suite is too easy for the model | measure the baseline first; above 90 percent the demo has nothing to say |
| port 5199 or 8787 busy | both servers use strict ports | stop the other process, or `PORT=8788 npm run serve` |

## License

MIT. The ideas belong to the Harness² authors; this implementation is a teaching build.
