// Process-description → automation plan.
//
// This is the "work" an agent pays $0.01 USDC for. Today it is a deterministic
// heuristic planner (no LLM, no API key) so the demo runs anywhere. The
// exported interface is exactly what an LLM-backed version would expose, so
// swapping in a model call later touches only this file.

/**
 * @typedef {object} AutomationPlan
 * @property {string}   process_name
 * @property {string}   summary
 * @property {Array<{id:number, action:string, actor:"human"|"system"|"agent", automatable:boolean, notes:string}>} steps
 * @property {string[]} inputs
 * @property {string[]} outputs
 * @property {Array<{at_step:number, condition:string, branches:string[]}>} decision_points
 * @property {Array<{tool:string, reason:string}>} suggested_tools
 * @property {{automation_readiness:number, rationale:string}} assessment
 * @property {{engine:string, version:string, generated_at:string}} meta
 */

const HUMAN_VERBS = /\b(approve|review|sign|decide|call|meet|negotiate|interview|inspect)\b/i;
const SYSTEM_VERBS = /\b(send|email|notify|update|create|generate|calculate|export|import|upload|download|sync|post|log|record|store|validate|check|verify|extract|match|reconcile)\b/i;
const DECISION_RE = /\b(if|whether|unless|when|otherwise|depending on|in case)\b/i;
const INPUT_RE = /\b(invoice|form|email|request|order|ticket|document|pdf|spreadsheet|csv|file|record|application|receipt|report|data)\b/gi;
const OUTPUT_RE = /\b(report|confirmation|receipt|summary|notification|approval|entry|record|payment|invoice|ticket|export)\b/gi;

const TOOL_RULES = [
  [/\b(email|inbox|outlook|gmail)\b/i, "Power Automate — Outlook/Gmail connector", "email-triggered steps"],
  [/\b(pdf|invoice|receipt|scan|ocr|extract)\b/i, "Azure AI Document Intelligence", "structured extraction from documents"],
  [/\b(excel|spreadsheet|csv|sheet)\b/i, "Power Automate — Excel Online / Google Sheets", "tabular data read/write"],
  [/\b(sap|erp|oracle|dynamics|netsuite|xero|quickbooks)\b/i, "Blue Prism — ERP object layer", "legacy ERP UI/API automation"],
  [/\b(approve|approval|sign-off|review)\b/i, "Power Automate — Approvals", "human-in-the-loop decision gates"],
  [/\b(api|webhook|json|endpoint|http)\b/i, "n8n or Make", "API orchestration with retries"],
  [/\b(pay|payment|usdc|transfer|settle)\b/i, "x402 + SpendLogger on Arc", "agent-initiated payments with an on-chain audit trail"],
  [/\b(customer|client|ticket|support|crm)\b/i, "HubSpot / Zendesk connector", "CRM and ticket updates"],
];

const uniq = (arr) => [...new Set(arr.map((s) => s.toLowerCase()))];

function splitSteps(text) {
  return text
    .replace(/\r/g, "")
    .split(/(?<=[.;!?])\s+|\n+|\s+then\s+|\s*->\s*|\s*→\s*/i)
    .map((s) => s.trim().replace(/^\d+[.)]\s*/, "").replace(/^(and|then|next|finally|after that)\s+/i, ""))
    .filter((s) => s.length > 2);
}

/**
 * @param {string} description plain-text business process
 * @returns {Promise<AutomationPlan>}
 */
export async function generatePlan(description) {
  const text = String(description ?? "").trim();
  const sentences = splitSteps(text);

  const steps = sentences.map((s, i) => {
    const human = HUMAN_VERBS.test(s);
    const system = SYSTEM_VERBS.test(s);
    const actor = human ? "human" : system ? "system" : "agent";
    return {
      id: i + 1,
      action: s.charAt(0).toUpperCase() + s.slice(1),
      actor,
      automatable: !human,
      notes: human
        ? "Requires judgement or authority — keep a human gate, automate the hand-off."
        : system
          ? "Deterministic system action — good RPA / workflow candidate."
          : "Agent-suitable: needs interpretation but not authority.",
    };
  });

  const decision_points = sentences
    .map((s, i) => (DECISION_RE.test(s) ? {
      at_step: i + 1,
      condition: s,
      branches: ["condition met → continue", "condition not met → route to exception queue"],
    } : null))
    .filter(Boolean);

  const inputs = uniq(text.match(INPUT_RE) ?? []).slice(0, 8);
  const outputs = uniq(text.match(OUTPUT_RE) ?? []).filter((o) => !inputs.includes(o)).slice(0, 6);

  const suggested_tools = TOOL_RULES
    .filter(([re]) => re.test(text))
    .map(([, tool, reason]) => ({ tool, reason }));
  if (suggested_tools.length === 0) {
    suggested_tools.push({ tool: "Power Automate", reason: "general-purpose workflow engine for the described steps" });
  }

  const automatable = steps.filter((s) => s.automatable).length;
  const readiness = steps.length ? Math.round((automatable / steps.length) * 100) : 0;

  return {
    process_name: (sentences[0] ?? "Untitled process").slice(0, 60),
    summary: `${steps.length} step(s) identified, ${automatable} automatable, ${decision_points.length} decision point(s).`,
    steps,
    inputs: inputs.length ? inputs : ["(none detected — specify inputs explicitly)"],
    outputs: outputs.length ? outputs : ["(none detected — specify outputs explicitly)"],
    decision_points,
    suggested_tools,
    assessment: {
      automation_readiness: readiness,
      rationale: readiness >= 70
        ? "Mostly deterministic system steps; strong candidate for end-to-end automation."
        : readiness >= 40
          ? "Mixed human/system steps; automate the system steps and orchestrate the human gates."
          : "Dominated by human judgement; automate intake and hand-offs only.",
    },
    meta: { engine: "heuristic-planner", version: "0.1.0", generated_at: new Date().toISOString() },
  };
}
