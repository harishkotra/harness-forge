import type { Harness, Skill } from './types.ts';

/**
 * The starting harness. Deliberately thin: an identity and nothing else.
 * Everything a task needs (format contract, rules, checklists, edge cases) is
 * missing, which is exactly the headroom the loop has to work with.
 */
export const BASELINE_HARNESS: Harness = {
  systemPrompt: 'You are a helpful assistant. Answer the user accurately.',
  guardrails: [],
  toolGuidance: '',
  skills: [],
  memory: [],
};

export const COMPONENT_LABELS: Record<keyof Harness, string> = {
  systemPrompt: 'System prompt',
  guardrails: 'Guardrails',
  toolGuidance: 'Tool guidance',
  skills: 'Skills',
  memory: 'Memory',
};

const CAPS: Record<string, number> = {
  systemPrompt: 4000,
  toolGuidance: 3000,
  guardrails: 3000,
  skills: 6000,
  memory: 2000,
};

export function composeMessages(harness: Harness, taskInput: string) {
  const parts: string[] = [harness.systemPrompt.trim()];

  if (harness.guardrails.length) {
    parts.push('GUARDRAILS (must hold in every answer):\n' + harness.guardrails.map((g) => `- ${g}`).join('\n'));
  }
  if (harness.toolGuidance.trim()) {
    parts.push('OUTPUT CONTRACT:\n' + harness.toolGuidance.trim());
  }
  if (harness.skills.length) {
    parts.push(
      'SKILLS (apply when relevant):\n' +
        harness.skills
          .map((s) => `${s.name}\n${s.steps.map((step, i) => `  ${i + 1}. ${step}`).join('\n')}`)
          .join('\n\n'),
    );
  }
  if (harness.memory.length) {
    parts.push('MEMORY (lessons from earlier tasks, apply if relevant):\n' + harness.memory.map((m) => `- ${m}`).join('\n'));
  }

  return [
    { role: 'system' as const, content: parts.filter(Boolean).join('\n\n') },
    { role: 'user' as const, content: taskInput },
  ];
}

export function harnessChars(harness: Harness): number {
  return (
    harness.systemPrompt.length +
    harness.toolGuidance.length +
    harness.guardrails.join(' ').length +
    harness.memory.join(' ').length +
    harness.skills.reduce((n, s) => n + s.name.length + s.steps.join(' ').length, 0)
  );
}

export function emptyHarness(h: Partial<Harness> | null | undefined): Harness {
  return {
    systemPrompt: typeof h?.systemPrompt === 'string' ? h.systemPrompt : '',
    guardrails: Array.isArray(h?.guardrails) ? h!.guardrails.filter((g): g is string => typeof g === 'string') : [],
    toolGuidance: typeof h?.toolGuidance === 'string' ? h.toolGuidance : '',
    skills: Array.isArray(h?.skills)
      ? h!.skills
          .filter((s): s is Skill => !!s && typeof s === 'object' && typeof (s as Skill).name === 'string')
          .map((s) => ({
            name: String(s.name),
            steps: Array.isArray(s.steps) ? s.steps.filter((x): x is string => typeof x === 'string') : [],
          }))
      : [],
    memory: Array.isArray(h?.memory) ? h!.memory.filter((m): m is string => typeof m === 'string') : [],
  };
}

/**
 * Merge a model-proposed harness into the previous one. A component the model
 * forgot to return is kept, not wiped, and every component is capped so one bad
 * generation cannot blow the context window on the next call.
 */
export function mergeHarness(prev: Harness, proposed: unknown): Harness {
  const p = emptyHarness(proposed as Partial<Harness>);
  const pick = (key: keyof Harness) => {
    const nextVal = p[key];
    const empty = Array.isArray(nextVal) ? nextVal.length === 0 : !String(nextVal).trim();
    return empty ? prev[key] : (nextVal as never);
  };

  return {
    systemPrompt: String(pick('systemPrompt')).slice(0, CAPS.systemPrompt),
    guardrails: (pick('guardrails') as string[]).slice(0, 20).map((g) => g.slice(0, 300)),
    toolGuidance: String(pick('toolGuidance')).slice(0, CAPS.toolGuidance),
    skills: (pick('skills') as Skill[])
      .slice(0, 8)
      .map((s) => ({ name: s.name.slice(0, 80), steps: s.steps.slice(0, 10).map((x) => x.slice(0, 240)) })),
    memory: (pick('memory') as string[]).slice(0, 10).map((m) => m.slice(0, 240)),
  };
}

export type DiffEntry = {
  component: keyof Harness;
  label: string;
  changed: boolean;
  added: number;
  removed: number;
};

function flatten(component: keyof Harness, h: Harness): string[] {
  if (component === 'skills') return h.skills.flatMap((s) => [s.name, ...s.steps]);
  const v = h[component];
  return Array.isArray(v) ? v : [v];
}

export function diffHarness(base: Harness, next: Harness): DiffEntry[] {
  return (Object.keys(COMPONENT_LABELS) as (keyof Harness)[]).map((component) => {
    const a = new Set(flatten(component, base).join('\n').split('\n'));
    const b = flatten(component, next);
    const bSet = new Set(b.join('\n').split('\n'));
    const added = b.filter((line) => !a.has(line)).length;
    const removed = [...a].filter((line) => !bSet.has(line)).length;
    return {
      component,
      label: COMPONENT_LABELS[component],
      changed: added > 0 || removed > 0,
      added,
      removed,
    };
  });
}

export function harnessToMarkdown(h: Harness, meta: { model: string; score: number; holdout: number; steps: number }) {
  const lines = [
    '# Agent harness',
    '',
    `Generated by Harness Forge. Model held fixed at \`${meta.model}\`, ${meta.steps} optimization step(s).`,
    `Score on the graded suite: ${(meta.score * 100).toFixed(1)}% (holdout ${(meta.holdout * 100).toFixed(1)}%).`,
    '',
    '## System prompt',
    '',
    h.systemPrompt,
    '',
  ];
  if (h.guardrails.length) {
    lines.push('## Guardrails', '', ...h.guardrails.map((g) => `- ${g}`), '');
  }
  if (h.toolGuidance.trim()) {
    lines.push('## Output contract', '', h.toolGuidance, '');
  }
  if (h.skills.length) {
    lines.push('## Skills', '');
    for (const s of h.skills) {
      lines.push(`### ${s.name}`, '', ...s.steps.map((x) => `- ${x}`), '');
    }
  }
  if (h.memory.length) {
    lines.push('## Memory', '', ...h.memory.map((m) => `- ${m}`), '');
  }
  return lines.join('\n');
}
