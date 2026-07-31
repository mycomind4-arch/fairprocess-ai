import { createClientFromRequest } from "npm:@base44/sdk@0.8.31";

const GUARDRAIL = "You identify evidentiary status. You do not render legal conclusions.";

async function sha256(text) {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  try {
    const body = await req.json();
    const { case_id, facts, verified_facts } = body;

    if (!case_id) {
      return new Response(JSON.stringify({ error: "case_id is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    const base44 = createClientFromRequest(req);
    const startedAt = new Date().toISOString();

    // Compare new facts against existing verified facts for conflicts
    const existingFacts = verified_facts || [];
    const conflicts = [];

    for (const newFact of (facts || [])) {
      for (const existing of existingFacts) {
        // Same date, different claims = potential conflict
        if (newFact.date && existing.date && newFact.date === existing.date) {
          if (newFact.text !== existing.text) {
            conflicts.push({
              conflict_type: "fact_mismatch",
              date: newFact.date,
              source_a: { doc: existing.source_doc, text: existing.text },
              source_b: { doc: newFact.source_doc, text: newFact.text },
              characterization: `Conflict on ${newFact.date}: "${existing.text}" (${existing.source_doc}) vs "${newFact.text}" (${newFact.source_doc}). Agent characterizes this conflict but does not resolve which is accurate.`,
              status: "open"
            });
          }
        }
      }
    }

    const completedAt = new Date().toISOString();
    const ledgerText = JSON.stringify({
      case_id,
      agent_name: "Discrepancy Agent",
      started_at: startedAt,
      completed_at: completedAt,
      output: { conflicts, facts_checked: (facts || []).length, existing_facts: existingFacts.length }
    });
    let hash = "unavailable";
    try { hash = await sha256(ledgerText); } catch (e) {}

    try {
      await base44.entities.AgentRun.create({
        case_id,
        agent_name: "Discrepancy Agent",
        triggered_by: "system",
        input_summary: `Checked ${(facts || []).length} new facts against ${existingFacts.length} verified facts`,
        output: { conflicts, guardrail: GUARDRAIL },
        status: conflicts.length > 0 ? "success" : "partial",
        started_at: startedAt,
        completed_at: completedAt,
        ledger_hash: hash
      });
    } catch (e) { /* non-blocking */ }

    return new Response(JSON.stringify({
      case_id,
      conflicts,
      conflicts_found: conflicts.length,
      guardrail: GUARDRAIL,
      ledger_hash: hash.substring(0, 12),
      agent: "discrepancy_agent"
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
});
