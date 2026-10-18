export interface Point {
  label: string;
  score: number;
  kind: 'baseline' | 'step' | 'holdout';
}

const W = 760;
const H = 250;
const PAD = { top: 26, right: 22, bottom: 34, left: 44 };

export function ScoreChart({ points }: { points: Point[] }) {
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (points.length <= 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
  const y = (score: number) => PAD.top + innerH - score * innerH;
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.score).toFixed(1)}`).join(' ');

  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="harness score by step">
      {[0, 0.25, 0.5, 0.75, 1].map((t) => (
        <g key={t}>
          <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} className="grid" />
          <text x={PAD.left - 10} y={y(t) + 4} className="axis" textAnchor="end">
            {Math.round(t * 100)}
          </text>
        </g>
      ))}

      <path d={path} className="scoreline" />

      {points.map((p, i) => (
        <g key={`${p.label}-${i}`}>
          <circle cx={x(i)} cy={y(p.score)} r={p.kind === 'holdout' ? 6 : 5} className={`dot ${p.kind}`} />
          <text x={x(i)} y={y(p.score) - 13} className="val" textAnchor="middle">
            {(p.score * 100).toFixed(0)}%
          </text>
          <text x={x(i)} y={H - 12} className="axis" textAnchor="middle">
            {p.label}
          </text>
        </g>
      ))}
    </svg>
  );
}

export function ScoreBars({ baseline, tuned, holdout }: { baseline: number; tuned: number; holdout: number | null }) {
  return (
    <div className="bars">
      <div className="bar-row">
        <span className="bar-label">naked</span>
        <div className="bar-track">
          <div className="bar-fill base" style={{ width: `${baseline * 100}%` }} />
        </div>
        <span className="bar-val">{(baseline * 100).toFixed(1)}%</span>
      </div>
      <div className="bar-row">
        <span className="bar-label">tuned</span>
        <div className="bar-track">
          <div className="bar-fill tuned" style={{ width: `${tuned * 100}%` }} />
        </div>
        <span className="bar-val">{(tuned * 100).toFixed(1)}%</span>
      </div>
      <div className="bar-row">
        <span className="bar-label">holdout</span>
        <div className="bar-track">
          <div className="bar-fill hold" style={{ width: `${(holdout ?? 0) * 100}%` }} />
        </div>
        <span className="bar-val">{holdout === null ? 'not run' : `${(holdout * 100).toFixed(1)}%`}</span>
      </div>
    </div>
  );
}
