import { createClientFromRequest } from "npm:@base44/sdk@0.8.31";

const GUARDRAIL = "You identify evidentiary status. You do not render legal conclusions.";

async function sha256(text) {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

const DOC_TYPES = {
  citation: { keywords: ["citation", "cited", "violation notice"], label: "Citation" },
  notice: { keywords: ["notice", "hearing", "public"], label: "Notice" },
  application: { keywords: ["application", "apply", "permit"], label: "Application" },
  affidavit: { keywords: ["affidavit", "notarized", "sworn"], label: "Affidavit" },
  certificate: { keywords: ["certificate", "certified", "postmark"], label: "Certificate" },
  report: { keywords: ["report", "inspection", "assessment"], label: "Report" },
  default: { keywords: [], label: "Document" }
};

function classifyDocument(filename, text) {
  const lower = ((filename || "") + " " + (text || "")).toLowerCase();
  for (const [key, type] of Object.entries(DOC_TYPES)) {
    if (key === "default") continue;
    if (type.keywords.some(kw => lower.includes(kw))) {
      return type.label;
    }
  }
  return "Document";
}

Deno.serve(async (req) => {
  try {
    const body = await req.json();
    const { case_id, document_name, document_content } = body;

    if (!case_id || !document_name) {
      return new Response(JSON.stringify({ error: "case_id and document_name are required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    const base44 = createClientFromRequest(req);
    const startedAt = new Date().toISOString();

    // Hash the document
    let hash = "unavailable";
    try {
      hash = await sha256(document_content || document_name);
    } catch (e) {}

    // Classify
    const docType = classifyDocument(document_name, document_content);

    // Determine next agent (fact_extraction)
    const routing = {
      doc_type: docType,
      doc_hash: hash,
      next_agent: "fact_extraction_agent",
      next_agent_reason: "Document classified — route to fact extraction for date/party/claim extraction"
    };

    const completedAt = new Date().toISOString();
    
    // Write AgentRun
    try {
      await base44.entities.AgentRun.create({
        case_id,
        agent_name: "Document Agent",
        triggered_by: "system",
        input_summary: `Classified ${document_name} as ${docType}`,
        output: { ...routing, guardrail: GUARDRAIL },
        status: "success",
        started_at: startedAt,
        completed_at: completedAt,
        ledger_hash: hash
      });
    } catch (e) { /* non-blocking */ }

    return new Response(JSON.stringify({
      case_id,
      document_name,
      doc_type: docType,
      doc_hash: hash,
      next_agent: "fact_extraction_agent",
      guardrail: GUARDRAIL,
      ledger_hash: hash.substring(0, 12),
      agent: "document_agent"
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
