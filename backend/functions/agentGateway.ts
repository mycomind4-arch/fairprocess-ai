import { createClientFromRequest } from "npm:@base44/sdk@0.8.31";

const GUARDRAIL = "You identify evidentiary status. You do not render legal conclusions.";

const GUARDRAIL_REWRITES = {
  "non-compliant": "deviation detected",
  "compliant": "matches expected window",
  "violation": "deviation detected",
  "unlawful": "deviation detected",
  "invalid": "conflict identified",
  "void": "conflict identified",
  "guilty": "evidence suggests",
  "liable": "evidence suggests"
};

function applyGuardrail(text) {
  let rewritten = text;
  const blocks = [];
  for (const [blocked, replacement] of Object.entries(GUARDRAIL_REWRITES)) {
    const regex = new RegExp(blocked, "gi");
    if (regex.test(rewritten)) {
      rewritten = rewritten.replace(regex, replacement);
      blocks.push({ blocked, replacement });
    }
  }
  return { text: rewritten, blocks };
}

async function sha256(text) {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function tier1Route(pageContext, message) {
  const msg = (message || "").toLowerCase();
  if (msg.includes("compliant") || msg.includes("deadline") || msg.includes("mailing") || msg.includes("on time")) {
    return { agents: ["timeline", "statute_matching"], sequential: false };
  }
  if (msg.includes("discrepanc") || msg.includes("conflict") || msg.includes("mismatch")) {
    return { agents: ["discrepancy"], sequential: false };
  }
  if (msg.includes("timeline") || msg.includes("sequence") || msg.includes("gap")) {
    return { agents: ["timeline"], sequential: false };
  }
  if (msg.includes("statute") || msg.includes("rule") || msg.includes("code")) {
    return { agents: ["statute_matching"], sequential: false };
  }
  return null;
}

function tier2Route() {
  return { agents: ["statute_matching", "timeline"], sequential: false };
}

async function executeAgent(agentKey, message, caseContext) {
  let output;
  if (agentKey === "statute_matching") {
    output = {
      statute_ref: "HCC § 351-7",
      required_rule: "Mailing within 3 business days of execution",
      actual_event: { execution_date: "2026-07-15", postmark_date: "2026-07-24", elapsed_days: 9, claimed_mailing_date: "2026-07-22" },
      status: "deviation detected",
      note: "9 days between execution and postmark exceeds the 3-business-day requirement."
    };
  } else if (agentKey === "timeline") {
    output = {
      events: [
        { date: "2026-07-15", event: "Citation executed", status: "verified" },
        { date: "2026-07-22", event: "Citation mailed (claimed)", status: "conflict" },
        { date: "2026-07-24", event: "Postmark date (actual)", status: "conflict" }
      ],
      gaps: [{ from: "2026-07-15", to: "2026-07-24", days: 9, expected_max: 3, flagged: true }]
    };
  } else if (agentKey === "discrepancy") {
    output = {
      conflict_type: "date_mismatch",
      source_a: { doc: "Citation CE26-0402", claim: "Mailed Jul 22, 2026" },
      source_b: { doc: "Postmark Certificate", claim: "Postmarked Jul 24, 2026" },
      characterization: "Citation claims Jul 22 mailing but postmark shows Jul 24. 2-day discrepancy identified. Agent does not resolve which is correct.",
      status: "open"
    };
  } else if (agentKey === "fact_extraction") {
    output = {
      facts: [
        { fact_id: "f_001", text: "Citation executed on Jul 15, 2026", source_doc: "citation.pdf", date: "2026-07-15", confidence: 0.98 },
        { fact_id: "f_002", text: "Citation claims mailing Jul 22, 2026", source_doc: "citation.pdf", date: "2026-07-22", confidence: 0.95 },
        { fact_id: "f_003", text: "USPS postmark Jul 24, 2026", source_doc: "postmark.pdf", date: "2026-07-24", confidence: 0.99 }
      ]
    };
  } else {
    output = { status: "success", note: "Agent executed" };
  }

  const outputStr = JSON.stringify(output);
  const { text: guardedStr, blocks } = applyGuardrail(outputStr);
  if (blocks.length > 0) {
    try { output = JSON.parse(guardedStr); } catch (e) { /* keep original */ }
    output._guardrail_blocks = blocks;
  }

  return {
    agent_name: agentKey.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()) + " Agent",
    agent_key: agentKey,
    status: "success",
    output,
    guardrail_blocks: blocks
  };
}

Deno.serve(async (req) => {
  try {
    const body = await req.json();
    const { case_id, page_context, message, attachment_ids } = body;

    if (!case_id) {
      return new Response(JSON.stringify({ error: "case_id is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    const base44 = createClientFromRequest(req);
    const startedAt = new Date().toISOString();

    // Load CaseContext
    let caseContext = null;
    try {
      const contexts = await base44.entities.CaseContext.list({ filter: { case_id } });
      caseContext = contexts[0] || null;
    } catch (e) {
      caseContext = { case_id, verified_facts: [], open_discrepancies: [], active_statutes: [] };
    }

    // Route through orchestrator
    let routing = tier1Route(page_context, message);
    if (!routing) routing = tier2Route();

    // Log invocation
    try {
      await base44.entities.AgentInvocation.create({
        case_id,
        page_context: page_context || "unknown",
        message: message || "",
        agents_selected: routing.agents,
        created_at: startedAt
      });
    } catch (e) { /* non-blocking */ }

    // Execute agents
    const agentResults = [];
    if (routing.sequential) {
      for (const agentKey of routing.agents) {
        const result = await executeAgent(agentKey, message, caseContext);
        agentResults.push(result);
      }
    } else {
      const results = await Promise.all(
        routing.agents.map((k) => executeAgent(k, message, caseContext))
      );
      agentResults.push(...results);
    }

    const completedAt = new Date().toISOString();
    const updatedFields = [];
    const newDiscrepancies = [];
    let responseText = "";

    for (const r of agentResults) {
      if (r.output && r.output.conflict_type) {
        newDiscrepancies.push(r.output);
        updatedFields.push("open_discrepancies");
      }
      if (r.output && r.output.facts) {
        updatedFields.push("verified_facts");
      }
    }

    // Build response text
    const sm = agentResults.find((r) => r.agent_key === "statute_matching");
    if (sm) {
      responseText = `Analysis for case ${case_id}: Under ${sm.output.statute_ref}, the required rule is "${sm.output.required_rule}". The actual elapsed time is ${sm.output.actual_event?.elapsed_days || "unknown"} days. Status: ${sm.output.status}.`;
      if (sm.output.note) responseText += ` ${sm.output.note}`;
    } else {
      responseText = `Analysis complete for case ${case_id}. ${routing.agents.length} agent(s) executed.`;
    }

    // Update CaseContext
    try {
      const updateData = {
        case_id,
        last_updated_by_agent: routing.agents.join(", "),
        updated_at: completedAt
      };
      if (newDiscrepancies.length > 0) {
        updateData.open_discrepancies = [...(caseContext.open_discrepancies || []), ...newDiscrepancies];
      }
      if (agentResults.some((r) => r.output?.facts)) {
        const allFacts = agentResults.flatMap((r) => r.output.facts || []);
        updateData.verified_facts = [...(caseContext.verified_facts || []), ...allFacts];
      }
      if (caseContext?.id) {
        await base44.entities.CaseContext.update(caseContext.id, updateData);
      } else {
        await base44.entities.CaseContext.create(updateData);
      }
    } catch (e) { /* non-blocking */ }

    // Write AgentRun records (SHA-256 hashed)
    const ledgerEntries = [];
    for (const result of agentResults) {
      const ledgerText = JSON.stringify({
        case_id,
        agent_name: result.agent_name,
        started_at: startedAt,
        completed_at: completedAt,
        output: result.output
      });
      let hash = "";
      try {
        hash = await sha256(ledgerText);
      } catch (e) {
        hash = "unavailable";
      }

      try {
        await base44.entities.AgentRun.create({
          case_id,
          agent_name: result.agent_name,
          triggered_by: "system",
          input_summary: message || "",
          output: result.output,
          status: result.status,
          started_at: startedAt,
          completed_at: completedAt,
          ledger_hash: hash
        });
        ledgerEntries.push({
          agent: result.agent_name,
          hash: hash.substring(0, 12),
          guardrail_blocks: result.guardrail_blocks || []
        });
      } catch (e) { /* non-blocking */ }
    }

    return new Response(JSON.stringify({
      response_text: responseText,
      agents_used: routing.agents,
      updated_fields: [...new Set(updatedFields)],
      new_discrepancies: newDiscrepancies,
      ledger_entries: ledgerEntries,
      guardrail_blocks: agentResults.flatMap((r) => r.guardrail_blocks || [])
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
