// Concurrency trial: launch N agent processes at the same instant against one
// service and see whether every call settles, logs and rates without nonce
// collisions on either wallet.
//
//   node concurrency-trial.js 4
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const N = Number(process.argv[2] ?? 4);
const cwd = fileURLToPath(new URL(".", import.meta.url));
const t0 = Date.now();
console.log(`launching ${N} agents simultaneously …\n`);

const runs = Array.from({ length: N }, (_, i) => new Promise((resolve) => {
  const p = spawn(process.execPath, ["agent.js", "--calls", "1", "--process", String(i)], { cwd, env: process.env });
  let out = "";
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (out += d));
  p.on("close", (code) => resolve({ i, code, out, ms: Date.now() - t0 }));
}));

const results = await Promise.all(runs);
console.log("agent | exit | paid tx      | log tx       | purchase | outcome tx   | ledger match | time");
let ok = 0;
for (const r of results) {
  const paid = r.out.match(/paid\s+(0x[0-9a-f]{64})/)?.[1];
  const log = r.out.match(/logged\s+(0x[0-9a-f]{64}).*purchase #(\d+)/);
  const outcome = r.out.match(/rated[\s\S]*?\n\s+(0x[0-9a-f]{64})/)?.[1];
  const match = /ledger entry matches payment/.test(r.out) ? "✓" : (/LEDGER MISMATCH/.test(r.out) ? "✗ MISMATCH" : "-");
  const err = r.out.match(/(✗ HTTP [^\n]{0,220}|nonce|replacement|underpriced|Error: [^\n]{0,80})/i)?.[0];
  const pass = r.code === 0 && paid && log && outcome && match === "✓";
  if (pass) ok++;
  console.log(`${String(r.i + 1).padEnd(5)} | ${String(r.code).padEnd(4)} | ${(paid?.slice(0, 12) ?? "-").padEnd(12)} | ${(log?.[1].slice(0, 12) ?? "-").padEnd(12)} | ${(log ? "#" + log[2] : "-").padEnd(8)} | ${(outcome?.slice(0, 12) ?? "-").padEnd(12)} | ${match.padEnd(12)} | ${(r.ms / 1000).toFixed(1)}s${err && !pass ? `   ← ${err}` : ""}`);
}
console.log(`\n${ok}/${N} fully succeeded`);
for (const r of results) {
  const paid = /paid\s+0x[0-9a-f]{64}/.test(r.out);
  if (r.code === 0 && paid) continue;
  console.log(`\n--- agent ${r.i + 1} (exit ${r.code}, ${paid ? "paid" : "NOT paid"}) ---`);
  console.log(r.out.split("\n").filter((l) => l.trim() && !/injected env/.test(l)).slice(-10).join("\n"));
}
