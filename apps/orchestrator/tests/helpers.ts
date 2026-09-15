import { loadConfig, type Config } from "../src/config.js";
import { createContainer, type Container, type ContainerOverrides } from "../src/container.js";
import { createMemoryRepositories, type MemoryRepositories } from "../src/adapters/memory/index.js";
import { MockEmbeddingProvider, MockLlmProvider } from "../src/adapters/llm/mock.js";
import type { AuthenticatedUser } from "../src/auth/identity.js";
import type { RequestContext } from "../src/services/context.js";
import type { EmailContext } from "@oao/shared";

export const TEST_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  LLM_PROVIDER: "mock",
  DATABASE_URL: "memory",
  AUTH_MODE: "dev",
  EMBEDDINGS_ENABLED: "true",
  EMBEDDING_DIMENSIONS: "64",
  ADMIN_EMAILS: "admin@northbridge.example",
  COMPLIANCE_EMAILS: "compliance@northbridge.example",
  ADMIN_API_TOKEN: "test-admin-token",
  RATE_LIMIT_PER_MINUTE: "10000",
  DEFAULT_LANGUAGE: "en",
  LOG_LEVEL: "silent",
};

export interface TestContainer extends Container {
  repos: MemoryRepositories;
  llm: MockLlmProvider;
}

export async function createTestContainer(env: NodeJS.ProcessEnv = {}, overrides: ContainerOverrides = {}): Promise<TestContainer> {
  const cfg: Config = loadConfig({ ...TEST_ENV, ...env });
  const repos = createMemoryRepositories();
  const llm = new MockLlmProvider();
  const c = await createContainer(cfg, { repos, llm, embeddings: new MockEmbeddingProvider(64), ...overrides });
  return Object.assign(c, { repos, llm });
}

export const user = (email = "dev.user@northbridge.example", roles: AuthenticatedUser["roles"] = ["user"], extra: Partial<AuthenticatedUser> = {}): AuthenticatedUser => ({ id: email, email, displayName: email.split("@")[0], roles, via: "dev-headers", ...extra });
export const ctx = (u: AuthenticatedUser = user(), language: "fr" | "en" = "en"): RequestContext => ({ user: u, language, correlationId: "test-corr" });

export const sampleEmail = (over: Partial<EmailContext> = {}): EmailContext => ({
  id: "email-1",
  conversationId: "conv-1",
  subject: "Q2 vendor risk assessment – approval needed",
  from: { name: "Sarah Johnson", address: "sarah.johnson@vendorco.com" },
  to: [{ address: "dev.user@northbridge.example" }],
  cc: [],
  bcc: [],
  receivedAt: "2025-06-10T09:24:00.000Z",
  body: "Hi,\n\nPlease find attached the Q2 vendor risk assessment report for review. There are high-risk findings that require your input and approval by Friday 20 June. This document is confidential.\n\nThanks,\nSarah",
  attachments: [{ id: "a1", name: "Q2 Vendor Risk Assessment.pdf", contentType: "application/pdf" }],
  categories: [],
  ...over,
});
