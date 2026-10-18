export type ComponentKey = 'systemPrompt' | 'guardrails' | 'toolGuidance' | 'skills' | 'memory';

export interface Skill {
  name: string;
  steps: string[];
}

export interface Harness {
  systemPrompt: string;
  guardrails: string[];
  toolGuidance: string;
  skills: Skill[];
  memory: string[];
}

export type Variant = 'public' | 'holdout';

export interface Fixture {
  input: string;
  expected: unknown;
}

export interface TaskSpec {
  id: string;
  title: string;
  domain: string;
  /** What the grader would accept, shown in the UI so the loop is auditable. */
  contract: string;
  variants: Record<Variant, Fixture>;
  grade: (raw: string, expected: unknown) => Grade;
}

export interface Grade {
  score: number;
  passed: boolean;
  failures: string[];
}

export interface Attempt {
  taskId: string;
  variant: Variant;
  raw: string;
  score: number;
  passed: boolean;
  failures: string[];
  tokens: number;
  ms: number;
  error?: string;
}

export interface LLMConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  calls: number;
}

export interface StepResult {
  step: number;
  candidates: CandidateResult[];
  composed: { harness: Harness; score: number; attempts: Attempt[]; tokens: number };
  lessons: string[];
  /** Harness state after lessons were folded into memory. */
  harness: Harness;
  elapsedMs: number;
}

export interface CandidateResult {
  kind: 'invariant' | 'domain';
  harness: Harness;
  probeScore: number;
  probeAttempts: Attempt[];
  rationale: string;
}

export interface RunResult {
  baseline: { harness: Harness; score: number; attempts: Attempt[] };
  steps: StepResult[];
  finalHarness: Harness;
  tuned: { score: number; attempts: Attempt[] };
  holdout: { score: number; attempts: Attempt[] };
  usage: Usage;
  startedAt: string;
  elapsedMs: number;
}

export type RunEvent =
  | { type: 'phase'; phase: string; detail?: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error' | 'good'; message: string }
  | { type: 'baseline'; score: number; attempts: Attempt[] }
  | { type: 'attempt'; attempt: Attempt }
  | { type: 'candidate'; result: CandidateResult }
  | { type: 'step'; result: StepResult }
  | { type: 'progress'; done: number; total: number; label: string }
  | { type: 'done'; result: RunResult };
