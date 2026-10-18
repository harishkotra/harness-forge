import { describe, expect, it } from 'vitest';
import type { ChangelogExpected, EmailExpected, IncidentExpected } from '../src/tasks.ts';
import { TASKS, deepEqual, extractJson, invoiceTask } from '../src/tasks.ts';
import { BASELINE_HARNESS, composeMessages, diffHarness, harnessToMarkdown, mergeHarness } from '../src/harness.ts';

function perfectChangelog(e: ChangelogExpected) {
  const fixed = e.refs.filter((r) => r !== e.breakingRef && !e.addedRefs.includes(r));
  return `## Breaking
- ${e.breakingRef} requires ${e.breakingMustMention} on every deployment
## Added
- ${e.addedRefs[0]} adds the new export control
- ${e.addedRefs[1]} adds shortcuts to the queue view
## Fixed
- ${fixed[0]} stops duplicate deliveries on retry
- ${fixed[1]} fixes timezone drift in the digest
- ${fixed[2]} fixes a crash when filters return nothing`;
}

function perfectIncident(e: IncidentExpected) {
  const [r1, r2] = e.regions;
  const [p1, p2] = e.allowedPercents;
  const [t0, t1, t2, t3, t4, t5] = e.allowedTimestamps;
  return `## Summary
Customers in ${r1} and ${r2} saw failed requests after a bad change.
## Impact
Requests failed at ${p1} in ${r1} and ${r2}, returning to ${p2} after the revert.
## Timeline
- ${t0} change shipped
- ${t1} error rate rose to ${p1}
- ${t2} on-call paged
- ${t3} reverted to the previous version
- ${t4} error rate returned to ${p2}
## What we are doing
We reverted the change, verified recovery, and are adding a pre-flight check.
## Next update
The next update will be at ${t5}.`;
}

function perfectEmail(e: EmailExpected) {
  const [from, to] = e.mustInclude;
  return `Subject: Cut month end from ${from}

The pilot cut invoice reconciliation from ${from} to ${to} per month end. Worth a 20 minute call next week to see if it fits your pipeline?

Harish`;
}

/** A perfect answer for a fixture, the way a careful model would write it. */
function perfectAnswer(taskId: string, expected: unknown): string {
  if (taskId === 'csv') return String(expected);
  if (taskId === 'risk') {
    const rows = (expected as { id: string; tier: string }[]).map((r) => ({ id: r.id, tier: r.tier, reason: 'rubric trigger matched' }));
    return '```json\n' + JSON.stringify(rows, null, 2) + '\n```';
  }
  if (taskId === 'changelog') return perfectChangelog(expected as ChangelogExpected);
  if (taskId === 'incident') return perfectIncident(expected as IncidentExpected);
  if (taskId === 'email') return perfectEmail(expected as EmailExpected);
  return 'Here is the result:\n```json\n' + JSON.stringify(expected, null, 2) + '\n```';
}

describe('task suite', () => {
  for (const task of TASKS) {
    for (const variant of ['public', 'holdout'] as const) {
      it(`${task.id} ${variant}: the expected value passes its own grader`, () => {
        const grade = task.grade(perfectAnswer(task.id, task.variants[variant].expected), task.variants[variant].expected);
        expect(grade.failures).toEqual([]);
        expect(grade.score).toBe(1);
        expect(grade.passed).toBe(true);
      });

      it(`${task.id} ${variant}: an empty answer scores near zero`, () => {
        const grade = task.grade('I am not sure about this one.', task.variants[variant].expected);
        const ceiling = ['changelog', 'incident', 'email'].includes(task.id) ? 0.35 : 0;
        expect(grade.score).toBeLessThanOrEqual(ceiling);
        expect(grade.failures.length).toBeGreaterThan(0);
      });
    }
  }

  it('public and holdout fixtures are genuinely different', () => {
    for (const task of TASKS) {
      expect(task.variants.public.input).not.toEqual(task.variants.holdout.input);
      // Tier assignments can legitimately repeat across variants; the values must not.
      if (task.id !== 'risk') {
        expect(JSON.stringify(task.variants.public.expected)).not.toEqual(JSON.stringify(task.variants.holdout.expected));
      }
    }
  });

  it('a near miss is scored strictly below a pass', () => {
    const expected = structuredClone(invoiceTask.variants.public.expected) as {
      vendor: string;
      amountCents: number;
      currency: string;
      dueDate: string;
    }[];
    const nearMiss = structuredClone(expected) as { amountCents: number }[];
    nearMiss[1].amountCents = nearMiss[1].amountCents + 100; // forgot the discount
    const grade = invoiceTask.grade(JSON.stringify(nearMiss), expected);
    expect(grade.passed).toBe(false);
    expect(grade.score).toBeGreaterThan(0.7);
    expect(grade.score).toBeLessThan(1);
    expect(grade.failures.join(' ')).toContain(String(nearMiss[1].amountCents));
  });
});

describe('parsing helpers', () => {
  it('extracts JSON out of prose and fences', () => {
    expect(extractJson('sure:\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('noise [1,2,3] noise')).toEqual([1, 2, 3]);
  });

  it('compares objects regardless of key order', () => {
    expect(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
  });
});

describe('harness plumbing', () => {
  it('keeps components the model forgot to return', () => {
    const prev = { ...BASELINE_HARNESS, guardrails: ['no preamble'] };
    const merged = mergeHarness(prev, { systemPrompt: 'new' });
    expect(merged.guardrails).toEqual(['no preamble']);
    expect(merged.systemPrompt).toBe('new');
  });

  it('caps runaway components', () => {
    const merged = mergeHarness(BASELINE_HARNESS, {
      systemPrompt: 'x'.repeat(9000),
      guardrails: Array.from({ length: 40 }, (_, i) => `rule ${i}`),
      skills: Array.from({ length: 30 }, (_, i) => ({ name: `s${i}`, steps: ['a'] })),
    });
    expect(merged.systemPrompt.length).toBe(4000);
    expect(merged.guardrails.length).toBe(20);
    expect(merged.skills.length).toBe(8);
  });

  it('reports which components actually changed', () => {
    const next = { ...BASELINE_HARNESS, guardrails: ['return JSON only'] };
    const diff = diffHarness(BASELINE_HARNESS, next);
    expect(diff.find((d) => d.component === 'guardrails')?.changed).toBe(true);
    expect(diff.find((d) => d.component === 'skills')?.changed).toBe(false);
  });

  it('puts the harness in front of the task', () => {
    const harness = { ...BASELINE_HARNESS, guardrails: ['no prose'], memory: ['verify cents'] };
    const messages = composeMessages(harness, 'do the thing');
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('no prose');
    expect(messages[0].content).toContain('verify cents');
    expect(messages[1].content).toBe('do the thing');
  });

  it('exports a portable harness document', () => {
    const md = harnessToMarkdown({ ...BASELINE_HARNESS, guardrails: ['no prose'] }, { model: 'm', score: 0.8, holdout: 0.7, steps: 2 });
    expect(md).toContain('# Agent harness');
    expect(md).toContain('- no prose');
    expect(md).toContain('80.0%');
  });
});
