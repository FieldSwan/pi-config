// Self-contained report.html laid out like `claude plugin eval`'s: verdict, summary tiles, then per-case runs.
const esc = (s) => String(s ?? "").replace(/[&<>"']/gu, (c) => `&#${c.charCodeAt(0)};`);
const num = (x, sign = false) => x === null ? "–" : `${sign && x >= 0 ? "+" : ""}${x.toFixed(2)}`;
const mean = (xs) => xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;

function graderRow(g)
{
    const verdict = g.passed ? "pass" : "fail";
    const votes = g.votes === undefined ? "" : `<details><summary>judge votes</summary>${g.votes.map((v) => `<pre>${esc(v)}</pre>`).join("")}`
        + `<details><summary>excerpt judged</summary><pre>${esc(g.excerpt)}</pre></details></details>`;
    return `<tr><td class="${verdict}">${verdict}</td><td>${esc(g.name)}</td><td>${esc(g.type)}</td><td>${g.weight}</td>`
        + `<td>${g.scored ? "" : "unscored"}</td><td><pre>${esc(g.explanation)}</pre>${votes}</td></tr>`;
}

function runBlock(run)
{
    const graders = run.graders.length === 0 ? "" : `<table><tr><th></th><th>grader</th><th>type</th><th>weight</th><th></th><th>explanation</th></tr>${run.graders.map(graderRow).join("")}</table>`;
    return `<details${run.score < 1 ? " open" : ""}><summary>${esc(run.arm)} · run ${run.attempt} · score ${num(run.score)} · $${run.costUsd.toFixed(4)}</summary>`
        + `${run.error ? `<p class="fail">${esc(run.error)}</p>` : ""}${graders}`
        + `<details><summary>final reply</summary><pre>${esc(run.reply)}</pre></details><p class="dim">${esc(run.directory)}</p></details>`;
}

export function renderHtml({ cases, threshold, ablation, partialReason })
{
    const twoArm = ablation === "with-without";
    const deltas = cases.map((c) => c.delta).filter((d) => d !== null);
    const allRuns = cases.flatMap((c) => c.runs.filter((r) => r.arm === "with"));
    const tiles = [
        ["Suite score", num(mean(cases.map((c) => c.with).filter((x) => x !== null)))],
        ...(twoArm ? [["Ablation Δ", num(mean(deltas), true)], ["Baseline score", num(mean(cases.map((c) => c.without).filter((x) => x !== null)))]] : []),
        [`Cases ≥ ${threshold}`, `${cases.filter((c) => c.passed).length} / ${cases.length}`],
        ["Perfect runs", `${allRuns.filter((r) => r.score === 1).length} / ${allRuns.length}`],
        ["Cost (agent)", `$${cases.reduce((s, c) => s + c.costUsd, 0).toFixed(2)}`],
    ];
    const verdict = twoArm
        ? `Plugin effect: ${mean(deltas) === null ? "–" : `${mean(deltas) >= 0 ? "+" : ""}${(mean(deltas) * 100).toFixed(1)}`} pts vs baseline, improved ${deltas.filter((d) => d > 0).length}, flat ${deltas.filter((d) => d === 0).length}, regressed ${deltas.filter((d) => d < 0).length} of ${cases.length} cases`
        : `Single arm: ${cases.filter((c) => c.passed).length} of ${cases.length} cases at or above ${threshold}`;
    const caseBlocks = cases.map((c) => `<section><h2>${esc(c.case)} <span class="${c.passed ? "pass" : "fail"}">${c.passed ? "pass" : "fail"}</span></h2>`
        + `<p>${twoArm ? `with ${num(c.with)} · without ${num(c.without)} · Δ ${num(c.delta, true)}` : `score ${num(c.with)}`} · ${c.runs.length} runs · $${c.costUsd.toFixed(2)}</p>`
        + `<div class="bar"><div style="width:${Math.round((c.with ?? 0) * 100)}%"></div></div>`
        + `${c.notes ? `<p class="dim">${esc(c.notes)}</p>` : ""}${c.runs.map(runBlock).join("")}</section>`).join("");
    return `<!doctype html><html><head><meta charset="utf-8"><title>Skill evals (Pi)</title><style>
body{font:14px system-ui,sans-serif;max-width:1100px;margin:2em auto;padding:0 1em;color:#222}
.tiles{display:flex;gap:1em;flex-wrap:wrap}.tile{border:1px solid #ddd;border-radius:6px;padding:.6em 1em}.tile b{display:block;font-size:1.4em}
.pass{color:#17803d}.fail{color:#c0262d}.dim{color:#777}pre{white-space:pre-wrap;margin:0}
table{border-collapse:collapse;width:100%;margin:.5em 0}td,th{border-top:1px solid #eee;padding:.3em .5em;text-align:left;vertical-align:top}
section{border-top:2px solid #ddd;margin-top:1.5em}.bar{background:#eee;height:6px;border-radius:3px}.bar div{background:#17803d;height:6px;border-radius:3px}
details{margin:.4em 0}summary{cursor:pointer}</style></head><body>
<h1>Skill evals (Pi)</h1>${partialReason ? `<p class="fail">Partial run: ${esc(partialReason)}</p>` : ""}<p><b>${esc(verdict)}</b></p>
<div class="tiles">${tiles.map(([k, v]) => `<div class="tile">${esc(k)}<b>${esc(v)}</b></div>`).join("")}</div>${caseBlocks}</body></html>\n`;
}
