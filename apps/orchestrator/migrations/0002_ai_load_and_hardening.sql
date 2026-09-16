-- ============================================================================
-- 0002_ai_load_and_hardening.sql
--
-- Adds the tables behind AI-load minimisation (caches, precomputation, daily
-- brief) and production hardening (idempotency), plus the indexes the new
-- read paths need. Applied once inside a transaction by
-- src/adapters/db/migrate.ts (never edit 0001; always add a new numbered file).
--
-- Vector index note: `CREATE INDEX CONCURRENTLY` cannot run inside a
-- transaction, so it is NOT in this file. The migration runner creates the
-- pgvector HNSW index concurrently *after* all migrations have been applied
-- (see `ensureVectorIndex` in migrate.ts), which keeps `email_index` writable
-- during the build. To do it by hand on a large table:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS email_index_embedding_idx
--     ON email_index USING hnsw (embedding vector_cosine_ops);
-- ============================================================================

-- ----------------------------------------------------------- analysis_cache --
-- Content-hash cache of model answers. `key` = SHA-256 of the normalised
-- (subject + cleaned body + attachment names + language + prompt version),
-- computed by src/domain/cacheKey.ts. Scoped per user: a cache entry must never
-- let one mailbox read another's analysis, even on identical content.
CREATE TABLE IF NOT EXISTS analysis_cache (
  user_id          text        NOT NULL,
  cache_key        text        NOT NULL,
  kind             text        NOT NULL CHECK (kind IN ('analysis','thread','draft')),
  email_id         text,
  conversation_id  text,
  value            jsonb       NOT NULL,
  model            text,
  origin           text        NOT NULL DEFAULT 'llm' CHECK (origin IN ('llm','precomputed','heuristic')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  PRIMARY KEY (user_id, cache_key)
);
-- `GET /analyze/email/:id`: newest live analysis of one email.
CREATE INDEX IF NOT EXISTS analysis_cache_email_idx   ON analysis_cache (user_id, email_id, created_at DESC) WHERE kind = 'analysis';
CREATE INDEX IF NOT EXISTS analysis_cache_expiry_idx  ON analysis_cache (expires_at);
CREATE INDEX IF NOT EXISTS analysis_cache_conv_idx    ON analysis_cache (user_id, conversation_id);

-- ---------------------------------------------------------- embedding_cache --
-- Vectors keyed by (embedding model, chunk SHA-256): re-indexing a mailbox
-- never re-embeds text that has not changed. Not per-user on purpose — the key
-- is a hash of the text and the stored value is only a vector, so sharing it
-- across mailboxes saves GPU time on distribution lists without exposing text.
CREATE TABLE IF NOT EXISTS embedding_cache (
  model       text        NOT NULL,
  cache_key   text        NOT NULL,
  embedding   real[]      NOT NULL,
  dims        integer     NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  PRIMARY KEY (model, cache_key)
);
CREATE INDEX IF NOT EXISTS embedding_cache_expiry_idx ON embedding_cache (expires_at);

-- -------------------------------------------------------- mailbox_sync_state --
-- One row per synced mailbox: the Graph delta token, the worker's state machine
-- and the counters surfaced by `GET /mailbox/sync` (MailboxSyncStatus).
CREATE TABLE IF NOT EXISTS mailbox_sync_state (
  user_id               text        PRIMARY KEY,
  user_email            text        NOT NULL,
  delta_token           text,
  state                 text        NOT NULL DEFAULT 'idle' CHECK (state IN ('idle','syncing','error','disabled')),
  last_sync_at          timestamptz,
  next_sync_at          timestamptz,
  last_error            text,
  indexed_emails        integer     NOT NULL DEFAULT 0,
  precomputed_analyses  integer     NOT NULL DEFAULT 0,
  pending               integer     NOT NULL DEFAULT 0,
  auth_mode             text        NOT NULL DEFAULT 'obo' CHECK (auth_mode IN ('obo','app')),
  msal_home_account_id  text,
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mailbox_sync_due_idx ON mailbox_sync_state (next_sync_at NULLS FIRST) WHERE state <> 'disabled';

-- -------------------------------------------------------------- daily_briefs --
-- Pre-generated morning brief, one row per user per day (user's timezone).
CREATE TABLE IF NOT EXISTS daily_briefs (
  user_id       text        NOT NULL,
  brief_date    date        NOT NULL,
  brief         jsonb       NOT NULL,
  source        text        NOT NULL DEFAULT 'precomputed' CHECK (source IN ('llm','precomputed','heuristic')),
  generated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, brief_date)
);
CREATE INDEX IF NOT EXISTS daily_briefs_date_idx ON daily_briefs (brief_date DESC);

-- ---------------------------------------------------------- idempotency_keys --
-- `Idempotency-Key` on POST /actions/approve: a retried request returns the
-- stored response instead of executing the actions twice.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  user_id       text        NOT NULL,
  idem_key      text        NOT NULL,
  request_hash  text        NOT NULL,
  response      jsonb       NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  PRIMARY KEY (user_id, idem_key)
);
CREATE INDEX IF NOT EXISTS idempotency_expiry_idx ON idempotency_keys (expires_at);

-- ------------------------------------------------------------------ indexes --
-- Keyset pagination for the streaming CSV export (`GET /audit/export`).
CREATE INDEX IF NOT EXISTS audit_events_keyset_idx ON audit_events (ts DESC, id DESC);
-- Retention purge of email_index (INDEX_RETENTION_DAYS).
CREATE INDEX IF NOT EXISTS email_index_received_idx ON email_index (received_at);
CREATE INDEX IF NOT EXISTS email_index_indexed_idx  ON email_index (indexed_at);
