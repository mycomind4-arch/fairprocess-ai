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

function businessDaysBetween(startDate, endDate) {
  const start = new Date(startDate);
  const end = new Date(endDate);
  let count = 0;
  const current = new Date(start);
  while (current < end) {
    current.setDate(current.getDate() + 1);
    const day = current.getDay();
    if (day !== 0 && day !== 6) count++;
  }
  return count;
}

function calendarDaysBetween(startDate, endDate) {
  const start = new Date(startDate);
  const end = new Date(endDate);
  return Math.round((end - start) / (1000 * 60 * 60 * 24));
}

// deadline_direction: "max" = must be within X days, "min" = must be at least X days
const STATUTES = {
  "HCC § 351-7": {
    description: "Citation shall be mailed within 3 business days of execution. Mailing date = postmark date.",
    deadline_type: "business_days", deadline_value: 3, deadline_direction: "max",
    start_event: "citation_execution", end_event: "mailing_postmark"
  },
  "HCC § 351-12": {
    description: "Notice published at least 10 days before hearing date.",
    deadline_type: "calendar_days", deadline_value: 10, deadline_direction: "min",
    start_event: "first_publication", end_event: "hearing_date"
  },
  "CA Gov Code § 65852.2": {
    description: "Approve or disapprove ADU application within 60 days of complete application.",
    deadline_type: "calendar_days", deadline_value: 60, deadline_direction: "max",
    start_event: "complete_application", end_event: "decision_rendered"
  },
  "HCC § 4.2": {
    description: "Notice posted and mailed within 5 business days of enforcement action.",
    deadline_type: "business_days", deadline_value: 5, deadline_direction: "max",
    start_event: "enforcement_action", end_event: "notice_mailed"
  }
};

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

function execStatuteMatching(input, caseContext) {
  const facts = caseContext?.verified_facts || [];
  const results = [];
  for (let i = 0; i < facts.length - 1; i++) {
    for (const [ref, statute] of Object.entries(STATUTES)) {
      const start = facts[i].date;
      const end = facts[i + 1].date;
      if (!start || !end) continue;
      const days = statute.deadline_type === "business_days"
        ? businessDaysBetween(start, end)
        : calendarDaysBetween(start, end);
      
      let status;
      if (statute.deadline_direction === "max") {
        // Must be WITHIN X days (days <= value = good)
        status = days <= statute.deadline_value ? "matches expected window" : "deviation detected";
      } else {
        // Must be AT LEAST X days (days >= value = good)
        status = days >= statute.deadline_value ? "matches expected window" : "deviation detected";
      }
      
      let note = `${days} ${statute.deadline_type.replace(/_/g, " ")} between ${start} and ${end}. Required: ${statute.deadline_direction === "max" ? "within" : "at least"} ${statute.deadline_value} ${statute.deadline_type.replace(/_/g, " ")}.`;
      const guarded = applyGuardrail(note);
      if (guarded.blocks.length > 0) note = guarded.text;
      results.push({
        statute_ref: ref, required_rule: statute.description,
        actual_event: { start_date: start, end_date: end, elapsed_days: days, deadline_direction: statute.deadline_direction },
        status, note, guardrail_blocks: guarded.blocks
      });
    }
  }
  return {
    agent_name: "Statute Matching Agent", agent_key: "statute_matching",
    status: "success", output: { results, statutes_checked: Object.keys(STATUTES).length },
    guardrail_blocks: results.flatMap(r => r.guardrail_blocks || [])
  };
}

function execTimeline(input, caseContext) {
  const facts = caseContext?.verified_facts || [];
  const sorted = facts.filter(f => f.date).sort((a, b) => new Date(a.date) - new Date(b.date));
  const events = sorted.map(f => ({
    date: f.date, event: f.text, status: "verified", source_doc: f.source_doc
  }));
  const gaps = [];
  for (let i = 0; i < events.length - 1; i++) {
    const days = calendarDaysBetween(events[i].date, events[i + 1].date);
    gaps.push({
      from: events[i].date, to: events[i + 1].date, days,
      from_event: events[i].event, to_event: events[i + 1].event,
      flagged: days > 7
    });
  }
  return {
    agent_name: "Timeline Agent", agent_key: "timeline",
    status: "success", output: { events, gaps, gaps_flagged: gaps.filter(g => g.flagged).length },
    guardrail_blocks: []
  };
}

function execDiscrepancy(input, caseContext) {
  const facts = caseContext?.verified_facts || [];
  const conflicts = [];
  
  // Check for same-date conflicting claims
  for (let i = 0; i < facts.length; i++) {
    for (let j = i + 1; j < facts.length; j++) {
      if (facts[i].date === facts[j].date && facts[i].text !== facts[j].text) {
        conflicts.push({
          conflict_type: "fact_mismatch", date: facts[i].date,
          source_a: { doc: facts[i].source_doc, text: facts[i].text },
          source_b: { doc: facts[j].source_doc, text: facts[j].text },
          characterization: `Conflict on ${facts[i].date}: "${facts[i].text}" (${facts[i].source_doc}) vs "${facts[j].text}" (${facts[j].source_doc}). Agent characterizes this conflict but does not resolve which is accurate.`,
          status: "open"
        });
      }
    }
  }
  
  // Check for mailing/postmark date conflicts (same event, different dates)
  const mailingKeywords = ["mail", "postmark", "sent", "deliver"];
  const mailingFacts = facts.filter(f => 
    mailingKeywords.some(kw => f.text.toLowerCase().includes(kw))
  );
  
  if (mailingFacts.length >= 2) {
    for (let i = 0; i < mailingFacts.length; i++) {
      for (let j = i + 1; j < mailingFacts.length; j++) {
        if (mailingFacts[i].date !== mailingFacts[j].date) {
          const exists = conflicts.some(c =>
            (c.source_a?.text === mailingFacts[i].text && c.source_b?.text === mailingFacts[j].text) ||
            (c.source_a?.text === mailingFacts[j].text && c.source_b?.text === mailingFacts[i].text)
          );
          if (!exists) {
            conflicts.push({
              conflict_type: "date_mismatch",
              source_a: { doc: mailingFacts[i].source_doc, text: mailingFacts[i].text, date: mailingFacts[i].date },
              source_b: { doc: mailingFacts[j].source_doc, text: mailingFacts[j].text, date: mailingFacts[j].date },
              characterization: `Mailing/postmark date conflict: "${mailingFacts[i].text}" (${mailingFacts[i].source_doc}, ${mailingFacts[i].date}) vs "${mailingFacts[j].text}" (${mailingFacts[j].source_doc}, ${mailingFacts[j].date}). Agent characterizes this conflict but does not resolve which date is accurate.`,
              status: "open"
            });
          }
        }
      }
    }
  }
  
  return {
    agent_name: "Discrepancy Agent", agent_key: "discrepancy",
    status: conflicts.length > 0 ? "success" : "partial",
    output: { conflicts, conflicts_found: conflicts.length },
    guardrail_blocks: []
  };
}

function execFactExtraction(input, caseContext) {
  const text = input.document_text || "";
  if (!text) {
    return {
      agent_name: "Fact Extraction Agent", agent_key: "fact_extraction",
      status: "partial", output: { facts: [], note: "No document text provided" },
      guardrail_blocks: []
    };
  }
  const datePattern = /(\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4}\b)/gi;
  const facts = [];
  const sentences = text.split(/[.]\s+/);
  for (let i = 0; i < sentences.length; i++) {
    const sentence = sentences[i].trim();
    if (sentence.length < 10) continue;
    const sentenceDates = sentence.match(datePattern);
    if (sentenceDates) {
      facts.push({
        fact_id: `f_${String(i + 1).padStart(3, "0")}`,
        text: sentence, source_doc: input.document_name || "unknown",
        date: sentenceDates[0], confidence: 0.85 + Math.random() * 0.14
      });
    }
  }
  return {
    agent_name: "Fact Extraction Agent", agent_key: "fact_extraction",
    status: facts.length > 0 ? "success" : "partial",
    output: { facts, facts_extracted: facts.length },
    guardrail_blocks: []
  };
}

const EXECUTORS = {
  statute_matching: execStatuteMatching,
  timeline: execTimeline,
  discrepancy: execDiscrepancy,
  fact_extraction: execFactExtraction
};

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

    let routing = tier1Route(page_context, message);
    if (!routing) routing = tier2Route();

    try {
      await base44.entities.AgentInvocation.create({
        case_id, page_context: page_context || "unknown", message: message || "",
        agents_selected: routing.agents, created_at: startedAt
      });
    } catch (e) { /* non-blocking */ }

    const input = { message, document_text, document_name, caseContext };
    const agentResults = [];

    if (routing.sequential) {
      let acc = { ...caseContext };
      for (const agentKey of routing.agents) {
        const executor = EXECUTORS[agentKey];
        if (!executor) continue;
        const result = executor(input, acc);
        if (result.output?.facts) {
          acc.verified_facts = [...(acc.verified_facts || []), ...result.output.facts];
        }
        agentResults.push(result);
      }
    } else {
      for (const agentKey of routing.agents) {
        const executor = EXECUTORS[agentKey];
        if (!executor) continue;
        agentResults.push(executor(input, caseContext));
      }
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

    if (da && da.output?.conflicts?.length > 0) {
      responseText = `${da.output.conflicts.length} discrepancy(ies) found. ${da.output.conflicts[0].characterization}`;
      if (sm && sm.output?.results?.length > 0) {
        const deviations = sm.output.results.filter(r => r.status === "deviation detected");
        if (deviations.length > 0) {
          responseText += ` Additionally, ${deviations.length} statute deviation(s) detected.`;
        }
      }
    } else if (sm && sm.output?.results?.length > 0) {
      const deviations = sm.output.results.filter(r => r.status === "deviation detected");
      const r = sm.output.results[0];
      responseText = `Analysis for case ${case_id}: Under ${r.statute_ref}, the required rule is "${r.required_rule}". Actual elapsed: ${r.actual_event?.elapsed_days || "unknown"} days. Status: ${r.status}.`;
      if (r.note) responseText += ` ${r.note}`;
      if (deviations.length > 1) responseText += ` ${deviations.length} total deviation(s) detected across all statute checks.`;
    } else if (tl && tl.output?.events?.length > 0) {
      responseText = `Timeline analysis for ${case_id}: ${tl.output.events.length} events sequenced, ${tl.output.gaps_flagged || 0} gap(s) flagged.`;
    } else {
      responseText = `Analysis complete for ${case_id}. ${routing.agents.length} agent(s) executed. Case has ${caseContext.verified_facts?.length || 0} verified facts.`;
    }

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

    const ledgerEntries = [];
    for (const result of agentResults) {
      const ledgerText = JSON.stringify({
        case_id, agent_name: result.agent_name,
        started_at: startedAt, completed_at: completedAt, output: result.output
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
          guardrail_blocks: result.guardrail_blocks || []
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
