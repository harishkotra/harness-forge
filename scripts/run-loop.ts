/**
 * Headless run of the same loop the UI runs. This is how the harness is
 * verified without a browser, and how a run is recorded as evidence.
 *
 *   HARNESS_API_KEY=... npm run loop -- --k 2 --tasks 6 --probe 3
 *
 * Env: HARNESS_BASE_URL, HARNESS_API_KEY, HARNESS_MODEL, HARNESS_TEMPERATURE
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SUITE } from '../src/tasks.ts';
import { runLoop, scoreOf } from '../src/loop.ts';
import type { LLMConfig } from '../src/types.ts';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const cfg: LLMConfig = {
  baseUrl: process.env.HARNESS_BASE_URL ?? 'https://api.particle.ai/v1',
  apiKey: process.env.HARNESS_API_KEY ?? '',
  model: process.env.HARNESS_MODEL ?? 'deepseek-v41-flash-1017',
  temperature: Number(process.env.HARNESS_TEMPERATURE ?? 0),
};

if (!cfg.apiKey) {
  console.error('HARNESS_API_KEY is required. This script makes real model calls.');
  process.exit(2);
}

const k = Math.max(0, Number(arg('k', '2')));
const taskCount = Number(arg('tasks', String(SUITE.length)));
const probeSize = Number(arg('probe', '2'));
const tasks = SUITE.slice(0, taskCount);

console.log(`model ${cfg.model} at ${cfg.baseUrl} | ${tasks.length} tasks | k=${k} | probe=${probeSize}`);

const result = await runLoop({
  cfg,
  tasks,
  k,
  probeSize,
  concurrency: Number(arg('concurrency', '6')),
  tokenBudget: Number(arg('budget', '900000')),
  includeHoldout: true,
  onEvent: (event) => {
    if (event.type === 'log') console.log(`  [${event.level}] ${event.message}`);
    else if (event.type === 'phase') console.log(`phase: ${event.phase}${event.detail ? ` (${event.detail})` : ''}`);
  },
});

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
console.log('\nresults');
console.log(`  baseline ${pct(result.baseline.score)}`);
for (const step of result.steps) console.log(`  step ${step.step}   ${pct(step.composed.score)}`);
console.log(`  tuned    ${pct(result.tuned.score)}`);
console.log(`  holdout  ${pct(scoreOf(result.holdout.attempts))}`);
console.log(`  tokens   ${result.usage.promptTokens} in / ${result.usage.completionTokens} out over ${result.usage.calls} calls`);
console.log(`  elapsed  ${(result.elapsedMs / 1000).toFixed(1)}s`);

const dir = join(process.cwd(), 'runs');
mkdirSync(dir, { recursive: true });
const file = join(dir, `run-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(file, JSON.stringify({ config: { ...cfg, apiKey: '[redacted]' }, tasks: tasks.map((t) => t.id), result }, null, 2));
console.log(`\nrecorded ${file}`);
