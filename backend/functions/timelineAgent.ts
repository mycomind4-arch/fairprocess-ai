import { createClientFromRequest } from "npm:@base44/sdk@0.8.31";

const GUARDRAIL = "You identify evidentiary status. You do not render legal conclusions.";

async function sha256(text) {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function calendarDaysBetween(startDate, endDate) {
  const start = new Date(startDate);
  const end = new Date(endDate);
  return Math.round((end - start) / (1000 * 60 * 60 * 24));
}

Deno.serve(async (req) => {
  try {
    const body = await req.json();
    const { case_id, facts } = body;

    if (!case_id || !facts || !Array.isArray(facts)) {
      return new Response(JSON.stringify({ error: "case_id and facts array are required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    const base44 = createClientFromRequest(req);
    const startedAt = new Date().toISOString();

    // Sort facts by date
    const sortedFacts = facts
      .filter(f => f.date)
      .sort((a, b) => new Date(a.date) - new Date(b.date));

    // Build timeline events
    const events = sortedFacts.map(f => ({
      date: f.date,
      event: f.text,
      status: "verified",
      source_doc: f.source_doc
    }));

    // Compute gaps between consecutive events
    const gaps = [];
    for (let i = 0; i < events.length - 1; i++) {
      const days = calendarDaysBetween(events[i].date, events[i + 1].date);
      gaps.push({
        from: events[i].date,
        to: events[i + 1].date,
        days: days,
        from_event: events[i].event,
        to_event: events[i + 1].event,
        flagged: days > 7 // Flag gaps over 7 days
      });
    }

    const completedAt = new Date().toISOString();
    const ledgerText = JSON.stringify({
      case_id,
      agent_name: "Timeline Agent",
      started_at: startedAt,
      completed_at: completedAt,
      output: { events, gaps }
    });
    let hash = "unavailable";
    try { hash = await sha256(ledgerText); } catch (e) {}

    try {
      await base44.entities.AgentRun.create({
        case_id,
        agent_name: "Timeline Agent",
        triggered_by: "system",
        input_summary: `Sequenced ${events.length} events, found ${gaps.length} gaps`,
        output: { events, gaps, guardrail: GUARDRAIL },
        status: "success",
        started_at: startedAt,
        completed_at: completedAt,
        ledger_hash: hash
      });
    } catch (e) { /* non-blocking */ }

    return new Response(JSON.stringify({
      case_id,
      events,
      gaps,
      gaps_flagged: gaps.filter(g => g.flagged).length,
      guardrail: GUARDRAIL,
      ledger_hash: hash.substring(0, 12),
      agent: "timeline_agent"
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
