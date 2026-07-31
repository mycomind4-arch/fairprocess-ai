import { createClientFromRequest } from "npm:@base44/sdk@0.8.31";

const GUARDRAIL = "You identify evidentiary status. You do not render legal conclusions.";

const GUARDRAIL_REWRITES = {
  "non-compliant": "deviation detected",
  "compliant": "matches expected window",
  "violation": "deviation detected",
  "unlawful": "deviation detected",
  "invalid": "conflict identified",
  "void": "conflict identified"
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

const STATUTES = {
  "HCC § 351-7": {
    title: "Notice of Citation — Mailing Requirements",
    description: "Citation shall be mailed within 3 business days of execution. Mailing date = postmark date.",
    deadline_type: "business_days",
    deadline_value: 3,
    start_event: "citation_execution",
    end_event: "mailing_postmark"
  },
  "HCC § 351-12": {
    title: "Publication of Hearing Notices",
    description: "Notice published at least 10 days before hearing date.",
    deadline_type: "calendar_days",
    deadline_value: 10,
    start_event: "first_publication",
    end_event: "hearing_date"
  },
  "CA Gov Code § 65852.2": {
    title: "ADU Permit Decision Timeline",
    description: "Approve or disapprove ADU application within 60 days of complete application.",
    deadline_type: "calendar_days",
    deadline_value: 60,
    start_event: "complete_application",
    end_event: "decision_rendered"
  },
  "HCC § 4.2": {
    title: "Code Enforcement Notice Requirements",
    description: "Notice posted on property and mailed to owner within 5 business days.",
    deadline_type: "business_days",
    deadline_value: 5,
    start_event: "enforcement_action",
    end_event: "notice_mailed"
  }
};

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

function matchEventToStatute(event, statute) {
  if (!event.start_date || !event.end_date) {
    return {
      statute_ref: statute.ref,
      required_rule: statute.description,
      actual_event: event,
      status: "unable to determine",
      note: "Missing start or end date for deadline calculation."
    };
  }

  const days = statute.deadline_type === "business_days"
    ? businessDaysBetween(event.start_date, event.end_date)
    : calendarDaysBetween(event.start_date, event.end_date);

  let status;
  if (statute.deadline_type === "business_days" && days <= statute.deadline_value) {
    status = "matches expected window";
  } else if (statute.deadline_type === "calendar_days" && days >= statute.deadline_value) {
    status = "matches expected window";
  } else {
    status = "deviation detected";
  }

  let note = `${days} ${statute.deadline_type.replace(/_/g, " ")} between ${event.start_date} and ${event.end_date}. Required: ${statute.deadline_value} ${statute.deadline_type.replace(/_/g, " ")}.`;
  const guarded = applyGuardrail(note);
  if (guarded.blocks.length > 0) note = guarded.text;

  return {
    statute_ref: statute.ref,
    required_rule: statute.description,
    actual_event: { ...event, elapsed_days: days },
    status,
    note
  };
}

Deno.serve(async (req) => {
  try {
    const body = await req.json();
    const { case_id, events, jurisdiction, statutes } = body;

    if (!case_id || !events || !Array.isArray(events)) {
      return new Response(JSON.stringify({ error: "case_id and events array are required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    const base44 = createClientFromRequest(req);
    const startedAt = new Date().toISOString();
    const statuteRefs = statutes || Object.keys(STATUTES);
    const results = [];

    for (const event of events) {
      for (const ref of statuteRefs) {
        const statute = { ...STATUTES[ref], ref };
        if (!statute) continue;
        if (event.type === statute.start_event || event.type === statute.end_event) {
          const match = matchEventToStatute(event, statute);
          results.push(match);
        }
      }
    }

    if (results.length === 0 && events.length >= 2) {
      const firstEvent = events[0];
      const lastEvent = events[events.length - 1];
      for (const ref of statuteRefs) {
        const statute = { ...STATUTES[ref], ref };
        const syntheticEvent = {
          type: statute.start_event,
          start_date: firstEvent.date || firstEvent.start_date,
          end_date: lastEvent.date || lastEvent.end_date,
          description: `${firstEvent.description || ""} → ${lastEvent.description || ""}`
        };
        const match = matchEventToStatute(syntheticEvent, statute);
        results.push(match);
      }
    }

    const completedAt = new Date().toISOString();
    const ledgerText = JSON.stringify({
      case_id,
      agent_name: "Statute Matching Agent",
      started_at: startedAt,
      completed_at: completedAt,
      output: results
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
        agent_name: "Statute Matching Agent",
        triggered_by: "system",
        input_summary: `Matched ${events.length} events against ${statuteRefs.length} statutes`,
        output: { results, guardrail: GUARDRAIL },
        status: results.length > 0 ? "success" : "partial",
        started_at: startedAt,
        completed_at: completedAt,
        ledger_hash: hash
      });
    } catch (e) { /* non-blocking */ }

    return new Response(JSON.stringify({
      case_id,
      results,
      guardrail: GUARDRAIL,
      ledger_hash: hash.substring(0, 12),
      agent: "statute_matching_agent"
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
