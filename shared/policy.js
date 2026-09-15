// Spend policy: the off-chain rulebook an agent operates under.
//
// The policy file is plain JSON. Its *canonical* form (sorted keys, no
// whitespace) is hashed with keccak256; that hash is what the controller
// commits on-chain via SpendLogger.setPolicy and what every PurchaseLogged
// event carries. Anyone holding the file can recompute the hash and check
// that a given purchase was within the rules in force.
//
// Enforcement happens client-side, before the agent signs a payment. The
// chain records attestation, not enforcement.
import { keccak256, toHex, getAddress, isAddress } from "viem";

/**
 * @typedef {object} SpendPolicy
 * @property {string}   version            "1"
 * @property {string}   agent              agent wallet this policy governs
 * @property {string}   controller         wallet allowed to change it (informational; chain is authoritative)
 * @property {string}   network            CAIP-2, e.g. "eip155:5042002"
 * @property {string}   asset              token address payments must use
 * @property {string}   maxPerCall         base units, e.g. "20000" ($0.02)
 * @property {string}   dailyCap           base units per UTC day
 * @property {string[]} allowedPayees      payTo addresses the agent may pay; empty = any
 * @property {string}   [description]      free text
 */

/** Deterministic JSON: keys sorted at every level, no whitespace. */
export function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** keccak256 of the canonical JSON — the on-chain policy fingerprint. */
export function policyHash(policy) {
  return keccak256(toHex(canonicalize(policy)));
}

/** Throw if the policy file is malformed. Returns a normalised copy. */
export function validatePolicy(p) {
  const must = (cond, msg) => { if (!cond) throw new Error(`policy: ${msg}`); };
  must(p && typeof p === "object", "not an object");
  must(p.version === "1", "version must be \"1\"");
  must(isAddress(p.agent), "agent must be an address");
  must(isAddress(p.controller), "controller must be an address");
  must(/^eip155:\d+$/.test(p.network), "network must be CAIP-2 eip155:<id>");
  must(isAddress(p.asset), "asset must be an address");
  must(/^\d+$/.test(p.maxPerCall), "maxPerCall must be integer base units");
  must(/^\d+$/.test(p.dailyCap), "dailyCap must be integer base units");
  must(Array.isArray(p.allowedPayees) && p.allowedPayees.every(isAddress), "allowedPayees must be addresses");
  return {
    ...p,
    agent: getAddress(p.agent),
    controller: getAddress(p.controller),
    asset: getAddress(p.asset),
    allowedPayees: p.allowedPayees.map(getAddress),
  };
}

/** Unix seconds of 00:00:00 UTC on the day containing `nowMs`. The dailyCap window resets here. */
export function utcDayStart(nowMs = Date.now()) {
  return BigInt(Math.floor(nowMs / 86_400_000) * 86_400);
}

/**
 * Sum `amount` over PurchaseLogged-style rows whose `timestamp` (unix seconds,
 * bigint) is >= `sinceSec`. Rows at exactly `sinceSec` count as today.
 */
export function sumSpentSince(rows, sinceSec) {
  let total = 0n;
  for (const r of rows) if (BigInt(r.timestamp) >= sinceSec) total += BigInt(r.amount);
  return total;
}

/**
 * Decide whether a payment offer is allowed under the policy.
 * @param {SpendPolicy} policy
 * @param {{network:string, asset:string, amount:string, payTo:string}} offer  from the 402 `accepts` entry
 * @param {bigint} spentTodayBaseUnits  what the agent has already spent this UTC day
 * @returns {{ok:true} | {ok:false, rule:string, reason:string}}
 */
export function evaluate(policy, offer, spentTodayBaseUnits) {
  const amount = BigInt(offer.amount);
  if (offer.network !== policy.network) {
    return { ok: false, rule: "network", reason: `offer on ${offer.network}, policy allows ${policy.network}` };
  }
  if (getAddress(offer.asset) !== policy.asset) {
    return { ok: false, rule: "asset", reason: `offer asset ${offer.asset}, policy allows ${policy.asset}` };
  }
  if (amount > BigInt(policy.maxPerCall)) {
    return { ok: false, rule: "maxPerCall", reason: `offer ${amount} > maxPerCall ${policy.maxPerCall}` };
  }
  if (spentTodayBaseUnits + amount > BigInt(policy.dailyCap)) {
    return { ok: false, rule: "dailyCap", reason: `spent today ${spentTodayBaseUnits} + ${amount} > dailyCap ${policy.dailyCap}` };
  }
  if (policy.allowedPayees.length && !policy.allowedPayees.includes(getAddress(offer.payTo))) {
    return { ok: false, rule: "allowedPayees", reason: `payTo ${offer.payTo} not in allow-list` };
  }
  return { ok: true };
}
