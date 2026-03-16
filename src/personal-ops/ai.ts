import {
  OPENAI_MODEL,
  PERSONAL_OPS_CLASSIFICATION_MODEL,
  PERSONAL_OPS_REPORT_MODEL,
} from '../config.js';
import { SourceRecord } from '../types.js';
import { loadPersonalOpsSecrets } from './secrets.js';

interface OpenAIResponsePayload {
  output?: Array<{
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
  output_text?: string;
}

function extractOutputText(payload: OpenAIResponsePayload): string {
  if (typeof payload.output_text === 'string' && payload.output_text.trim()) {
    return payload.output_text.trim();
  }
  return (payload.output || [])
    .flatMap((item) => item.content || [])
    .filter((item) => item.type === 'output_text' || item.type === 'text')
    .map((item) => item.text || '')
    .join('\n')
    .trim();
}

async function callOpenAIText(input: {
  instructions: string;
  prompt: string;
  model?: string;
}): Promise<string | null> {
  const secrets = loadPersonalOpsSecrets();
  if (!secrets.OPENAI_API_KEY) {
    return null;
  }

  const baseUrl = secrets.OPENAI_BASE_URL || 'https://api.openai.com/v1';
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/responses`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${secrets.OPENAI_API_KEY}`,
      'content-type': 'application/json',
      ...(secrets.OPENAI_ORGANIZATION
        ? { 'openai-organization': secrets.OPENAI_ORGANIZATION }
        : {}),
      ...(secrets.OPENAI_PROJECT
        ? { 'openai-project': secrets.OPENAI_PROJECT }
        : {}),
    },
    body: JSON.stringify({
      model: input.model || OPENAI_MODEL,
      instructions: input.instructions,
      input: input.prompt,
    }),
  });

  if (!response.ok) {
    return null;
  }

  return extractOutputText((await response.json()) as OpenAIResponsePayload);
}

export interface SourceClassificationSuggestion {
  clientName?: string;
  projectName?: string;
  urgency?: 'low' | 'medium' | 'high' | 'urgent';
  actionRequired?: boolean;
  awarenessOnly?: boolean;
  operationalRisk?: boolean;
  reportWorthy?: boolean;
  directness?: 'direct' | 'mentioned' | 'shared' | 'ambient';
  importanceReason?: string;
  followUpTitle?: string;
  blocker?: boolean;
  actionConfidence?: number;
  mappingConfidence?: number;
  confidence?: number;
}

export interface SourceClassificationOperatorContext {
  roleSummary?: string | null;
  reportingPreferences?: string | null;
  escalationPreferences?: string | null;
  assistantStyle?: string | null;
  workHoursStart?: number | null;
  workHoursEnd?: number | null;
}

export interface SourceClassificationClientContext {
  name: string;
  parentClientName?: string | null;
  roles?: string[];
  notes?: string | null;
  communicationPreferences?: string | null;
}

export interface SourceClassificationProjectContext {
  name: string;
  clientName?: string | null;
  tags?: string[];
  notes?: string | null;
}

export interface SourceClassificationConnectionContext {
  provider: SourceRecord['provider'];
  accountLabel?: string | null;
  accountId?: string | null;
  defaultClientName?: string | null;
  defaultProjectName?: string | null;
  triageGuidance?: string | null;
}

export interface SourceClassificationContactContext {
  name: string;
  organizationHint?: string | null;
  likelyRole?: string | null;
  importance?: string | null;
  notes?: string | null;
  lastSeenAt?: string | null;
  defaultClientName?: string | null;
  defaultProjectName?: string | null;
  matchedIdentities?: string[];
}

export async function suggestSourceClassification(input: {
  source: SourceRecord;
  clientNames: string[];
  projectNames: string[];
  operatorContext?: SourceClassificationOperatorContext | null;
  connectionContext?: SourceClassificationConnectionContext | null;
  clientProfiles?: SourceClassificationClientContext[];
  projectProfiles?: SourceClassificationProjectContext[];
  contactProfiles?: SourceClassificationContactContext[];
}): Promise<SourceClassificationSuggestion | null> {
  const instructions =
    'Classify one work record for a personal operations assistant. Use the operator, account, client, project, and contact context as soft guidance when judging urgency, awareness-only vs action-required, operational risk, reporting value, and likely mapping. Do not treat the guidance as hard rules; use it to reason about what matters to the operator. A message can be important for awareness without requiring a follow-up. Routine notifications such as share alerts, verification or launch codes, generic digests, local-news style updates, and consumer finance alerts should usually not be action-required unless they clearly affect operations, commitments, security, or contain a direct ask to Jerry. For email, account and recipient context matters: if Jerry is not actually in To/Cc and the message is addressed to shared aliases, team mailboxes, or distribution lists, default to low signal unless it is a strong executive-operational exception such as pricing or MAP issues, outages, system alerts, security/compliance events, or it clearly asks for Jerry. A sender identity matching Jerry does not by itself make the message direct. Return strict JSON with keys clientName, projectName, urgency, actionRequired, awarenessOnly, operationalRisk, reportWorthy, directness, importanceReason, followUpTitle, blocker, actionConfidence, mappingConfidence, confidence. Use null when unknown.';
  const prompt = JSON.stringify({
    source: {
      provider: input.source.provider,
      accountId: input.source.accountId,
      accountLabel: input.source.accountLabel,
      kind: input.source.kind,
      title: input.source.title,
      summary: input.source.summary,
      body: input.source.body,
      participants: input.source.participants,
      senderAddress: input.source.metadata?.senderAddress || input.source.metadata?.fromAddress || null,
      toRecipientAddresses: input.source.metadata?.toRecipientAddresses || [],
      ccRecipientAddresses: input.source.metadata?.ccRecipientAddresses || [],
      bccRecipientAddresses: input.source.metadata?.bccRecipientAddresses || [],
      dueAt: input.source.dueAt,
    },
    operatorContext: input.operatorContext || null,
    connectionContext: input.connectionContext || null,
    clientProfiles: input.clientProfiles || [],
    projectProfiles: input.projectProfiles || [],
    contactProfiles: input.contactProfiles || [],
    clientNames: input.clientNames,
    projectNames: input.projectNames,
  });
  const text = await callOpenAIText({
    instructions,
    prompt,
    model: PERSONAL_OPS_CLASSIFICATION_MODEL,
  });
  if (!text) return null;
  try {
    return JSON.parse(text) as SourceClassificationSuggestion;
  } catch {
    return null;
  }
}

export async function draftOperationalReport(input: {
  reportType: string;
  facts: Record<string, unknown>;
}): Promise<string | null> {
  return callOpenAIText({
    instructions:
      'You write concise, high-trust internal operations summaries. Preserve source traceability and avoid inventing facts.',
    prompt: JSON.stringify(input),
    model: PERSONAL_OPS_REPORT_MODEL,
  });
}
