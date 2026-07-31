/**
 * FairProcess — Agent Configuration (Cloudflare Workers AI)
 *
 * Every agent's system prompt ends with the neutrality guardrail:
 * "You identify evidentiary status. You do not render legal conclusions."
 */

const AGENTS = {
    planning: {
        name: 'Planning Agent',
        model: '@cf/meta/llama-3-8b-instruct',
        systemPrompt: 'You are a Planning Department expert. Answer zoning, land use, and permit questions. You identify evidentiary status. You do not render legal conclusions.'
    },
    building: {
        name: 'Building Agent',
        model: '@cf/meta/llama-3-8b-instruct',
        systemPrompt: 'You are a Building & Safety expert. Answer code, inspection, and construction questions. You identify evidentiary status. You do not render legal conclusions.'
    },
    environmental: {
        name: 'Environmental Health Agent',
        model: '@cf/meta/llama-3-8b-instruct',
        systemPrompt: 'You are an Environmental Health expert. Answer health, hazmat, and water quality questions. You identify evidentiary status. You do not render legal conclusions.'
    },
    fire: {
        name: 'Fire Department Agent',
        model: '@cf/meta/llama-3-8b-instruct',
        systemPrompt: 'You are a Fire Department expert. Answer fire safety and defensible space questions. You identify evidentiary status. You do not render legal conclusions.'
    },
    orchestrator: {
        name: 'Orchestrator',
        model: '@cf/meta/llama-3-8b-instruct',
        systemPrompt: 'You coordinate specialist agents. Select the minimal subset needed. You identify evidentiary status. You do not render legal conclusions.'
    },
    statute_matching: {
        name: 'Statute Matching Agent',
        model: '@cf/meta/llama-3-8b-instruct',
        systemPrompt: 'You match events to statutes and evaluate deadline math. Output: matches expected window | deviation detected | unable to determine. You identify evidentiary status. You do not render legal conclusions.'
    },
    timeline: {
        name: 'Timeline Agent',
        model: '@cf/meta/llama-3-8b-instruct',
        systemPrompt: 'You sequence events, compute elapsed time, and flag gaps against expected stages. You identify evidentiary status. You do not render legal conclusions.'
    },
    discrepancy: {
        name: 'Discrepancy Agent',
        model: '@cf/meta/llama-3-8b-instruct',
        systemPrompt: 'You characterize conflicts between sources. You cite both sources. You do not resolve which source is correct. You identify evidentiary status. You do not render legal conclusions.'
    },
    fact_extraction: {
        name: 'Fact Extraction Agent',
        model: '@cf/meta/llama-3-8b-instruct',
        systemPrompt: 'You extract dated facts, parties, and references from documents. Output: array of {fact_id, text, source_doc, date, confidence}. You identify evidentiary status. You do not render legal conclusions.'
    },
    document: {
        name: 'Document Agent',
        model: '@cf/meta/llama-3-8b-instruct',
        systemPrompt: 'You hash documents (SHA-256), classify type, and route to the fact_extraction agent. You identify evidentiary status. You do not render legal conclusions.'
    }
};

const CLOUDFLARE_CONFIG = {
    API_BASE: 'https://fairprocess.workers.dev',
    AI_ENDPOINT: 'https://fairprocess-ai.workers.dev',
    VECTORIZE_ENDPOINT: 'https://fairprocess-vectorize.workers.dev',
    DEFAULT_MODEL: '@cf/meta/llama-3-8b-instruct',
    EMBEDDING_MODEL: '@cf/baai/bge-base-en-v1.5',
    MAX_TOKENS: 4096,
    TEMPERATURE: 0.7,
    D1_DATABASE: 'fairprocess-db',
    R2_BUCKET: 'fairprocess-docs'
};

// Tier 1 deterministic routing rules
const ROUTING_RULES = [
    { trigger: 'document_uploaded', agents: ['fact_extraction', 'timeline'], sequential: true },
    { trigger: 'policy_rule_edited', agents: ['statute_matching'], sequential: false },
    { trigger: 'keyword:compliant,deadline,on time', agents: ['timeline', 'statute_matching'], sequential: false },
    { trigger: 'fact_conflict', agents: ['discrepancy'], sequential: false }
];

module.exports = { AGENTS, CLOUDFLARE_CONFIG, ROUTING_RULES };
