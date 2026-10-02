// Self-contained report.html following `claude plugin eval`'s layout: header, verdict, tiles, then per case
// its results by arm and run, the prompt, and the grader definitions.
const esc = (s) => String(s ?? "").replace(/[&<>"']/gu, (c) => `&#${c.charCodeAt(0)};`);
const mean = (xs) => xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
const pct = (x) => x === null ? "–" : `${Math.round(x * 100)}%`;
const utc = (iso, withDate) => `${iso.slice(withDate ? 0 : 11, withDate ? 16 : 19).replace("T", " ")} UTC`;
const duration = (s) => s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;

function delta(d)
{
    if (d === null) return "";
    const pts = (d * 100).toFixed(1);
    if (d > 0) return `<span class="delta delta-pos">↑ +${pts} pts</span>`;
    if (d < 0) return `<span class="delta delta-neg">↓ ${pts} pts</span>`;
    return `<span class="delta delta-zero">→ 0.0 pts</span>`;
}

const meter = (x, kind, tick) => `<span class="meter m-${kind}" aria-hidden="true"><span style="width:${((x ?? 0) * 100).toFixed(1)}%"></span>`
    + `${tick === undefined ? "" : `<i class="tick" style="left:${(tick * 100).toFixed(1)}%"></i>`}</span>`;

function grader(g)
{
    // The judge's own words stay collapsed: the votes decide, the reasons are there for debugging a verdict.
    const judge = g.judgeVotes === undefined ? "" : `<div class="kv"><span>Judge votes</span><span class="votes">${g.judgeVotes.map((v) => v ? "✓" : "✗").join(" ")}</span></div>`
        + `<div class="kv"><span>Evidence (what the judge was shown)</span></div><pre class="evidence">${esc(g.evidence)}</pre>`
        + (g.judgeOutputs === undefined ? "" : `<details class="judge"><summary>Judge output</summary>${g.judgeOutputs.map((o, i) =>
            `<div class="kv"><span>Vote ${i + 1}</span><span class="votes">${g.judgeVotes[i] ? "✓" : "✗"}</span></div><pre class="evidence">${esc(o)}</pre>`).join("")}</details>`);
    return `<details class="grader"${g.passed ? "" : " open"}><summary><span class="chip chip-${g.passed ? "pass" : "fail"}">${g.passed ? "✓ pass" : "✗ fail"}</span> `
        + `<span class="grader-name">${esc(g.name)}</span>${g.scored ? "" : ` <span class="badge">plugin-fired indicator</span>`}</summary>`
        + `<div class="grader-body"><p class="explanation">${esc(g.explanation)}</p>${judge}</div></details>`;
}

function run(r, i, kind)
{
    const error = r.error ? `<p class="explanation">Run error: ${esc(r.error)}</p>` : "";
    return `<div class="run${r.error ? " run-error" : ""}"><div class="run-head"><span class="run-title">Run ${i + 1}</span>${meter(r.score, kind)}`
        + `<span class="num">${pct(r.score)}</span><span class="muted num">${r.turns} turns · $${r.costUsd.toFixed(2)} · ${utc(r.startedAt)}</span></div>`
        + `<div class="graders">${error}${r.graders.map(grader).join("")}</div></div>`;
}

function arm(label, runs, kind)
{
    if (runs === undefined || runs.length === 0) return "";
    const score = mean(runs.map((r) => r.score));
    return `<section class="arm"><div class="arm-head"><span class="arm-label">${label}</span>${meter(score, kind)}<span class="num">${pct(score)}</span>`
        + `<span class="muted num">${pct(runs.filter((r) => r.passed).length / runs.length)} of runs perfect</span></div>${runs.map((r, i) => run(r, i, kind)).join("")}</section>`;
}

function graderDef(g)
{
    const config = Object.entries(g.config).filter(([k]) => !(g.graderMarkdown !== undefined && k === "criteria"));
    const body = g.graderMarkdown === undefined ? "" : `<div class="md"><pre>${esc(g.graderMarkdown)}</pre></div>`;
    const kv = config.length === 0 ? "" : `<div class="config">${config.map(([k, v]) => `<div class="kv"><span>${esc(k)}</span><code>${esc(JSON.stringify(v))}</code></div>`).join("")}</div>`;
    return `<div class="grader-def"><div class="grader-def-head"><span class="grader-name">${esc(g.name)}</span><span class="badge">${esc(g.type)}</span></div>${body}${kv}</div>`;
}

function caseBlock(c, i, threshold)
{
    const { score, delta: d } = c.aggregates;
    return `<article class="case${d !== null && d < 0 ? " case-regressed" : ""}" id="case-${i + 1}"><div class="case-head"><h2>${esc(c.name)}</h2>`
        + `<span class="muted mono">${esc(c.dir)}</span><span class="spacer"></span>${delta(d)}<span class="muted">with plugin</span>`
        + `${meter(score, "accent", threshold)}<span class="num case-score">${pct(score)}</span></div>`
        + `<details class="section" open><summary>Results</summary>${arm("With plugin", c.arms.with, "accent")}${arm("Baseline (no plugin)", c.arms.without, "base")}</details>`
        + `<details class="section" open><summary>Prompt</summary><div class="md"><pre>${esc(c.promptMarkdown)}</pre></div></details>`
        + `<details class="section" open><summary>Graders — what "good" means for this case</summary>${c.graders.map(graderDef).join("")}</details></article>`;
}

/** Render Claude's aggregate-result.json schema (plus the Pi-only fields) as report.html. */
export function renderHtml(a, target)
{
    const { suite, cases, aggregates } = a;
    const twoArm = suite.ablation === "with-without";
    const deltas = cases.map((c) => c.aggregates.delta).filter((d) => d !== null);
    const runCount = cases.reduce((n, c) => n + Object.values(c.arms).flat().length, 0);
    const meanDelta = aggregates.meanDelta;
    const plugin = suite.plugins[0].name;
    const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
    const verdict = twoArm
        ? `Plugin effect: ${delta(meanDelta)} vs baseline — improved ${deltas.filter((d) => d > 0).length} · flat ${deltas.filter((d) => d === 0).length} · regressed ${deltas.filter((d) => d < 0).length} of ${plural(cases.length, "case")}.`
        : `${aggregates.casesPassed} of ${plural(cases.length, "case")} at or above the ${pct(suite.threshold)} threshold.`;
    const meta = [`<span class="mono">${esc(target)}</span>`, `<span>${a.piVersion === undefined ? `Claude Code v${esc(a.claudeVersion)}` : `Pi ${esc(a.piVersion)}`}</span>`, `<span class="num">${utc(a.startedAt, true)}</span>`,
        `<span class="num">${duration(a.durationSeconds)}</span>`, `<span class="num">$${a.costUsd.toFixed(2)}</span>`, `<span class="num">${runCount} runs</span>`,
        ...(suite.modelOverride ? [`<span>model ${esc(suite.modelOverride)}</span>`] : []), ...(suite.judgeModel ? [`<span>judge ${esc(suite.judgeModel)}</span>`] : []),
        `<span class="num">threshold ${pct(suite.threshold)}</span>`];
    const tile = (label, value, sub, cls = "") => `<div class="tile${cls}"><span class="label">${label}</span>${value}<span class="sub">${sub}</span></div>`;
    const dCls = meanDelta === null ? "" : meanDelta > 0 ? " delta-pos" : meanDelta < 0 ? " delta-neg" : "";
    const tiles = [
        tile(`Suite score${twoArm ? " · with plugin" : ""}`, `<span class="value">${pct(aggregates.overallScore)}</span>`, "mean of per-case scores", " hero"),
        ...(twoArm ? [
            tile("Ablation Δ", `<span class="value num${dCls}">${delta(meanDelta).replace(/<[^>]+>/gu, "").replace(" pts", "")}</span>`, `score points vs baseline, ${deltas.length} of ${plural(cases.length, "case")}`),
            tile("Baseline score", `<span class="value num">${pct(mean(cases.map((c) => c.aggregates.scoreWithout).filter((x) => x !== null)))}</span>`, "without the plugin"),
        ] : []),
        tile("Cases", `<span class="value num">${aggregates.casesTotal}</span>`, `${aggregates.casesPassed} of ${aggregates.casesTotal} ≥ ${pct(suite.threshold)} threshold`),
        tile("Perfect runs", `<span class="value num">${pct(aggregates.overallPassRate)}</span>`, "runs where every grader passed"),
    ];
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Eval report — ${esc(plugin)}</title>
<style>${CSS}</style></head><body><div class="wrap">
<header><div class="eyebrow">Plugin eval report</div><h1>${esc(plugin)}</h1><p class="verdict">${verdict}</p><div class="meta">${meta.join("")}</div></header>
${a.partial ? `<div class="banner"><span class="chip-warn">Partial run</span> ${esc(a.partialReason)}</div>` : ""}
<section class="tiles">${tiles.join("")}</section>
<details class="section legend"><summary>How to read this report</summary><ul class="legend-list">
<li>A run's score is the weighted fraction of its graders that passed; a "perfect" run passed every grader.</li>
<li>A case's score is the mean of its runs; a case passes when its score is at or above the ${pct(suite.threshold)} threshold (the tick on each case bar).</li>
<li>The suite score is the mean of the per-case scores.</li>
<li>Judge votes are independent samples of the LLM judge; the majority decides pass or fail. Each vote's full reply is under "Judge output".</li>
${twoArm ? `<li>"With plugin" and "Baseline" runs are identical except for the plugin being loaded; Δ is the with-plugin score minus the baseline score.</li>
<li>A "plugin-fired indicator" grader is reported but not scored, since it can never pass without the plugin.</li>` : ""}
</ul></details>
<div class="toolbar"><button type="button" data-act="expand">Expand all</button><button type="button" data-act="collapse">Collapse all</button></div>
${cases.map((c, i) => caseBlock(c, i, suite.threshold)).join("\n")}
<footer>Generated by <code>pi-plugin-eval</code> with Pi · schema v1 · scores are not comparable across different suites or agents</footer>
</div><script>${SCRIPT}</script></body></html>
`;
}

const SCRIPT = `
document.querySelector('.toolbar').addEventListener('click', function (e) {
  var b = e.target.closest('button'); if (!b) return;
  document.querySelectorAll('details.section, details.grader, details.judge').forEach(function (d) { d.open = b.dataset.act === 'expand'; });
});
// Collapsed details would vanish from a printed or PDF copy.
addEventListener('beforeprint', function () { document.querySelectorAll('details:not([open])').forEach(function (d) { d.dataset.printOpened = '1'; d.open = true; }); });
addEventListener('afterprint', function () { document.querySelectorAll('details[data-print-opened]').forEach(function (d) { d.open = false; delete d.dataset.printOpened; }); });
`;

const LIGHT = "--plane:#f9f9f7;--surface:#fcfcfb;--ink:#0b0b0b;--ink-2:#52514e;--ink-3:#6b6a64;--hairline:rgba(11,11,11,.10);--grid:#e1e0d9;--inset:rgba(11,11,11,.04);--accent:#2a78d6;--base-fill:#6b6a64;--delta-good:#006300;--good:#067d06;--warning:#8a6100;--critical:#d03b3b";
const DARK = "--plane:#0d0d0d;--surface:#1a1a19;--ink:#fff;--ink-2:#c3c2b7;--ink-3:#898781;--hairline:rgba(255,255,255,.10);--grid:#2c2c2a;--inset:rgba(255,255,255,.05);--accent:#3987e5;--base-fill:#898781;--delta-good:#0ca30c;--good:#0ca30c;--warning:#fab219;--critical:#e06c6c";
const MONO = `"SF Mono",ui-monospace,Menlo,Consolas,monospace`;
const CSS = `
:root{${LIGHT};color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{${DARK};color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;background:var(--plane);color:var(--ink);font:14px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{max-width:880px;margin:0 auto;padding:40px 24px 64px;display:flex;flex-direction:column;gap:20px}
.eyebrow{font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3)}
header h1{margin:2px 0 0;font-size:24px;font-weight:600;line-height:1.25}
.verdict{margin:6px 0 0;font-size:15px}.verdict .delta{font-size:15px}
.meta{display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:8px;color:var(--ink-2);font-size:13px}
.banner{display:flex;gap:8px;padding:10px 14px;border-radius:8px;border:1px solid var(--hairline);background:var(--surface);font-size:13px}
.chip-warn{color:var(--warning);font-weight:600}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.tile{background:var(--surface);border:1px solid var(--hairline);border-radius:10px;padding:14px 16px;display:flex;flex-direction:column;gap:4px}
.tile .label{font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-3)}
.tile .value{font-size:26px;font-weight:600;font-variant-numeric:tabular-nums;line-height:1.1}
.tile.hero .value{font-family:Georgia,"Times New Roman",serif;font-weight:400;font-size:48px}
.tile .sub{font-size:12px;color:var(--ink-2)}
.toolbar{display:flex;gap:8px;justify-content:flex-end}
.toolbar button{font:inherit;font-size:12px;color:var(--ink-2);background:var(--surface);border:1px solid var(--hairline);border-radius:6px;padding:4px 10px;cursor:pointer}
.toolbar button:hover{color:var(--ink)}
.case{background:var(--surface);border:1px solid var(--hairline);border-radius:10px;padding:18px 20px;display:flex;flex-direction:column;gap:10px}
.case-regressed{border-left:3px solid var(--critical)}
.case-head,.arm-head,.run-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.case-head h2{margin:0;font-size:16px;font-weight:600}.case-head .spacer{flex:1}.case-score{font-size:15px;font-weight:600}
.mono{font:12px ${MONO}}.num{font-variant-numeric:tabular-nums}.muted{color:var(--ink-3);font-size:12px}
.meter{display:inline-block;position:relative;width:120px;height:6px;border-radius:4px;background:var(--grid);vertical-align:middle}
.meter>span{display:block;height:100%;border-radius:4px;max-width:100%}
.meter .tick{position:absolute;top:-2px;bottom:-2px;width:2px;background:var(--ink-3);border-radius:1px}
.m-accent>span{background:var(--accent)}.m-base>span{background:var(--base-fill)}
.delta{font-size:12px;font-weight:600;font-variant-numeric:tabular-nums}
.delta-pos{color:var(--delta-good)}.delta-neg{color:var(--critical)}.delta-zero{color:var(--ink-3)}
details.section{border-top:1px solid var(--grid);padding-top:10px}
details.section>summary,.legend summary{cursor:pointer;font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--ink-2)}
details.section[open]>summary{margin-bottom:8px}
.legend-list{margin:8px 0 0;padding-left:20px;display:flex;flex-direction:column;gap:5px;font-size:13px;color:var(--ink-2)}
.md{background:var(--inset);border-radius:8px;padding:12px 14px}
.md pre{margin:0;white-space:pre-wrap;overflow-wrap:break-word;font:13px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
.grader-def{display:flex;flex-direction:column;gap:6px;padding:8px 0}.grader-def+.grader-def{border-top:1px solid var(--grid)}
.grader-def-head{display:flex;align-items:baseline;gap:8px}
.grader-name{font:13px ${MONO};font-weight:600}
.badge{font-size:10px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--ink-2);border:1px solid var(--hairline);border-radius:999px;padding:1px 8px}
.config{display:flex;flex-direction:column;gap:2px;background:var(--inset);border-radius:8px;padding:10px 14px}
.config code{font:12px ${MONO};overflow-wrap:anywhere}
.arm{display:flex;flex-direction:column;gap:8px;padding:6px 0}.arm+.arm{border-top:1px dashed var(--grid);margin-top:4px;padding-top:12px}
.arm-label{font-size:13px;font-weight:600}
.run{border:1px solid var(--grid);border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;gap:8px}
.run-title{font-size:12px;font-weight:600;color:var(--ink-2)}
.graders{display:flex;flex-direction:column;gap:4px}
details.grader>summary{cursor:pointer;display:flex;align-items:baseline;gap:8px;padding:3px 4px;border-radius:6px;list-style:none}
details.grader>summary::-webkit-details-marker{display:none}
details.grader>summary::before{content:'▸';font-size:10px;color:var(--ink-3);transition:transform .12s ease}
details.grader[open]>summary::before{transform:rotate(90deg)}
details.grader>summary:hover{background:var(--inset)}
.grader-body{padding:6px 8px 8px 24px;display:flex;flex-direction:column;gap:6px}
.chip{font-size:11px;font-weight:600;border-radius:999px;padding:1px 8px;white-space:nowrap;border:1px solid currentColor}
.chip-pass{color:var(--good)}.chip-fail{color:var(--critical)}
.explanation{margin:0;font-size:13px;color:var(--ink-2);white-space:pre-wrap;overflow-wrap:break-word}
.kv{display:flex;gap:8px;font-size:12px;color:var(--ink-3)}
details.judge>summary{cursor:pointer;font-size:12px;color:var(--ink-3)}details.judge>summary:hover{color:var(--ink)}details.judge[open]{display:flex;flex-direction:column;gap:6px}.votes{letter-spacing:.1em}
pre.evidence{margin:0;background:var(--inset);border:1px solid var(--hairline);border-radius:6px;padding:8px 10px;max-height:320px;overflow:auto;font:12px/1.5 ${MONO};white-space:pre-wrap;overflow-wrap:break-word}
footer{color:var(--ink-3);font-size:12px;text-align:center;padding-top:8px}
@media print{:root{${LIGHT};color-scheme:light}body{background:#fff}.toolbar{display:none}.case,.run,.grader-def{break-inside:avoid}pre.evidence{max-height:none}}
`;
