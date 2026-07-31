// FairProcess V3 — Cloudflare Worker (Gateway + Specialist Agents)
// Bindings: DB (D1), DOCUMENTS (R2), AI (Workers AI)

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

function uuid() {
  return crypto.randomUUID();
}

// ===== Cloudflare Workers AI =====
const CF_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

async function callAI(env, systemPrompt, userPrompt, maxTokens) {
  maxTokens = maxTokens || 1024;
  const response = await env.AI.run(CF_MODEL, {
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ],
    max_tokens: maxTokens,
    temperature: 0.3
  });

  // Handle multiple response formats from the AI binding
  let content = "";
  if (typeof response === "string") {
    content = response;
  } else if (response.response && typeof response.response === "string") {
    content = response.response;
  } else if (response.choices?.[0]?.message?.content) {
    content = response.choices[0].message.content;
  } else if (response.result?.choices?.[0]?.message?.content) {
    content = response.result.choices[0].message.content;
  } else if (response.result?.response) {
    content = response.result.response;
  } else {
    content = JSON.stringify(response);
  }

  // Strip markdown code blocks if present
  content = content.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();

  // Extract and parse JSON
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch (e) {
      return { raw_response: content };
    }
  }
  return { raw_response: content };
}

// ===== System Prompts =====
const SYSTEM_PROMPTS = {
  statute_matching: `You are a Statute Matching Agent for a jurisdiction intelligence system.
${GUARDRAIL}
Given verified facts with dates and statutes with deadline rules, analyze whether elapsed time between consecutive events matches the required deadline.

For each statute determine:
- Whether elapsed time is within (max) or at least (min) the required deadline
- Status: "matches expected window" or "deviation detected"
- A factual note about the calculation

NEVER use: "compliant", "non-compliant", "violation", "unlawful", "invalid", "void", "guilty", "liable".
Use: "matches expected window", "deviation detected", "conflict identified", "evidence suggests".

Return ONLY compact JSON (no markdown, no extra text):
{"results":[{"statute_ref":"ref","required_rule":"rule","elapsed_days":0,"deadline_direction":"max or min","status":"matches expected window or deviation detected","note":"brief note"}]}`,

  timeline: `You are a Timeline Agent for a jurisdiction intelligence system.
${GUARDRAIL}
Given verified facts with dates, sequence them chronologically and identify time gaps. Flag gaps over 7 days.

NEVER use legal conclusion words. Use "verified" for confirmed events, "conflict" for disputed.

Return ONLY valid JSON with no markdown formatting:
{"events":[{"date":"date","event":"desc","status":"verified or conflict","source_doc":"source"}],"gaps":[{"from":"date","to":"date","days":0,"from_event":"desc","to_event":"desc","flagged":true}]}`,

  discrepancy: `You are a Discrepancy Agent for a jurisdiction intelligence system.
${GUARDRAIL}
Given verified facts from different source documents, identify conflicts:
1. Same-date facts with different claims (fact_mismatch)
2. Mailing/postmark/sending/delivery facts with different dates (date_mismatch)
DO NOT resolve which is accurate. Characterize neutrally.

NEVER use legal conclusion words.

Return ONLY valid JSON with no markdown formatting:
{"conflicts":[{"conflict_type":"fact_mismatch or date_mismatch","source_a":{"doc":"source","text":"claim","date":"date"},"source_b":{"doc":"source","text":"claim","date":"date"},"characterization":"neutral description","status":"open"}]}`,

  fact_extraction: `You are a Fact Extraction Agent for a jurisdiction intelligence system.
${GUARDRAIL}
Given document text, extract factual statements containing dates. Convert dates to YYYY-MM-DD format. Assign confidence 0.0-1.0.

Return ONLY valid JSON with no markdown formatting:
{"facts":[{"fact_id":"f_001","text":"statement","source_doc":"name","date":"YYYY-MM-DD","confidence":0.95}]}`
};

// ===== Statutes =====
const STATUTES = [
  { ref: "HCC \u00a7 351-7", description: "Citation shall be mailed within 3 business days of execution. Mailing date = postmark date.", deadline_type: "business_days", deadline_value: 3, deadline_direction: "max" },
  { ref: "HCC \u00a7 351-12", description: "Notice published at least 10 days before hearing date.", deadline_type: "calendar_days", deadline_value: 10, deadline_direction: "min" },
  { ref: "CA Gov Code \u00a7 65852.2", description: "Approve or disapprove ADU application within 60 days of complete application.", deadline_type: "calendar_days", deadline_value: 60, deadline_direction: "max" },
  { ref: "HCC \u00a7 4.2", description: "Notice posted and mailed within 5 business days of enforcement action.", deadline_type: "business_days", deadline_value: 5, deadline_direction: "max" }
];

// ===== Prompt Builders =====
function buildStatutePrompt(caseId, facts) {
  return `Verified facts for case ${caseId}:\n${JSON.stringify(facts, null, 2)}\n\nStatutes to check against:\n${JSON.stringify(STATUTES, null, 2)}\n\nCheck each consecutive pair of facts against ONLY the most relevant statute (match by event type). Calculate elapsed days (business days exclude weekends). Be concise.`;
}

function buildTimelinePrompt(caseId, facts) {
  return `Verified facts for case ${caseId}:\n${JSON.stringify(facts, null, 2)}\n\nSequence these facts chronologically by date. Identify gaps between consecutive events. Flag gaps over 7 days.`;
}

function buildDiscrepancyPrompt(caseId, facts) {
  return `Verified facts for case ${caseId}:\n${JSON.stringify(facts, null, 2)}\n\nIdentify conflicts between these facts:\n1. Same-date facts with different claims\n2. Facts about mailing/postmark/sending/delivery with different dates\nDo NOT resolve which source is accurate.`;
}

function buildFactExtractionPrompt(text, name) {
  return `Document name: ${name || "unknown"}\nDocument text:\n${text}\n\nExtract all factual statements that contain dates. Convert dates to YYYY-MM-DD format.`;
}

// ===== Agent Executors =====
async function execStatuteMatching(env, caseId, facts) {
  try {
    const result = await callAI(env, SYSTEM_PROMPTS.statute_matching, buildStatutePrompt(caseId, facts), 4096);
    if (result.results) {
      for (const r of result.results) {
        if (r.note) {
          const g = applyGuardrail(r.note);
          r.note = g.text; r.guardrail_blocks = g.blocks;
        }
      }
    }
    return { agent_name: "Statute Matching Agent", agent_key: "statute_matching", status: "success", output: result, guardrail_blocks: result.results?.flatMap(r => r.guardrail_blocks || []) || [] };
  } catch (e) {
    return { agent_name: "Statute Matching Agent", agent_key: "statute_matching", status: "error", output: { error: e.message }, guardrail_blocks: [] };
  }
}

async function execTimeline(env, caseId, facts) {
  try {
    const result = await callAI(env, SYSTEM_PROMPTS.timeline, buildTimelinePrompt(caseId, facts), 1024);
    return { agent_name: "Timeline Agent", agent_key: "timeline", status: "success", output: result, guardrail_blocks: [] };
  } catch (e) {
    return { agent_name: "Timeline Agent", agent_key: "timeline", status: "error", output: { error: e.message }, guardrail_blocks: [] };
  }
}

async function execDiscrepancy(env, caseId, facts) {
  try {
    const result = await callAI(env, SYSTEM_PROMPTS.discrepancy, buildDiscrepancyPrompt(caseId, facts), 1024);
    return { agent_name: "Discrepancy Agent", agent_key: "discrepancy", status: result.conflicts?.length > 0 ? "success" : "partial", output: result, guardrail_blocks: [] };
  } catch (e) {
    return { agent_name: "Discrepancy Agent", agent_key: "discrepancy", status: "error", output: { error: e.message }, guardrail_blocks: [] };
  }
}

async function execFactExtraction(env, docText, docName) {
  if (!docText) return { agent_name: "Fact Extraction Agent", agent_key: "fact_extraction", status: "partial", output: { facts: [], note: "No document text provided" }, guardrail_blocks: [] };
  try {
    const result = await callAI(env, SYSTEM_PROMPTS.fact_extraction, buildFactExtractionPrompt(docText, docName), 1024);
    return { agent_name: "Fact Extraction Agent", agent_key: "fact_extraction", status: result.facts?.length > 0 ? "success" : "partial", output: result, guardrail_blocks: [] };
  } catch (e) {
    return { agent_name: "Fact Extraction Agent", agent_key: "fact_extraction", status: "error", output: { error: e.message }, guardrail_blocks: [] };
  }
}

// ===== Routing =====
function tier1Route(pageContext, message) {
  const msg = (message || "").toLowerCase();
  if (pageContext === "evidence_viewer" && (msg.includes("upload") || msg.includes("document"))) return { agents: ["fact_extraction", "timeline"], sequential: true };
  if (pageContext === "policy_studio" && (msg.includes("edit") || msg.includes("publish") || msg.includes("rule"))) return { agents: ["statute_matching"], sequential: false };
  if (msg.includes("compliant") || msg.includes("deadline") || msg.includes("mailing") || msg.includes("on time")) return { agents: ["timeline", "statute_matching"], sequential: false };
  if (msg.includes("discrepanc") || msg.includes("conflict") || msg.includes("mismatch")) return { agents: ["discrepancy", "statute_matching"], sequential: false };
  if (msg.includes("timeline") || msg.includes("sequence") || msg.includes("gap") || msg.includes("when")) return { agents: ["timeline"], sequential: false };
  if (msg.includes("statute") || msg.includes("rule") || msg.includes("code")) return { agents: ["statute_matching"], sequential: false };
  if (msg.includes("upload") || msg.includes("document") || msg.includes("evidence")) return { agents: ["fact_extraction"], sequential: false };
  return null;
}

function tier2Route() { return { agents: ["statute_matching", "timeline"], sequential: false }; }

// ===== D1 Helpers =====
async function getCaseContext(env, caseId) {
  const result = await env.DB.prepare(
    "SELECT * FROM case_contexts WHERE case_id = ? ORDER BY LENGTH(verified_facts) DESC LIMIT 1"
  ).bind(caseId).all();
  if (result.results.length === 0) return null;
  const row = result.results[0];
  return {
    id: row.id,
    case_id: row.case_id,
    verified_facts: JSON.parse(row.verified_facts || "[]"),
    open_discrepancies: JSON.parse(row.open_discrepancies || "[]"),
    active_statutes: JSON.parse(row.active_statutes || "[]"),
    evidence_items: JSON.parse(row.evidence_items || "[]"),
    last_updated_by_agent: row.last_updated_by_agent,
    updated_at: row.updated_at
  };
}

async function upsertCaseContext(env, caseContext, updateData) {
  const id = caseContext?.id || uuid();
  const facts = JSON.stringify(updateData.verified_facts || caseContext?.verified_facts || []);
  const discrepancies = JSON.stringify(updateData.open_discrepancies || caseContext?.open_discrepancies || []);
  const statutes = JSON.stringify(updateData.active_statutes || caseContext?.active_statutes || []);
  const evidence = JSON.stringify(caseContext?.evidence_items || []);
  const now = new Date().toISOString();

  if (caseContext?.id) {
    await env.DB.prepare(
      "UPDATE case_contexts SET verified_facts = ?, open_discrepancies = ?, active_statutes = ?, last_updated_by_agent = ?, updated_at = ?, updated_date = ? WHERE id = ?"
    ).bind(facts, discrepancies, statutes, updateData.last_updated_by_agent || "", now, now, id).run();
  } else {
    await env.DB.prepare(
      "INSERT INTO case_contexts (id, case_id, verified_facts, open_discrepancies, active_statutes, evidence_items, last_updated_by_agent, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(id, caseContext?.case_id || updateData.case_id, facts, discrepancies, statutes, evidence, updateData.last_updated_by_agent || "", now).run();
  }
  return id;
}

async function logAgentRun(env, caseId, agentName, status, output, startedAt, completedAt, hash) {
  const id = uuid();
  await env.DB.prepare(
    "INSERT INTO agent_runs (id, case_id, agent_name, triggered_by, input_summary, output, status, started_at, completed_at, ledger_hash, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(id, caseId, agentName, "system", "", JSON.stringify(output), status, startedAt, completedAt, hash, CF_MODEL).run();
}

async function logInvocation(env, caseId, pageContext, message, agentsSelected) {
  const id = uuid();
  await env.DB.prepare(
    "INSERT INTO agent_invocations (id, case_id, page_context, message, agents_selected, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(id, caseId, pageContext || "unknown", message || "", JSON.stringify(agentsSelected), new Date().toISOString()).run();
}

// ===== Main Worker =====
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/" || path === "/health") {
      return new Response(JSON.stringify({
        service: "FairProcess V3 Gateway",
        status: "operational",
        model: CF_MODEL,
        guardrail: GUARDRAIL,
        bindings: { D1: "DB", R2: "DOCUMENTS", AI: "AI" }
      }), { headers: { "Content-Type": "application/json" } });
    }

    if (path === "/ledger" && request.method === "GET") {
      const caseId = url.searchParams.get("case_id");
      if (!caseId) return new Response(JSON.stringify({ error: "case_id required" }), { status: 400, headers: { "Content-Type": "application/json" } });
      const result = await env.DB.prepare("SELECT * FROM agent_runs WHERE case_id = ? ORDER BY created_date DESC").bind(caseId).all();
      return new Response(JSON.stringify({ case_id: caseId, entries: result.results.length, ledger: result.results }, null, 2), { headers: { "Content-Type": "application/json" } });
    }

    if (path === "/case" && request.method === "GET") {
      const caseId = url.searchParams.get("case_id");
      if (!caseId) return new Response(JSON.stringify({ error: "case_id required" }), { status: 400, headers: { "Content-Type": "application/json" } });
      const ctx = await getCaseContext(env, caseId);
      if (!ctx) return new Response(JSON.stringify({ error: "Case not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
      return new Response(JSON.stringify(ctx, null, 2), { headers: { "Content-Type": "application/json" } });
    }

    if (path === "/seed" && request.method === "POST") {
      try {
        const caseId = "CE26-0402";
        const existing = await getCaseContext(env, caseId);
        if (existing) return new Response(JSON.stringify({ message: "Case already seeded", case_id: caseId }), { headers: { "Content-Type": "application/json" } });

        const facts = [
          { fact_id: "f_001", text: "Citation executed on Jul 15, 2026", source_doc: "citation_CE26-0402.pdf", date: "2026-07-15", confidence: 0.98 },
          { fact_id: "f_002", text: "Citation claims mailing date of Jul 22, 2026", source_doc: "citation_CE26-0402.pdf", date: "2026-07-22", confidence: 0.95 },
          { fact_id: "f_003", text: "USPS postmark date is Jul 24, 2026", source_doc: "postmark_cert.pdf", date: "2026-07-24", confidence: 0.99 }
        ];
        const discrepancies = [{
          source_a: "Citation CE26-0402 (Jul 22)", source_b: "Postmark Certificate (Jul 24)",
          characterization: "Citation claims mailing date of Jul 22, but USPS postmark shows Jul 24. Agent does not resolve which is accurate.",
          status: "open"
        }];

        await upsertCaseContext(env, { case_id: caseId }, {
          case_id: caseId, verified_facts: facts, open_discrepancies: discrepancies,
          active_statutes: ["HCC \u00a7 351-7", "HCC \u00a7 351-12"], last_updated_by_agent: "seed"
        });

        return new Response(JSON.stringify({ message: "Demo case seeded", case_id: caseId, facts: facts.length, discrepancies: discrepancies.length }), { headers: { "Content-Type": "application/json" } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { "Content-Type": "application/json" } });
      }
    }

    if (path === "/gateway" || path === "/agentGateway") {
      if (request.method !== "POST") return new Response(JSON.stringify({ error: "POST required" }), { status: 405, headers: { "Content-Type": "application/json" } });

      try {
        const body = await request.json();
        const { case_id, page_context, message, document_text, document_name } = body;
        if (!case_id) return new Response(JSON.stringify({ error: "case_id is required" }), { status: 400, headers: { "Content-Type": "application/json" } });

        const startedAt = new Date().toISOString();

        let caseContext = await getCaseContext(env, case_id);
        if (!caseContext) caseContext = { case_id, verified_facts: [], open_discrepancies: [], active_statutes: [] };

        let routing = tier1Route(page_context, message);
        if (!routing) routing = tier2Route();

        await logInvocation(env, case_id, page_context, message, routing.agents);

        const facts = caseContext.verified_facts || [];
        const agentResults = [];

        if (routing.sequential) {
          let accFacts = [...facts];
          for (const agentKey of routing.agents) {
            let result;
            if (agentKey === "fact_extraction") { result = await execFactExtraction(env, document_text, document_name); if (result.output?.facts) accFacts = [...accFacts, ...result.output.facts]; }
            else if (agentKey === "timeline") { result = await execTimeline(env, case_id, accFacts); }
            else if (agentKey === "statute_matching") { result = await execStatuteMatching(env, case_id, accFacts); }
            else if (agentKey === "discrepancy") { result = await execDiscrepancy(env, case_id, accFacts); }
            if (result) agentResults.push(result);
          }
        } else {
          const promises = routing.agents.map(async (agentKey) => {
            if (agentKey === "fact_extraction") return await execFactExtraction(env, document_text, document_name);
            if (agentKey === "timeline") return await execTimeline(env, case_id, facts);
            if (agentKey === "statute_matching") return await execStatuteMatching(env, case_id, facts);
            if (agentKey === "discrepancy") return await execDiscrepancy(env, case_id, facts);
          });
          const results = await Promise.all(promises);
          agentResults.push(...results.filter(r => r));
        }

        const completedAt = new Date().toISOString();
        const updatedFields = [];
        const newDiscrepancies = [];

        for (const r of agentResults) {
          if (r.output?.conflicts) { newDiscrepancies.push(...r.output.conflicts); updatedFields.push("open_discrepancies"); }
          if (r.output?.facts) updatedFields.push("verified_facts");
          if (r.output?.results) updatedFields.push("statute_analysis");
        }

        const sm = agentResults.find(r => r.agent_key === "statute_matching");
        const tl = agentResults.find(r => r.agent_key === "timeline");
        const da = agentResults.find(r => r.agent_key === "discrepancy");
        let responseText;

        if (da && da.output?.conflicts?.length > 0) {
          responseText = `${da.output.conflicts.length} discrepancy(ies) found. ${da.output.conflicts[0].characterization || ""}`;
          if (sm && sm.output?.results?.length > 0) {
            const dev = sm.output.results.filter(r => r.status === "deviation detected");
            if (dev.length > 0) responseText += ` Additionally, ${dev.length} statute deviation(s) detected.`;
          }
        } else if (sm && sm.output?.results?.length > 0) {
          const dev = sm.output.results.filter(r => r.status === "deviation detected");
          const mat = sm.output.results.filter(r => r.status === "matches expected window");
          const r = sm.output.results[0];
          responseText = `Analysis for case ${case_id}: Under ${r.statute_ref}, "${r.required_rule}". Elapsed: ${r.actual_event?.elapsed_days || "unknown"} days. Status: ${r.status}.`;
          if (r.note) responseText += ` ${r.note}`;
          if (dev.length > 0) responseText += ` ${dev.length} deviation(s).`;
          if (mat.length > 0) responseText += ` ${mat.length} check(s) match.`;
        } else if (tl && tl.output?.events?.length > 0) {
          const flagged = tl.output.gaps?.filter(g => g.flagged)?.length || 0;
          responseText = `Timeline for ${case_id}: ${tl.output.events.length} events, ${tl.output.gaps?.length || 0} gaps, ${flagged} flagged.`;
        } else {
          responseText = `Analysis complete for ${case_id}. ${routing.agents.length} agent(s) executed.`;
        }

        const updateData = { case_id, last_updated_by_agent: routing.agents.join(", ") };
        if (newDiscrepancies.length > 0) updateData.open_discrepancies = [...(caseContext.open_discrepancies || []), ...newDiscrepancies];
        const newFacts = agentResults.flatMap(r => r.output?.facts || []);
        if (newFacts.length > 0) updateData.verified_facts = [...(caseContext.verified_facts || []), ...newFacts];
        await upsertCaseContext(env, caseContext, updateData);

        const ledgerEntries = [];
        for (const result of agentResults) {
          const ledgerText = JSON.stringify({ case_id, agent_name: result.agent_name, started_at: startedAt, completed_at: completedAt, output: result.output, model: CF_MODEL });
          let hash = "unavailable";
          try { hash = await sha256(ledgerText); } catch (e) {}
          await logAgentRun(env, case_id, result.agent_name, result.status, result.output, startedAt, completedAt, hash);
          ledgerEntries.push({ agent: result.agent_name, hash: hash.substring(0, 12), status: result.status, guardrail_blocks: result.guardrail_blocks || [] });
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
        }), { headers: { "Content-Type": "application/json" } });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { "Content-Type": "application/json" } });
      }
    }

    return new Response(JSON.stringify({
      error: "Not found",
      endpoints: ["/", "/gateway", "/ledger?case_id=X", "/case?case_id=X", "/seed"]
    }), { status: 404, headers: { "Content-Type": "application/json" } });
  }
};
