import { chat, parseJsonObject, pool } from './llm.ts';
import { BASELINE_HARNESS, mergeHarness } from './harness.ts';
import { composeMessages } from './harness.ts';
import type {
  Attempt,
  CandidateResult,
  Harness,
  LLMConfig,
  RunEvent,
  RunResult,
  StepResult,
  TaskSpec,
  Usage,
  Variant,
} from './types.ts';

export interface RunOptions {
  cfg: LLMConfig;
  tasks: TaskSpec[];
  /** task level recursion budget */
  k: number;
  /** how many tasks each candidate is probed on */
  probeSize: number;
  concurrency: number;
  /** hard stop on total tokens, protects the wallet on a long run */
  tokenBudget: number;
  includeHoldout: boolean;
  signal?: AbortSignal;
  onEvent?: (event: RunEvent) => void;
}

const HARNESS_SHAPE = `{
  "systemPrompt": string,
  "guardrails": string[],
  "toolGuidance": string,
  "skills": [{"name": string, "steps": string[]}],
  "memory": string[]
}`;

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function evidence(attempts: Attempt[], tasks: TaskSpec[], limit = 6): string {
  const failed = attempts.filter((a) => !a.passed).sort((a, b) => a.score - b.score);
  if (!failed.length) return 'No failures. Every task passed.';
  return failed
    .slice(0, limit)
    .map((a) => {
      const task = tasks.find((t) => t.id === a.taskId);
      const head = `${a.taskId} (score ${a.score.toFixed(2)}):`;
      const body = a.error ? a.error : a.failures.slice(0, 3).join('; ');
      const rule = task ? `\n    grader rule: ${task.contract}` : '';
      return `- ${head} ${body}${rule}`;
    })
    .join('\n');
}

function harnessForPrompt(h: Harness): string {
  return JSON.stringify(h, null, 2);
}

export function scoreOf(attempts: Attempt[]): number {
  return mean(attempts.map((a) => a.score));
}

export async function runLoop(opts: RunOptions): Promise<RunResult> {
  const { cfg, tasks, k, probeSize, concurrency, tokenBudget, includeHoldout, signal } = opts;
  const emit = (e: RunEvent) => opts.onEvent?.(e);
  const usage: Usage = { promptTokens: 0, completionTokens: 0, calls: 0 };
  const startedAt = new Date().toISOString();
  const t0 = performance.now();

  const charge = (promptTokens: number, completionTokens: number) => {
    usage.promptTokens += promptTokens;
    usage.completionTokens += completionTokens;
    usage.calls += 1;
    if (usage.promptTokens + usage.completionTokens > tokenBudget) {
      throw new Error(
        `token budget of ${tokenBudget.toLocaleString()} exhausted after ${usage.calls} calls; raise it in the run settings`,
      );
    }
  };

  async function call(messages: { role: string; content: string }[], maxTokens: number, temperature: number, json = false) {
    const res = await chat(cfg, messages, { maxTokens, temperature, json, signal });
    charge(res.promptTokens, res.completionTokens);
    return res;
  }

  async function evaluate(harness: Harness, variant: Variant, subset: TaskSpec[]): Promise<Attempt[]> {
    return pool(subset, concurrency, async (task) => {
      const fixture = task.variants[variant];
      const callStarted = performance.now();
      try {
        const res = await call(composeMessages(harness, fixture.input), 5000, cfg.temperature, false);
        const grade = task.grade(res.content, fixture.expected);
        const attempt: Attempt = {
          taskId: task.id,
          variant,
          raw: res.content,
          score: grade.score,
          passed: grade.passed,
          failures: grade.failures,
          tokens: res.promptTokens + res.completionTokens,
          ms: performance.now() - callStarted,
        };
        emit({ type: 'attempt', attempt });
        return attempt;
      } catch (err) {
        if (signal?.aborted) throw err;
        return {
          taskId: task.id,
          variant,
          raw: '',
          score: 0,
          passed: false,
          failures: [`call failed: ${(err as Error).message}`],
          error: (err as Error).message,
          tokens: 0,
          ms: performance.now() - callStarted,
        };
      }
    });
  }

  /* ---------------- 1. baseline ---------------- */
  emit({ type: 'phase', phase: 'baseline', detail: 'the naked harness, no help' });
  const baselineAttempts = await evaluate(BASELINE_HARNESS, 'public', tasks);
  const baselineScore = scoreOf(baselineAttempts);
  emit({ type: 'baseline', score: baselineScore, attempts: baselineAttempts });
  emit({
    type: 'log',
    level: 'info',
    message: `baseline ${(baselineScore * 100).toFixed(1)}% with ${baselineAttempts.filter((a) => a.passed).length}/${tasks.length} tasks fully passed`,
  });

  let current: Harness = structuredClone(BASELINE_HARNESS);
  let currentAttempts = baselineAttempts;
  let currentScore = baselineScore;
  const steps: StepResult[] = [];

  /* ---------------- 2. recursion steps ---------------- */
  for (let step = 1; step <= k; step++) {
    const stepStart = performance.now();
    emit({ type: 'phase', phase: `step ${step}/${k}`, detail: 'propose, probe, compose' });

    const ranked = [...currentAttempts].sort((a, b) => a.score - b.score);
    const probeIds = new Set(ranked.slice(0, Math.max(1, probeSize)).map((a) => a.taskId));
    const probeTasks = tasks.filter((t) => probeIds.has(t.id));
    const domains = [...new Set(probeTasks.map((t) => t.domain))].join(', ');
    const failingEvidence = evidence(currentAttempts, tasks);

    const editorRules = `The model is frozen: its weights, provider and temperature cannot change. You can only edit the harness.
Return the COMPLETE harness as JSON in exactly this shape, no prose:
${HARNESS_SHAPE}
Rules:
- Keep every element that is already working. Do not rewrite for style.
- The grader rules in the evidence are conventions, not answers. Every key name, column name, heading, section order, limit and banned character they name MUST appear verbatim in the harness, scoped to the artifact type it belongs to. A harness that says "follow the requested format" has learned nothing.
- Encode procedure and format, never fixture data: no vendor or customer names, no amounts, no dates, no answers copied from the expected values.
- Good guardrail: "Ledger requests: one JSON array sorted by due date, objects with exactly vendor, amountCents, currency, dueDate, amounts as integer cents." Bad guardrail: "return the format the request asks for."
- Maximum 8 guardrails, maximum 4 skills with at most 6 steps each. Use skills for multi-step procedures and guardrails for hard constraints.
- Every guardrail must be an instruction the model can obey while answering, e.g. "return only the requested artifact, with no preamble".`;

    const propose = async (kind: 'invariant' | 'domain'): Promise<CandidateResult> => {
      const focus =
        kind === 'invariant'
          ? `Propose invariant edits: general habits that would prevent this class of failure on ANY analytical task (output discipline, verification steps, arithmetic and format checks).`
          : `Propose domain edits: a concrete checklist for work of this kind (${domains}), aimed at the specific failure patterns in the evidence.`;
      const { content } = await call(
        [
          { role: 'system', content: `You are the harness editor in a recursive harness optimizer. ${editorRules}` },
          {
            role: 'user',
            content: `Current harness (score ${(currentScore * 100).toFixed(1)}%):
${harnessForPrompt(current)}

Failure evidence from the last evaluation:
${failingEvidence}

${focus}

Return the complete revised harness JSON now.`,
          },
        ],
        4500,
        0.8,
        true,
      );
      const harness = mergeHarness(current, parseJsonObject(content));
      const probeAttempts = await evaluate(harness, 'public', probeTasks);
      const probeScore = scoreOf(probeAttempts);
      emit({ type: 'log', level: probeScore >= currentScore ? 'good' : 'warn', message: `${kind} candidate probes at ${(probeScore * 100).toFixed(1)}% on ${probeTasks.length} task(s)` });
      return { kind, harness, probeScore, probeAttempts, rationale: focus };
    };

    const settled = await Promise.allSettled([propose('invariant'), propose('domain')]);
    const candidates: CandidateResult[] = settled
      .filter((s): s is PromiseFulfilledResult<CandidateResult> => s.status === 'fulfilled')
      .map((s) => s.value);
    for (const failure of settled) {
      if (failure.status === 'rejected') {
        emit({ type: 'log', level: 'warn', message: `a candidate failed: ${(failure.reason as Error).message}` });
      }
    }
    if (!candidates.length) throw new Error('both harness candidates failed; check the endpoint and model name');
    for (const c of candidates) emit({ type: 'candidate', result: c });

    emit({ type: 'phase', phase: `step ${step}/${k}`, detail: 'compose' });
    const best = [...candidates].sort((a, b) => b.probeScore - a.probeScore)[0];
    let composed: Harness;
    try {
      const { content } = await call(
        [
          {
            role: 'system',
            content: `You are the harness composer in a recursive harness optimizer. Merge candidate harnesses into one. ${editorRules}`,
          },
          {
            role: 'user',
            content: `Current harness (score ${(currentScore * 100).toFixed(1)}%):
${harnessForPrompt(current)}

Candidate A, invariant edits, probe score ${(candidates.find((c) => c.kind === 'invariant')?.probeScore ?? 0) * 100}%:
${harnessForPrompt(candidates.find((c) => c.kind === 'invariant')?.harness ?? current)}

Candidate B, domain edits, probe score ${(candidates.find((c) => c.kind === 'domain')?.probeScore ?? 0) * 100}%:
${harnessForPrompt(candidates.find((c) => c.kind === 'domain')?.harness ?? current)}

Probe evidence:
${evidence(candidates.flatMap((c) => c.probeAttempts), tasks, 8)}

Compose the single best harness for this step. Keep an edit only if the evidence supports it. When two edits conflict or scores tie, prefer the shorter, more general harness. Then return the complete harness JSON.`,
          },
        ],
        4500,
        0.4,
        true,
      );
      composed = mergeHarness(current, parseJsonObject(content));
    } catch (err) {
      emit({ type: 'log', level: 'warn', message: `composer failed (${(err as Error).message}); falling back to the best candidate` });
      composed = best.harness;
    }

    emit({ type: 'phase', phase: `step ${step}/${k}`, detail: 'evaluate composed harness' });
    let composedAttempts = await evaluate(composed, 'public', tasks);
    let composedScore = scoreOf(composedAttempts);
    emit({
      type: 'log',
      level: composedScore > currentScore ? 'good' : composedScore === currentScore ? 'info' : 'warn',
      message: `step ${step} composed harness scores ${(composedScore * 100).toFixed(1)}% (was ${(currentScore * 100).toFixed(1)}%)`,
    });

    // Elite selection: a composition that measures worse than the incumbent is
    // discarded, and the log says so. Nothing is adopted on a hunch.
    if (composedScore < currentScore) {
      emit({
        type: 'log',
        level: 'warn',
        message: `composition regressed, incumbent kept at ${(currentScore * 100).toFixed(1)}%`,
      });
      composed = current;
      composedScore = currentScore;
      composedAttempts = currentAttempts;
    }

    emit({ type: 'phase', phase: `step ${step}/${k}`, detail: 'reflect' });
    let lessons: string[] = [];
    try {
      const { content } = await call(
        [
          {
            role: 'system',
            content: `You are the experience reflector in a recursive harness optimizer. You do not write the harness. You write the lessons that make the NEXT harness edit better. Return JSON only: {"lessons": string[]}.`,
          },
          {
            role: 'user',
            content: `Score before the step: ${(currentScore * 100).toFixed(1)}%. Score after composing: ${(composedScore * 100).toFixed(1)}%.
Remaining failures:
${evidence(composedAttempts, tasks)}

Write at most 3 lessons about how to edit harnesses for this kind of work: what moved the score, what did not, and what to try next. Each lesson is one sentence of at most 25 words, no task names, no amounts.`,
          },
        ],
        1200,
        0.5,
        true,
      );
      const parsed = parseJsonObject(content);
      const raw = Array.isArray(parsed.lessons) ? parsed.lessons : [];
      lessons = raw
        .filter((l): l is string => typeof l === 'string' && l.trim().length > 0)
        .slice(0, 3)
        .map((l) => l.trim().replace(/\s+/g, ' '));
    } catch (err) {
      emit({ type: 'log', level: 'warn', message: `reflector failed: ${(err as Error).message}` });
    }

    if (lessons.length) {
      const existing = new Set(composed.memory.map((m) => m.toLowerCase()));
      const merged = [...composed.memory, ...lessons.filter((l) => !existing.has(l.toLowerCase()))].slice(-10);
      composed = { ...composed, memory: merged };
    }

    const stepResult: StepResult = {
      step,
      candidates,
      composed: { harness: composed, score: composedScore, attempts: composedAttempts, tokens: composedAttempts.reduce((n, a) => n + a.tokens, 0) },
      lessons,
      harness: composed,
      elapsedMs: performance.now() - stepStart,
    };
    steps.push(stepResult);
    emit({ type: 'step', result: stepResult });

    current = composed;
    currentAttempts = composedAttempts;
    currentScore = composedScore;
  }

  /* ---------------- 3. holdout ---------------- */
  let holdoutAttempts: Attempt[] = [];
  if (includeHoldout) {
    emit({ type: 'phase', phase: 'holdout', detail: 'same rules, unseen values' });
    holdoutAttempts = await evaluate(current, 'holdout', tasks);
  }

  const result: RunResult = {
    baseline: { harness: structuredClone(BASELINE_HARNESS), score: baselineScore, attempts: baselineAttempts },
    steps,
    finalHarness: current,
    tuned: { score: currentScore, attempts: currentAttempts },
    holdout: { score: scoreOf(holdoutAttempts), attempts: holdoutAttempts },
    usage,
    startedAt,
    elapsedMs: performance.now() - t0,
  };
  emit({ type: 'done', result });
  return result;
}
