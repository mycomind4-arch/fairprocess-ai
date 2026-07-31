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

const CF_MODEL = "@cf/meta/llama-3.1-8b-instruct";

async function callCloudflareAI(systemPrompt, userPrompt, maxTokens) {
  maxTokens = maxTokens || 1024;
  const apiToken = Deno.env.get("CLOUDFLARE_API_TOKEN");
  const accountId = Deno.env.get("CLOUDFLARE_ACCOUNT_ID");
  if (!apiToken || !accountId) throw new Error("Cloudflare credentials not configured");

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${CF_MODEL}`,
    {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiToken}`, "Content-Type": "application/json" },
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
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try { return JSON.parse(jsonMatch[0]); } catch (e) { return { raw_response: content }; }
  }
  return { raw_response: content };
}

const SYSTEM_PROMPT = `You are a Statute Matching Agent for a jurisdiction intelligence system.
${GUARDRAIL}
Given verified facts with dates and statutes with deadline rules, analyze whether elapsed time between consecutive events matches the required deadline.

For each statute determine:
- Whether elapsed time is within (max) or at least (min) the required deadline
- Status: "matches expected window" or "deviation detected"
- A factual note about the calculation

NEVER use: "compliant", "non-compliant", "violation", "unlawful", "invalid", "void", "guilty", "liable".
Use: "matches expected window", "deviation detected", "conflict identified", "evidence suggests".

Return ONLY valid JSON:
{"results":[{"statute_ref":"ref","required_rule":"rule","actual_event":{"start_date":"date","end_date":"date","elapsed_days":0,"deadline_direction":"max or min"},"status":"matches expected window or deviation detected","note":"factual note"}]}`;

const STATUTES = [
  { ref: "HCC \u00a7 351-7", description: "Citation shall be mailed within 3 business days of execution. Mailing date = postmark date.", deadline_type: "business_days", deadline_value: 3, deadline_direction: "max" },
  { ref: "HCC \u00a7 351-12", description: "Notice published at least 10 days before hearing date.", deadline_type: "calendar_days", deadline_value: 10, deadline_direction: "min" },
  { ref: "CA Gov Code \u00a7 65852.2", description: "Approve or disapprove ADU application within 60 days of complete application.", deadline_type: "calendar_days", deadline_value: 60, deadline_direction: "max" },
  { ref: "HCC \u00a7 4.2", description: "Notice posted and mailed within 5 business days of enforcement action.", deadline_type: "business_days", deadline_value: 5, deadline_direction: "max" }
];

Deno.serve(async (req) => {
  try {
    const body = await req.json();
    const { case_id, events, facts } = body;

    if (!case_id) {
      return new Response(JSON.stringify({ error: "case_id is required" }), {
        status: 400, headers: { "Content-Type": "application/json" }
      });
    }

    const base44 = createClientFromRequest(req);
    const startedAt = new Date().toISOString();

    const allFacts = facts || events || [];
    const userPrompt = `Verified facts for case ${case_id}:\n${JSON.stringify(allFacts, null, 2)}\n\nStatutes to check against:\n${JSON.stringify(STATUTES, null, 2)}\n\nAnalyze each consecutive pair of facts against each statute. Calculate elapsed days (business days exclude weekends). Determine if elapsed time matches the required deadline.`;

    const result = await callCloudflareAI(SYSTEM_PROMPT, userPrompt, 1024);

    if (result.results) {
      for (const r of result.results) {
        if (r.note) {
          const g = applyGuardrail(r.note);
          r.note = g.text;
          r.guardrail_blocks = g.blocks;
        }
      }
    }

    const completedAt = new Date().toISOString();
    const ledgerText = JSON.stringify({ case_id, agent_name: "Statute Matching Agent", started_at: startedAt, completed_at: completedAt, output: result, model: CF_MODEL });
    let hash = "unavailable";
    try { hash = await sha256(ledgerText); } catch (e) {}

    try {
      await base44.entities.AgentRun.create({
        case_id, agent_name: "Statute Matching Agent", triggered_by: "system",
        input_summary: `Matched ${allFacts.length} facts against ${STATUTES.length} statutes via ${CF_MODEL}`,
        output: { ...result, guardrail: GUARDRAIL }, status: "success",
        started_at: startedAt, completed_at: completedAt, ledger_hash: hash
      });
    } catch (e) {}

    return new Response(JSON.stringify({
      case_id, results: result.results || [], guardrail: GUARDRAIL,
      ledger_hash: hash.substring(0, 12), llm_model: CF_MODEL, agent: "statute_matching_agent"
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { "Content-Type": "application/json" }
    });
  }
});
