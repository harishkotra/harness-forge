import { useEffect, useMemo, useRef, useState } from 'react';
import { runLoop } from './loop.ts';
import { BASELINE_HARNESS, diffHarness, harnessToMarkdown } from './harness.ts';
import { SUITE } from './tasks.ts';
import type { Attempt, LLMConfig, RunResult, StepResult } from './types.ts';
import { ScoreBars, ScoreChart, type Point } from './components/Chart.tsx';
import { HarnessView, TaskMatrix } from './components/Views.tsx';

const STORAGE_KEY = 'harness-forge-config-v1';

type LogLine = { level: 'info' | 'warn' | 'error' | 'good'; message: string; at: string };

const DEFAULT_CFG: LLMConfig & { k: number; probeSize: number } = {
  // Relative on purpose: the app ships a proxy because Particle sends no CORS
  // headers. Point this at a provider URL directly if it allows browsers.
  baseUrl: '/api/llm',
  apiKey: '',
  model: 'deepseek-v41-flash-1017',
  temperature: 0,
  k: 2,
  probeSize: 2,
};

const PRESETS = [
  { name: 'Particle (proxy)', baseUrl: '/api/llm', model: 'deepseek-v41-flash-1017' },
  {
    name: 'Gemini (direct)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.5-flash',
  },
  { name: 'LM Studio', baseUrl: 'http://localhost:1234/v1', model: 'local-model' },
  { name: 'Ollama', baseUrl: 'http://localhost:11434/v1', model: 'llama3.1' },
];

function loadCfg() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_CFG;
    return { ...DEFAULT_CFG, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_CFG;
  }
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const clock = () => new Date().toLocaleTimeString('en-GB', { hour12: false });

export default function App() {
  const [cfg, setCfg] = useState(loadCfg);
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState('');
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [baseline, setBaseline] = useState<{ score: number; attempts: Attempt[] } | null>(null);
  const [steps, setSteps] = useState<StepResult[]>([]);
  const [result, setResult] = useState<RunResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<Record<string, number>>({});
  const [tab, setTab] = useState<'harness' | 'matrix' | 'rubric' | 'export'>('harness');
  const [showSetup, setShowSetup] = useState(true);
  const abortRef = useRef<AbortController | null>(null);
  const traceRef = useRef<HTMLDivElement>(null);
  const runId = useRef(0);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  }, [cfg]);

  useEffect(() => {
    traceRef.current?.scrollTo({ top: traceRef.current.scrollHeight, behavior: 'smooth' });
  }, [logs]);

  const pushLog = (level: LogLine['level'], message: string) =>
    setLogs((prev) => [...prev.slice(-299), { level, message, at: clock() }]);

  async function start() {
    if (!cfg.apiKey.trim() && !/localhost|127\.0\.0\.1/.test(cfg.baseUrl)) {
      setError('An API key is needed for a hosted endpoint. Local endpoints can leave it blank.');
      return;
    }
    const id = ++runId.current;
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setError(null);
    setSteps([]);
    setBaseline(null);
    setResult(null);
    setLive({});
    setLogs([]);
    setTab('harness');
    pushLog('info', `model frozen at ${cfg.model} via ${cfg.baseUrl}`);

    try {
      const res = await runLoop({
        cfg,
        tasks: SUITE,
        k: Math.min(4, Math.max(1, cfg.k)),
        probeSize: Math.min(SUITE.length, Math.max(1, cfg.probeSize)),
        concurrency: 6,
        tokenBudget: 900_000,
        includeHoldout: true,
        signal: controller.signal,
        onEvent: (event) => {
          if (runId.current !== id) return;
          switch (event.type) {
            case 'phase':
              setPhase(event.detail ? `${event.phase} · ${event.detail}` : event.phase);
              setLive({});
              pushLog('info', `${event.phase}${event.detail ? ` (${event.detail})` : ''}`);
              break;
            case 'log':
              pushLog(event.level, event.message);
              break;
            case 'attempt':
              setLive((prev) => ({ ...prev, [event.attempt.taskId]: event.attempt.score }));
              break;
            case 'baseline':
              setBaseline({ score: event.score, attempts: event.attempts });
              break;
            case 'candidate':
              setLive({});
              break;
            case 'step':
              setSteps((prev) => [...prev, event.result]);
              setLive({});
              break;
            case 'done':
              setResult(event.result);
              break;
          }
        },
      });
      setResult(res);
      pushLog('good', `run complete in ${(res.elapsedMs / 1000).toFixed(1)}s`);
    } catch (err) {
      const message = (err as Error).message;
      setError(message);
      pushLog('error', message);
    } finally {
      if (runId.current === id) setRunning(false);
      setPhase('');
    }
  }

  function cancel() {
    abortRef.current?.abort();
    pushLog('warn', 'cancelled by user');
  }

  const finalHarness = result?.finalHarness ?? (steps.length ? steps[steps.length - 1].harness : null);
  const chartPoints = useMemo(() => {
    const pts: Point[] = [{ label: 'naked', score: baseline?.score ?? 0, kind: 'baseline' }];
    steps.forEach((s) => pts.push({ label: `step ${s.step}`, score: s.composed.score, kind: 'step' }));
    if (result && result.holdout.attempts.length) {
      pts.push({ label: 'holdout', score: result.holdout.score, kind: 'holdout' });
    }
    return pts;
  }, [baseline, steps, result]);

  const baselineByTask = Object.fromEntries((baseline?.attempts ?? []).map((a) => [a.taskId, a.score]));
  const holdoutByTask = result && result.holdout.attempts.length
    ? Object.fromEntries(result.holdout.attempts.map((a) => [a.taskId, a.score]))
    : null;

  const markdown = finalHarness
    ? harnessToMarkdown(finalHarness, {
        model: cfg.model,
        score: result?.tuned.score ?? 0,
        holdout: result?.holdout.score ?? 0,
        steps: steps.length,
      })
    : '';

  const gap = result && result.holdout.attempts.length ? result.tuned.score - result.holdout.score : null;

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <div className="mark">H²</div>
          <div>
            <h1>Harness Forge</h1>
            <p className="tagline">the model stays frozen, the harness learns</p>
          </div>
        </div>
        <div className="top-right">
          <div className="chip" title="model id and temperature are fixed for the whole run">
            <span className="lock">frozen</span>
            <span className="mono">{cfg.model}</span>
          </div>
          {running ? (
            <>
              <span className="phase">{phase || 'starting'}</span>
              <button className="btn ghost" onClick={cancel}>
                Cancel
              </button>
            </>
          ) : (
            <button className="btn primary" onClick={start}>
              Run the loop
            </button>
          )}
        </div>
      </header>

      {!result && !running && (
        <section className="intro">
          <p>
            A miniature of <a href="https://github.com/google-research/harness2" target="_blank" rel="noreferrer">Harness²</a>,
            the recursive agent harnessing paper. The weights never change. The harness around the model does: system prompt,
            guardrails, output contract, skills and memory, edited from measured failures and re-measured. The four briefs
            are written the way a real eval is written, so the house rules live in the grader, not in the prompt. That is the job:
            read your own CI failures, then rewrite your own operating manual.
          </p>
          <div className="phases">
            {[
              ['propose', 'an editor reads the grader diffs and rewrites harness components'],
              ['probe', 'each candidate harness runs the failing tasks for real'],
              ['compose', 'a composer merges the edits the evidence supports'],
              ['reflect', 'lessons from the step feed the next edit'],
            ].map(([name, text]) => (
              <div key={name} className="phase-card">
                <span className="phase-name">{name}</span>
                <span className="phase-text">{text}</span>
              </div>
            ))}
          </div>
          <p className="fineprint">
            {SUITE.length} graded tasks, real model calls, no cache. One run is roughly{' '}
            {SUITE.length * (cfg.k + 2) + cfg.k * (cfg.probeSize * 2 + 3)} calls. The editor reads grader diffs, which is exactly
            how benchmark guided harness search works, and exactly how it can overfit. The holdout is the only thing standing
            between you and a harness that recites answers, so read that number before the tuned one.
          </p>
        </section>
      )}

      <div className="grid">
        <aside className="col-left">
          <section className="panel">
            <button className="panel-head" onClick={() => setShowSetup((s) => !s)}>
              <h2>Run setup</h2>
              <span className="chev">{showSetup ? '−' : '+'}</span>
            </button>
            {showSetup && (
              <div className="fields">
                <label>
                  Base URL
                  <input
                    value={cfg.baseUrl}
                    onChange={(e) => setCfg({ ...cfg, baseUrl: e.target.value })}
                    spellCheck={false}
                  />
                </label>
                <label>
                  API key
                  <input
                    type="password"
                    value={cfg.apiKey}
                    placeholder="stored in this browser only"
                    onChange={(e) => setCfg({ ...cfg, apiKey: e.target.value })}
                    spellCheck={false}
                  />
                </label>
                <label>
                  Model
                  <input value={cfg.model} onChange={(e) => setCfg({ ...cfg, model: e.target.value })} spellCheck={false} />
                </label>
                <div className="presets">
                  {PRESETS.map((p) => (
                    <button key={p.name} className="preset" onClick={() => setCfg({ ...cfg, baseUrl: p.baseUrl, model: p.model })}>
                      {p.name}
                    </button>
                  ))}
                </div>
                <div className="two">
                  <label>
                    Steps (k)
                    <input
                      type="number"
                      min={1}
                      max={4}
                      value={cfg.k}
                      onChange={(e) => setCfg({ ...cfg, k: Number(e.target.value) })}
                    />
                  </label>
                  <label>
                    Probe tasks
                    <input
                      type="number"
                      min={1}
                      max={6}
                      value={cfg.probeSize}
                      onChange={(e) => setCfg({ ...cfg, probeSize: Number(e.target.value) })}
                    />
                  </label>
                </div>
                <p className="fineprint">
                  k is the task level recursion budget. More steps means more calls, not a different model.
                </p>
              </div>
            )}
          </section>

          <section className="panel">
            <div className="panel-head static">
              <h2>Graded suite</h2>
              <span className="count">{SUITE.length}</span>
            </div>
            <ul className="suite">
              {SUITE.map((task) => {
                const score = live[task.id];
                return (
                  <li key={task.id} className={score === undefined ? '' : score >= 0.999 ? 'ok' : score >= 0.5 ? 'mid' : 'bad'}>
                    <span className="suite-title">{task.title}</span>
                    <span className="suite-domain">{task.domain}</span>
                    <span className="suite-score">{score === undefined ? (running ? '···' : 'idle') : pct(score)}</span>
                  </li>
                );
              })}
            </ul>
          </section>

          {error && <div className="alert">{error}</div>}
        </aside>

        <main className="col-main">
          <section className="panel score-panel">
            <div className="score-head">
              <div>
                <h2>Score by recursion step</h2>
                <p className="sub">
                  fixed weights, evolving harness · {result ? `${result.usage.calls} calls` : running ? 'running' : 'not run yet'}
                </p>
              </div>
              {result && (
                <div className="bigscores">
                  <div>
                    <span className="k">tuned</span>
                    <span className="v">{pct(result.tuned.score)}</span>
                  </div>
                  <div>
                    <span className="k">holdout</span>
                    <span className="v">{result.holdout.attempts.length ? pct(result.holdout.score) : '—'}</span>
                  </div>
                </div>
              )}
            </div>
            {(baseline || running) && <ScoreChart points={chartPoints} />}
            {!baseline && !running && <div className="placeholder">Run the loop to see the score climb.</div>}
            {result && gap !== null && (
              <p className={`gap ${gap > 0.15 ? 'bad' : gap > 0.05 ? 'warn' : 'ok'}`}>
                generalization gap {(gap * 100).toFixed(1)} points:{' '}
                {gap > 0.15
                  ? 'the harness memorised the public suite, treat the tuned score as inflated.'
                  : gap > 0.05
                    ? 'partly memorised, the rules transfer but not perfectly.'
                    : 'the rules transfer to unseen values.'}
              </p>
            )}
            {result && (
              <ScoreBars baseline={result.baseline.score} tuned={result.tuned.score} holdout={result.holdout.attempts.length ? result.holdout.score : null} />
            )}
          </section>

          {steps.length > 0 && (
            <section className="steps">
              {steps.map((step) => (
                <article key={step.step} className="panel step-card">
                  <header>
                    <span className="stepno">step {step.step}</span>
                    <span className="stepscore">{pct(step.composed.score)}</span>
                  </header>
                  <div className="candidates">
                    {step.candidates.map((c) => (
                      <div key={c.kind} className="cand">
                        <span className={`cand-kind ${c.kind}`}>{c.kind}</span>
                        <span className="cand-score">{pct(c.probeScore)}</span>
                        <span className="cand-note">probe</span>
                      </div>
                    ))}
                    {!step.candidates.length && <span className="muted">no candidate survived</span>}
                  </div>
                  {step.lessons.length > 0 && (
                    <ul className="lessons">
                      {step.lessons.map((l, i) => (
                        <li key={i}>{l}</li>
                      ))}
                    </ul>
                  )}
                  <div className="edits">
                    {diffHarness(step.step === 1 ? BASELINE_HARNESS : steps[step.step - 2].harness, step.harness)
                      .filter((d) => d.changed)
                      .map((d) => (
                        <span key={d.component} className="edit-chip">
                          {d.label} <span className="mono">+{d.added}</span>
                        </span>
                      ))}
                  </div>
                </article>
              ))}
            </section>
          )}

          {finalHarness && (
            <section className="panel">
              <div className="tabs">
                {(['harness', 'matrix', 'rubric', 'export'] as const).map((t) => (
                  <button key={t} className={tab === t ? 'tab active' : 'tab'} onClick={() => setTab(t)}>
                    {t === 'harness' ? 'Harness' : t === 'matrix' ? 'Task matrix' : t === 'rubric' ? 'Rubric' : 'Export'}
                  </button>
                ))}
              </div>
              {tab === 'harness' && <HarnessView harness={finalHarness} base={BASELINE_HARNESS} />}
              {tab === 'matrix' && (
                <TaskMatrix tasks={SUITE} baseline={baselineByTask} steps={steps} holdout={holdoutByTask} />
              )}
              {tab === 'rubric' && (
                <div className="rubric">
                  <p className="fineprint">
                    What each grader enforces. The model never sees this text. It only ever sees the failure messages the
                    grader produces, which is the same evidence a CI log gives an engineer.
                  </p>
                  {SUITE.map((task) => (
                    <div key={task.id} className="rubric-item">
                      <div className="rubric-head">
                        <span className="rubric-title">{task.title}</span>
                        <span className="task-domain">{task.domain}</span>
                      </div>
                      <p>{task.contract}</p>
                    </div>
                  ))}
                </div>
              )}
              {tab === 'export' && (
                <div className="export">
                  <p className="fineprint">
                    This is the deliverable: a harness you can drop into any agent. It is a document, not a weight change.
                  </p>
                  <div className="export-actions">
                    <button
                      className="btn"
                      onClick={() => {
                        navigator.clipboard.writeText(markdown);
                        pushLog('good', 'harness markdown copied');
                      }}
                    >
                      Copy markdown
                    </button>
                    <button
                      className="btn ghost"
                      onClick={() => {
                        const blob = new Blob([markdown], { type: 'text/markdown' });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = 'harness.md';
                        a.click();
                        URL.revokeObjectURL(url);
                      }}
                    >
                      Download harness.md
                    </button>
                  </div>
                  <pre className="export-pre">{markdown}</pre>
                </div>
              )}
            </section>
          )}
        </main>

        <aside className="col-right">
          <section className="panel trace-panel">
            <div className="panel-head static">
              <h2>Trace</h2>
              <span className="count">{logs.length}</span>
            </div>
            <div className="trace" ref={traceRef}>
              {logs.length === 0 && <p className="muted small">No calls yet. The trace shows every phase, probe score and failure count.</p>}
              {logs.map((l, i) => (
                <div key={i} className={`line ${l.level}`}>
                  <span className="t">{l.at}</span>
                  <span className="m">{l.message}</span>
                </div>
              ))}
            </div>
          </section>

          {result && (
            <section className="panel">
              <div className="panel-head static">
                <h2>Cost</h2>
              </div>
              <dl className="cost">
                <div>
                  <dt>calls</dt>
                  <dd>{result.usage.calls}</dd>
                </div>
                <div>
                  <dt>tokens in</dt>
                  <dd>{result.usage.promptTokens.toLocaleString()}</dd>
                </div>
                <div>
                  <dt>tokens out</dt>
                  <dd>{result.usage.completionTokens.toLocaleString()}</dd>
                </div>
                <div>
                  <dt>elapsed</dt>
                  <dd>{(result.elapsedMs / 1000).toFixed(1)}s</dd>
                </div>
              </dl>
            </section>
          )}
        </aside>
      </div>

      <footer className="foot">
        <span>Typed the model ID once. Never touched it again.</span>
        <span className="byline">
          <a href="https://harishkotra.me" target="_blank" rel="noreferrer">
            Built By Harish Kotra
          </a>
          <span className="sep">/</span>
          <a href="https://dailybuild.xyz" target="_blank" rel="noreferrer">
            Checkout my other builds
          </a>
        </span>
      </footer>
    </div>
  );
}
