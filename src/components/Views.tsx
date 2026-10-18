import type { Harness, StepResult, TaskSpec } from '../types.ts';

export function TaskMatrix({
  tasks,
  baseline,
  steps,
  holdout,
}: {
  tasks: TaskSpec[];
  baseline: Record<string, number>;
  steps: StepResult[];
  holdout: Record<string, number> | null;
}) {
  const cellClass = (score: number | undefined) =>
    score === undefined ? 'cell empty' : score >= 0.999 ? 'cell pass' : score >= 0.5 ? 'cell mid' : 'cell fail';

  return (
    <div className="matrix-wrap">
      <table className="matrix">
        <thead>
          <tr>
            <th className="taskcol">task</th>
            <th>naked</th>
            {steps.map((s) => (
              <th key={s.step}>step {s.step}</th>
            ))}
            {holdout && <th className="holdcol">holdout</th>}
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => (
            <tr key={task.id}>
              <td className="taskcol">
                <span className="task-title">{task.title}</span>
                <span className="task-domain">{task.domain}</span>
              </td>
              <td className={cellClass(baseline[task.id])}>{fmt(baseline[task.id])}</td>
              {steps.map((s) => {
                const a = s.composed.attempts.find((x) => x.taskId === task.id);
                return (
                  <td key={s.step} className={cellClass(a?.score)}>
                    {fmt(a?.score)}
                  </td>
                );
              })}
              {holdout && <td className={cellClass(holdout[task.id])}>{fmt(holdout[task.id])}</td>}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="matrix-note">
        Every cell is a real graded run. Holdout uses the same rule set with different values, so a harness that memorised the
        public answers will drop here.
      </p>
    </div>
  );
}

function fmt(score: number | undefined) {
  return score === undefined ? '·' : `${Math.round(score * 100)}`;
}

export function HarnessView({ harness, base }: { harness: Harness; base: Harness }) {
  const components: { key: keyof Harness; label: string }[] = [
    { key: 'systemPrompt', label: 'System prompt' },
    { key: 'guardrails', label: 'Guardrails' },
    { key: 'toolGuidance', label: 'Output contract' },
    { key: 'skills', label: 'Skills' },
    { key: 'memory', label: 'Memory (lessons)' },
  ];

  return (
    <div className="harness-view">
      {components.map(({ key, label }) => {
        const value = harness[key];
        const baseValue = base[key];
        const changed = JSON.stringify(value) !== JSON.stringify(baseValue);
        const empty = Array.isArray(value) ? value.length === 0 : !String(value).trim();
        return (
          <details key={key} className={`hcomp ${changed ? 'changed' : ''}`} open={changed || key === 'systemPrompt'}>
            <summary>
              <span className="hname">{label}</span>
              {changed ? <span className="badge">edited</span> : <span className="badge muted">unchanged</span>}
              <span className="hsize">{empty ? 'empty' : `${count(value)} line${count(value) === 1 ? '' : 's'}`}</span>
            </summary>
            <div className="hbody">
              {empty ? (
                <p className="muted">Nothing here in the baseline, and the loop left it empty.</p>
              ) : key === 'skills' ? (
                (value as Harness['skills']).map((skill) => (
                  <div key={skill.name} className="skill">
                    <div className="skillname">{skill.name}</div>
                    <ol>
                      {skill.steps.map((step, i) => (
                        <li key={i}>{step}</li>
                      ))}
                    </ol>
                  </div>
                ))
              ) : Array.isArray(value) ? (
                <ul>
                  {(value as string[]).map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
              ) : (
                <pre>{String(value)}</pre>
              )}
            </div>
          </details>
        );
      })}
    </div>
  );
}

function count(value: string | string[] | Harness['skills']) {
  if (Array.isArray(value)) return value.length;
  return String(value).split('\n').filter((l) => l.trim()).length;
}
