// Policy trial: run the agent against N service instances (different prices)
// in a shuffled order and tabulate what the policy did.
//
//   node policy-trial.js 3011:10000 3012:15000 3013:20000 3014:20001 3015:50000 3016:100000
//
// Each arg is <port>:<priceBaseUnits>. The agent itself does all the work;
// this just shuffles, invokes it once per case, and parses its output.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validatePolicy } from "../shared/policy.js";

const policy = validatePolicy(JSON.parse(readFileSync(new URL("../policies/arc-agent.json", import.meta.url), "utf8")));
const cases = process.argv.slice(2).map((a, i) => { const [port, price] = a.split(":"); return { n: i + 1, port: Number(port), price: BigInt(price) }; });
if (cases.length === 0) throw new Error("usage: node policy-trial.js <port>:<price> ...");

// Fisher–Yates shuffle
for (let i = cases.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [cases[i], cases[j]] = [cases[j], cases[i]]; }

const usd = (b) => `$${(Number(b) / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;
const rows = [];
console.log(`policy maxPerCall = ${policy.maxPerCall} (${usd(policy.maxPerCall)})  · dailyCap = ${usd(policy.dailyCap)}`);
console.log(`shuffled order: ${cases.map((c) => usd(c.price)).join("  ")}\n`);

for (const [k, c] of cases.entries()) {
  const expected = c.price <= BigInt(policy.maxPerCall) ? "ALLOW" : "REFUSE";
  console.log(`━━ run ${k + 1}/${cases.length}  port ${c.port}  price ${usd(c.price)}  expected ${expected}`);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ["agent.js", "--calls", "1", "--process", String(k)], {
    cwd: fileURLToPath(new URL(".", import.meta.url)), encoding: "utf8",
    env: { ...process.env, SERVICE_URL: `http://localhost:${c.port}` },
  });
  const out = (r.stdout || "") + (r.stderr || "");
  const ms = Date.now() - t0;
  const refused = out.match(/REFUSED by policy rule "([^"]+)": (.+)/);
  const paid = out.match(/paid\s+(0x[0-9a-f]{64})/);
  const logged = out.match(/logged\s+(0x[0-9a-f]{64}).*purchase #(\d+)/);
  const rated = out.match(/rated\s+(\d)\/5/);
  const outcomeTx = out.match(/rated[\s\S]*?\n\s+(0x[0-9a-f]{64})/);
  const ok200 = out.match(/✓ 200 in ([\d.]+)s/);
  const actual = refused ? "REFUSE" : paid ? "ALLOW" : "ERROR";
  const row = {
    run: k + 1, port: c.port, price: usd(c.price), expected, actual, pass: expected === actual,
    rule: refused?.[1] ?? "", detail: refused?.[2] ?? (ok200 ? `200 in ${ok200[1]}s` : (r.status !== 0 ? out.split("\n").filter(Boolean).slice(-3).join(" | ") : "")),
    payTx: paid?.[1] ?? "", logTx: logged?.[1] ?? "", purchaseId: logged?.[2] ?? "", score: rated?.[1] ?? "", outcomeTx: outcomeTx?.[1] ?? "", ms,
  };
  rows.push(row);
  console.log(`   → ${actual}${row.rule ? ` (${row.rule})` : ""}  ${row.pass ? "PASS" : "FAIL"}  ${row.detail}`);
  if (row.payTx) console.log(`     pay ${row.payTx}\n     log ${row.logTx} (#${row.purchaseId})  rated ${row.score}/5\n     out ${row.outcomeTx}`);
}

console.log("\n== summary ==");
console.log("run | price      | expected | actual | rule        | purchase | score | pass");
for (const r of rows) console.log(`${String(r.run).padEnd(3)} | ${r.price.padEnd(10)} | ${r.expected.padEnd(8)} | ${r.actual.padEnd(6)} | ${r.rule.padEnd(11)} | ${(r.purchaseId ? "#" + r.purchaseId : "-").padEnd(8)} | ${(r.score || "-").padEnd(5)} | ${r.pass ? "✓" : "✗"}`);
console.log(`\n${rows.filter((r) => r.pass).length}/${rows.length} as expected`);
