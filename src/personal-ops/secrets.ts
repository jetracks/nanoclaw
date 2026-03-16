import { readEnvFile } from '../env.js';

export interface PersonalOpsSecrets {
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL?: string;
  OPENAI_ORGANIZATION?: string;
  OPENAI_PROJECT?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  MICROSOFT_CLIENT_ID?: string;
  MICROSOFT_CLIENT_SECRET?: string;
  MICROSOFT_TENANT_ID?: string;
  JIRA_CLIENT_ID?: string;
  JIRA_CLIENT_SECRET?: string;
  SLACK_CLIENT_ID?: string;
  SLACK_CLIENT_SECRET?: string;
}

export function loadPersonalOpsSecrets(): PersonalOpsSecrets {
  const envFile = readEnvFile([
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'OPENAI_ORGANIZATION',
    'OPENAI_PROJECT',
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'MICROSOFT_CLIENT_ID',
    'MICROSOFT_CLIENT_SECRET',
    'MICROSOFT_TENANT_ID',
    'JIRA_CLIENT_ID',
    'JIRA_CLIENT_SECRET',
    'SLACK_CLIENT_ID',
    'SLACK_CLIENT_SECRET',
  ]);

  return {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || envFile.OPENAI_API_KEY,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL || envFile.OPENAI_BASE_URL,
    OPENAI_ORGANIZATION:
      process.env.OPENAI_ORGANIZATION || envFile.OPENAI_ORGANIZATION,
    OPENAI_PROJECT: process.env.OPENAI_PROJECT || envFile.OPENAI_PROJECT,
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || envFile.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET:
      process.env.GOOGLE_CLIENT_SECRET || envFile.GOOGLE_CLIENT_SECRET,
    MICROSOFT_CLIENT_ID:
      process.env.MICROSOFT_CLIENT_ID || envFile.MICROSOFT_CLIENT_ID,
    MICROSOFT_CLIENT_SECRET:
      process.env.MICROSOFT_CLIENT_SECRET || envFile.MICROSOFT_CLIENT_SECRET,
    MICROSOFT_TENANT_ID:
      process.env.MICROSOFT_TENANT_ID ||
      envFile.MICROSOFT_TENANT_ID ||
      'common',
    JIRA_CLIENT_ID: process.env.JIRA_CLIENT_ID || envFile.JIRA_CLIENT_ID,
    JIRA_CLIENT_SECRET:
      process.env.JIRA_CLIENT_SECRET || envFile.JIRA_CLIENT_SECRET,
    SLACK_CLIENT_ID: process.env.SLACK_CLIENT_ID || envFile.SLACK_CLIENT_ID,
    SLACK_CLIENT_SECRET:
      process.env.SLACK_CLIENT_SECRET || envFile.SLACK_CLIENT_SECRET,
  };
}
