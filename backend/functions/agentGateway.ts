import { createClientFromRequest } from "npm:@base44/sdk@0.8.31";

// ===== Neutrality Guardrail =====
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

// ===== Cloudflare Workers AI =====
const CF_MODEL = "@cf/meta/llama-3.1-8b-instruct";

async function callCloudflareAI(systemPrompt, userPrompt, maxTokens = 1024) {
  const apiToken = Deno.env.get("CLOUDFLARE_API_TOKEN");
  const accountId = Deno.env.get("CLOUDFLARE_ACCOUNT_ID");

  if (!apiToken || !accountId) {
    throw new Error("Cloudflare credentials not configured");
  }

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${CF_MODEL}`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        max_tokens: maxTokens,
        temperature: 0.3
      })
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Cloudflare AI error ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  const content = data.result?.choices?.[0]?.message?.content || data.result?.response || "";

  // Try to extract JSON from the response
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch (e) {
      // Return raw content if JSON parsing fails
      return { raw_response: content };
    }
  }
  return { raw_response: content };
}

// ===== Agent System Prompts =====

const SYSTEM_PROMPTS = {
  statute_matching: `You are a Statute Matching Agent for a jurisdiction intelligence system.
${GUARDRAIL}
Given a set of verified facts with dates and a list of statutes with deadline rules, analyze whether the elapsed time between consecutive events matches the required deadline.

For each statute, determine:
- Whether the elapsed time is within (max) or at least (min) the required deadline
- Status: "matches expected window" or "deviation detected"
- A factual note describing the calculation

NEVER use words: "compliant", "non-compliant", "violation", "unlawful", "invalid", "void", "guilty", "liable".
Instead use: "matches expected window", "deviation detected", "conflict identified", "evidence suggests".

Return ONLY valid JSON in this format:
{
  "results": [
    {
      "statute_ref": "statute reference",
      "required_rule": "the rule description",
      "actual_event": { "start_date": "date", "end_date": "date", "elapsed_days": number, "deadline_direction": "max or min" },
      "status": "matches expected window" or "deviation detected",
      "note": "factual note about the calculation"
    }
  ]
}`,

  timeline: `You are a Timeline Agent for a jurisdiction intelligence system.
${GUARDRAIL}
Given a set of verified facts with dates, sequence them chronologically and identify time gaps between consecutive events.

Flag any gap longer than 7 days as potentially significant.

NEVER use legal conclusion words. Use "verified" for confirmed events, "conflict" for disputed ones.

Return ONLY valid JSON:
{
  "events": [
    { "date": "date", "event": "description", "status": "verified" or "conflict", "source_doc": "source" }
  ],
  "gaps": [
    { "from": "date", "to": "date", "days": number, "from_event": "desc", "to_event": "desc", "flagged": boolean }
  ]
}`,

  discrepancy: `You are a Discrepancy Agent for a jurisdiction intelligence system.
${GUARDRAIL}
Given a set of verified facts from different source documents, identify conflicts:
1. Same-date facts with different claims (fact_mismatch)
2. Mailing/postmark/sending/delivery facts with different dates (date_mismatch)

For each conflict, describe what each source claims but DO NOT resolve which is accurate.

NEVER use legal conclusion words. Characterize the conflict neutrally.

Return ONLY valid JSON:
{
  "conflicts": [
    {
      "conflict_type": "fact_mismatch" or "date_mismatch",
      "source_a": { "doc": "source", "text": "claim", "date": "date if applicable" },
      "source_b": { "doc": "source", "text": "claim", "date": "date if applicable" },
      "characterization": "neutral description of the conflict",
      "status": "open"
    }
  ]
}`,

  fact_extraction: `You are a Fact Extraction Agent for a jurisdiction intelligence system.
${GUARDRAIL}
Given document text, extract factual statements that contain dates. For each fact:
- Assign a fact_id
- Record the source document
- Extract the date mentioned
- Assign a confidence score (0.0-1.0)

Only extract factual statements, not opinions or legal conclusions.

Return ONLY valid JSON:
{
  "facts": [
    {
      "fact_id": "f_001",
      "text": "the factual statement",
      "source_doc": "document name",
      "date": "date in YYYY-MM-DD format if determinable",
      "confidence": 0.95
    }
  ]
}`
};

// ===== Build user prompts from case context =====

function buildStatutePrompt(caseContext) {
  const facts = caseContext?.verified_facts || [];
  const statutes = [
    { ref: "HCC § 351-7", description: "Citation shall be mailed within 3 business days of execution. Mailing date = postmark date.", deadline_type: "business_days", deadline_value: 3, deadline_direction: "max" },
    { ref: "HCC § 351-12", description: "Notice published at least 10 days before hearing date.", deadline_type: "calendar_days", deadline_value: 10, deadline_direction: "min" },
    { ref: "CA Gov Code § 65852.2", description: "Approve or disapprove ADU application within 60 days of complete application.", deadline_type: "calendar_days", deadline_value: 60, deadline_direction: "max" },
    { ref: "HCC § 4.2", description: "Notice posted and mailed within 5 business days of enforcement action.", deadline_type: "business_days", deadline_value: 5, deadline_direction: "max" }
  ];

  return `Verified facts for case ${caseContext?.case_id}:
${JSON.stringify(facts, null, 2)}

Statutes to check against:
${JSON.stringify(statutes, null, 2)}

Analyze each consecutive pair of facts against each statute. Calculate elapsed days (business days exclude weekends). Determine if the elapsed time matches the required deadline.`;
}

function buildTimelinePrompt(caseContext) {
  const facts = caseContext?.verified_facts || [];
  return `Verified facts for case ${caseContext?.case_id}:
${JSON.stringify(facts, null, 2)}

Sequence these facts chronologically by date. Identify gaps between consecutive events. Flag gaps over 7 days.`;
}

function buildDiscrepancyPrompt(caseContext) {
  const facts = caseContext?.verified_facts || [];
  return `Verified facts for case ${caseContext?.case_id}:
${JSON.stringify(facts, null, 2)}

Identify conflicts between these facts:
1. Same-date facts with different claims
2. Facts about mailing/postmark/sending/delivery with different dates
Do NOT resolve which source is accurate. Just characterize the conflict.`;
}

function buildFactExtractionPrompt(documentText, documentName) {
  return `Document name: ${documentName || "unknown"}
Document text:
${documentText}

Extract all factual statements that contain dates. Convert dates to YYYY-MM-DD format. Assign confidence scores.`;
}

// ===== LLM-powered agent executors =====

async function execStatuteMatching(input, caseContext) {
  try {
    const result = await callCloudflareAI(
      SYSTEM_PROMPTS.statute_matching,
      buildStatutePrompt(caseContext),
      1024
    );
    // Apply guardrail to each result note
    if (result.results) {
      for (const r of result.results) {
        if (r.note) {
          const guarded = applyGuardrail(r.note);
          r.note = guarded.text;
          r.guardrail_blocks = guarded.blocks;
        }
      }
    }
    return {
      agent_name: "Statute Matching Agent", agent_key: "statute_matching",
      status: "success", output: result,
      guardrail_blocks: result.results?.flatMap(r => r.guardrail_blocks || []) || []
    };
  } catch (e) {
    return {
      agent_name: "Statute Matching Agent", agent_key: "statute_matching",
      status: "error", output: { error: e.message },
      guardrail_blocks: []
    };
  }
}

async function execTimeline(input, caseContext) {
  try {
    const result = await callCloudflareAI(
      SYSTEM_PROMPTS.timeline,
      buildTimelinePrompt(caseContext),
      1024
    );
    return {
      agent_name: "Timeline Agent", agent_key: "timeline",
      status: "success", output: result,
      guardrail_blocks: []
    };
  } catch (e) {
    return {
      agent_name: "Timeline Agent", agent_key: "timeline",
      status: "error", output: { error: e.message },
      guardrail_blocks: []
    };
  }
}

async function execDiscrepancy(input, caseContext) {
  try {
    const result = await callCloudflareAI(
      SYSTEM_PROMPTS.discrepancy,
      buildDiscrepancyPrompt(caseContext),
      1024
    );
    return {
      agent_name: "Discrepancy Agent", agent_key: "discrepancy",
      status: result.conflicts?.length > 0 ? "success" : "partial",
      output: result,
      guardrail_blocks: []
    };
  } catch (e) {
    return {
      agent_name: "Discrepancy Agent", agent_key: "discrepancy",
      status: "error", output: { error: e.message },
      guardrail_blocks: []
    };
  }
}

async function execFactExtraction(input, caseContext) {
  const text = input.document_text || "";
  if (!text) {
    return {
      agent_name: "Fact Extraction Agent", agent_key: "fact_extraction",
      status: "partial", output: { facts: [], note: "No document text provided" },
      guardrail_blocks: []
    };
  }
  try {
    const result = await callCloudflareAI(
      SYSTEM_PROMPTS.fact_extraction,
      buildFactExtractionPrompt(text, input.document_name),
      1024
    );
    return {
      agent_name: "Fact Extraction Agent", agent_key: "fact_extraction",
      status: result.facts?.length > 0 ? "success" : "partial",
      output: result,
      guardrail_blocks: []
    };
  } catch (e) {
    return {
      agent_name: "Fact Extraction Agent", agent_key: "fact_extraction",
      status: "error", output: { error: e.message },
      guardrail_blocks: []
    };
  }
}

const EXECUTORS = {
  statute_matching: execStatuteMatching,
  timeline: execTimeline,
  discrepancy: execDiscrepancy,
  fact_extraction: execFactExtraction
};

// ===== Tier 1 routing =====
function tier1Route(pageContext, message) {
  const msg = (message || "").toLowerCase();
  if (pageContext === "evidence_viewer" && (msg.includes("upload") || msg.includes("document"))) {
    return { agents: ["fact_extraction", "timeline"], sequential: true };
  }
  if (pageContext === "policy_studio" && (msg.includes("edit") || msg.includes("publish") || msg.includes("rule"))) {
    return { agents: ["statute_matching"], sequential: false };
  }
  if (msg.includes("compliant") || msg.includes("deadline") || msg.includes("mailing") || msg.includes("on time")) {
    return { agents: ["timeline", "statute_matching"], sequential: false };
  }
  if (msg.includes("discrepanc") || msg.includes("conflict") || msg.includes("mismatch")) {
    return { agents: ["discrepancy", "statute_matching"], sequential: false };
  }
  if (msg.includes("timeline") || msg.includes("sequence") || msg.includes("gap") || msg.includes("when")) {
    return { agents: ["timeline"], sequential: false };
  }
  if (msg.includes("statute") || msg.includes("rule") || msg.includes("code")) {
    return { agents: ["statute_matching"], sequential: false };
  }
  if (msg.includes("upload") || msg.includes("document") || msg.includes("evidence")) {
    return { agents: ["fact_extraction"], sequential: false };
  }
  return null;
}

function tier2Route() {
  return { agents: ["statute_matching", "timeline"], sequential: false };
}

// ===== Main gateway =====
Deno.serve(async (req) => {
  try {
    const body = await req.json();
    const { case_id, page_context, message, document_text, document_name } = body;

    if (!case_id) {
      return new Response(JSON.stringify({ error: "case_id is required" }), {
        status: 400, headers: { "Content-Type": "application/json" }
      });
    }

    const base44 = createClientFromRequest(req);
    const startedAt = new Date().toISOString();

    // Load CaseContext
    let caseContext = null;
    try {
      const contexts = await base44.entities.CaseContext.filter({ case_id });
      if (contexts && contexts.length > 0) {
        caseContext = contexts
          .sort((a, b) => (b.verified_facts?.length || 0) - (a.verified_facts?.length || 0))[0];
      }
    } catch (e) { /* fall through */ }

    if (!caseContext) {
      caseContext = { case_id, verified_facts: [], open_discrepancies: [], active_statutes: [] };
    }

    // Route
    let routing = tier1Route(page_context, message);
    if (!routing) routing = tier2Route();

    // Log invocation
    try {
      await base44.entities.AgentInvocation.create({
        case_id, page_context: page_context || "unknown", message: message || "",
        agents_selected: routing.agents, created_at: startedAt
      });
    } catch (e) { /* non-blocking */ }

    // Execute agents (all async now — LLM calls)
    const input = { message, document_text, document_name, caseContext };
    const agentResults = [];

    if (routing.sequential) {
      let acc = { ...caseContext };
      for (const agentKey of routing.agents) {
        const executor = EXECUTORS[agentKey];
        if (!executor) continue;
        const result = await executor(input, acc);
        if (result.output?.facts) {
          acc.verified_facts = [...(acc.verified_facts || []), ...result.output.facts];
        }
        agentResults.push(result);
      }
    } else {
      // Run agents in parallel
      const promises = routing.agents
        .filter(k => EXECUTORS[k])
        .map(k => EXECUTORS[k](input, caseContext));
      const results = await Promise.all(promises);
      agentResults.push(...results);
    }

    const completedAt = new Date().toISOString();
    const updatedFields = [];
    const newDiscrepancies = [];
    let responseText = "";

    for (const r of agentResults) {
      if (r.output?.conflicts) {
        newDiscrepancies.push(...r.output.conflicts);
        updatedFields.push("open_discrepancies");
      }
      if (r.output?.facts) updatedFields.push("verified_facts");
      if (r.output?.results) updatedFields.push("statute_analysis");
    }

    const sm = agentResults.find(r => r.agent_key === "statute_matching");
    const tl = agentResults.find(r => r.agent_key === "timeline");
    const da = agentResults.find(r => r.agent_key === "discrepancy");

    // Build response text from LLM outputs
    if (da && da.output?.conflicts?.length > 0) {
      responseText = `${da.output.conflicts.length} discrepancy(ies) found. ${da.output.conflicts[0].characterization || da.output.conflicts[0].source_a?.text + " vs " + da.output.conflicts[0].source_b?.text}`;
      if (sm && sm.output?.results?.length > 0) {
        const deviations = sm.output.results.filter(r => r.status === "deviation detected");
        if (deviations.length > 0) responseText += ` Additionally, ${deviations.length} statute deviation(s) detected.`;
      }
    } else if (sm && sm.output?.results?.length > 0) {
      const deviations = sm.output.results.filter(r => r.status === "deviation detected");
      const matches = sm.output.results.filter(r => r.status === "matches expected window");
      const r = sm.output.results[0];
      responseText = `Analysis for case ${case_id}: Under ${r.statute_ref}, the required rule is "${r.required_rule}". Actual elapsed: ${r.actual_event?.elapsed_days || "unknown"} days. Status: ${r.status}.`;
      if (r.note) responseText += ` ${r.note}`;
      if (deviations.length > 0) responseText += ` ${deviations.length} deviation(s) detected.`;
      if (matches.length > 0) responseText += ` ${matches.length} statute check(s) match expected window.`;
    } else if (tl && tl.output?.events?.length > 0) {
      const flagged = tl.output.gaps?.filter(g => g.flagged)?.length || 0;
      responseText = `Timeline analysis for ${case_id}: ${tl.output.events.length} events sequenced, ${tl.output.gaps?.length || 0} gap(s) found, ${flagged} flagged.`;
    } else {
      const errors = agentResults.filter(r => r.status === "error");
      if (errors.length > 0) {
        responseText = `Analysis for ${case_id} encountered errors: ${errors.map(e => e.agent_name + ": " + e.output?.error).join("; ")}`;
      } else {
        responseText = `Analysis complete for ${case_id}. ${routing.agents.length} agent(s) executed.`;
      }
    }

    // Update CaseContext
    try {
      const updateData = {
        case_id, last_updated_by_agent: routing.agents.join(", "), updated_at: completedAt
      };
      if (newDiscrepancies.length > 0) {
        updateData.open_discrepancies = [...(caseContext.open_discrepancies || []), ...newDiscrepancies];
      }
      const newFacts = agentResults.flatMap(r => r.output?.facts || []);
      if (newFacts.length > 0) {
        updateData.verified_facts = [...(caseContext.verified_facts || []), ...newFacts];
      }
      if (caseContext?.id) {
        await base44.entities.CaseContext.update(caseContext.id, updateData);
      } else {
        await base44.entities.CaseContext.create(updateData);
      }
    } catch (e) { /* non-blocking */ }

    // Write AgentRun records with SHA-256 hashes
    const ledgerEntries = [];
    for (const result of agentResults) {
      const ledgerText = JSON.stringify({
        case_id, agent_name: result.agent_name,
        started_at: startedAt, completed_at: completedAt,
        output: result.output, model: CF_MODEL
      });
      let hash = "unavailable";
      try { hash = await sha256(ledgerText); } catch (e) {}
      try {
        await base44.entities.AgentRun.create({
          case_id, agent_name: result.agent_name, triggered_by: "system",
          input_summary: message || "", output: result.output, status: result.status,
          started_at: startedAt, completed_at: completedAt, ledger_hash: hash
        });
        ledgerEntries.push({
          agent: result.agent_name, hash: hash.substring(0, 12),
          status: result.status, guardrail_blocks: result.guardrail_blocks || []
        });
      } catch (e) { /* non-blocking */ }
    }

    return new Response(JSON.stringify({
      response_text: responseText,
      agents_used: routing.agents,
      updated_fields: [...new Set(updatedFields)],
      new_discrepancies: newDiscrepancies,
      statute_results: sm?.output?.results || [],
      timeline_events: tl?.output?.events || [],
      timeline_gaps: tl?.output?.gaps || [],
      llm_model: CF_MODEL,
      ledger_entries: ledgerEntries,
      guardrail_blocks: agentResults.flatMap(r => r.guardrail_blocks || []),
      guardrail: GUARDRAIL
    }), {
      status: 200, headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { "Content-Type": "application/json" }
    });
  }
});
