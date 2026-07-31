# FairProcess — Jurisdiction Intelligence System V3

Process integrity infrastructure for jurisdiction-level compliance analysis. Built as a single-page app with a Cloudflare AI orchestration backend.

## Architecture

### Frontend
Single HTML file with embedded CSS/JS. No build step required.

### Backend (Cloudflare)
- **Workers AI** (`@cf/meta/llama-3-8b-instruct`) — LLM inference for all agents
- **Vectorize** (`@cf/baai/bge-base-en-v1.5`) — Knowledge graph embeddings
- **D1** — Relational data (CaseContext, AgentRun, AgentInvocation)
- **R2** — Document storage
- **Access** — Authentication

### Agent Core
- **agentGateway** — Single entry point for all pages
- **Orchestrator** — Two-tier routing (deterministic rules → LLM planning fallback)
- **Specialist Agents**:
  - `fact_extraction_agent` — Extract dated facts from documents
  - `timeline_agent` — Sequence events, compute elapsed time, flag gaps
  - `statute_matching_agent` — Match events to statutes, evaluate deadline math
  - `discrepancy_agent` — Characterize conflicts between sources (does not resolve)
  - `document_agent` — Hash, classify, route documents

### Neutrality Guardrail
Every agent prompt ends with:
> "You identify evidentiary status. You do not render legal conclusions."

Blocked terms are rewritten to evidentiary status:
- "non-compliant" → "deviation detected"
- "compliant" → "matches expected window"
- "violation" → "deviation detected"
- "invalid/void" → "conflict identified"

All blocks are logged to the audit ledger.

## Pages (21 total)

### Intelligence
- **Assistant** — Chat interface routed through agentGateway
- **Agent Mode** — Live orchestrator workflow with transcript, progress, insights
- **Active Agents** — Expert network status with performance metrics
- **Agent Network** — Visual graph of orchestrator routing topology

### Cases & Evidence
- **Cases** — All active and archived cases
- **Evidence** — Items with cryptographic hash verification
- **Evidence Chain** — Chain of custody with SHA-256 hashes at each step
- **Timeline** — Procedural chronology with gap detection
- **Discrepancies** — Side-by-side source comparison matrix
- **Documents** — All ingested documents with classification

### Compliance
- **Deadline Engine** — Statutory windows overlaid on actual events
- **Statute Library** — Browseable rules with deadline visualization
- **Policy Studio** — Rule builder with live impact preview against active cases
- **Neutrality Guardrails** — Blocked legal conclusions log + configuration
- **Procedural Graphs** — Expected flows vs actual event comparison

### System
- **Audit Ledger** — Immutable log of agent + human actions (SHA-256 hashed)
- **Knowledge Graph** — Connected regulations, permits, properties
- **Records Watch** — Real-time public records change detection with case impact
- **Control Panel** — Orchestrator + Cloudflare configuration
- **Analytics** — Agent performance, compliance trends, guardrail effectiveness
- **Agent Training** — Upload jurisdiction documents for Vectorize embedding

## File Structure
```
fairprocess-ai/
├── fairprocess-v3.html    # Main app (single file, no build step)
├── README.md              # This file
└── agents.js              # Agent configuration (Cloudflare Workers AI)
```

## Data Model (Cloudflare D1)

### CaseContext
One record per case — shared state read/written by all agents.
- `case_id` (relation to Case)
- `verified_facts` (JSON array)
- `open_discrepancies` (JSON array)
- `active_statutes` (JSON array)
- `last_updated_by_agent` (text)
- `updated_at` (timestamp)

### AgentRun
One record per agent invocation — feeds the audit ledger.
- `case_id` (relation)
- `agent_name` (text)
- `triggered_by` (user id or "system")
- `input_summary` (text)
- `output` (JSON)
- `status` (enum: success / partial / failed)
- `started_at`, `completed_at` (timestamps)
- `ledger_hash` (SHA-256 text)

### AgentInvocation
Request log for debugging routing.
- `case_id`, `page_context`, `message`, `agents_selected` (JSON), `created_at`

## Orchestrator Routing

### Tier 1 — Deterministic (no LLM call, instant)
| Trigger | Agents |
|---|---|
| Document uploaded | `fact_extraction` → `timeline` |
| Policy rule edited | `statute_matching` (impact preview) |
| "compliant" / "deadline" / "on time" | `timeline` + `statute_matching` |
| New fact conflicts with verified fact | `discrepancy` |

### Tier 2 — LLM Planning (fallback)
When Tier 1 doesn't match, an LLM planning call selects the minimal agent subset.

### Execution
- Independent agents run in parallel
- Dependent agents run sequentially
- Every invocation writes an AgentRun record (SHA-256 hashed)

## License
Proprietary — mycomind4-arch
