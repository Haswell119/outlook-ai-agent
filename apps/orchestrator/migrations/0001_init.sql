-- ============================================================================
-- 0001_init.sql — Outlook AI Orchestrator schema
-- Plain SQL, applied once inside a transaction by src/adapters/db/migrate.ts.
-- The runner sets `oao.embedding_dimensions` (from EMBEDDING_DIMENSIONS) before
-- running this file; the pgvector column is created only when the extension
-- is available (see the DO block at the end).
-- ============================================================================

-- ---------------------------------------------------------------- policies --
CREATE TABLE IF NOT EXISTS policies (
  id          text PRIMARY KEY DEFAULT 'default',
  policy      jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);

-- ------------------------------------------------------------ audit_events --
-- One row per AI suggestion / action / check (non-negotiable audit trail).
-- `details` holds structured data + SHA-256 hashes of prompt / response.
CREATE TABLE IF NOT EXISTS audit_events (
  id                      uuid PRIMARY KEY,
  ts                      timestamptz NOT NULL DEFAULT now(),
  user_id                 text NOT NULL,
  user_email              text NOT NULL,
  user_display_name       text,
  type                    text NOT NULL,
  source_label            text,
  source_email_id         text,
  source_conversation_id  text,
  source_counterpart      text,
  risk_level              text CHECK (risk_level IN ('low','medium','high')),
  approval_status         text NOT NULL DEFAULT 'n/a',
  approved_by             text,
  confidence              real CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  model                   text,
  latency_ms              integer,
  details                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  correlation_id          text
);
CREATE INDEX IF NOT EXISTS audit_events_ts_idx          ON audit_events (ts DESC);
CREATE INDEX IF NOT EXISTS audit_events_user_idx        ON audit_events (user_id, ts DESC);
CREATE INDEX IF NOT EXISTS audit_events_type_idx        ON audit_events (type, ts DESC);
CREATE INDEX IF NOT EXISTS audit_events_risk_idx        ON audit_events (risk_level);
CREATE INDEX IF NOT EXISTS audit_events_approval_idx    ON audit_events (approval_status);

-- ------------------------------------------------------------- email_index --
-- Chunked plain-text emails for search / chat. One row per chunk.
-- `tsv` is always present (lexical search); `embedding` is added below when pgvector exists.
CREATE TABLE IF NOT EXISTS email_index (
  id                   bigserial PRIMARY KEY,
  user_id              text NOT NULL,
  email_id             text NOT NULL,
  conversation_id      text,
  internet_message_id  text,
  subject              text NOT NULL DEFAULT '',
  from_name            text,
  from_address         text,
  received_at          timestamptz,
  folder               text,
  web_link             text,
  has_attachments      boolean NOT NULL DEFAULT false,
  attachment_names     text[] NOT NULL DEFAULT '{}',
  chunk_no             integer NOT NULL DEFAULT 0,
  body_text            text NOT NULL DEFAULT '',
  indexed_at           timestamptz NOT NULL DEFAULT now(),
  tsv                  tsvector GENERATED ALWAYS AS (
                         setweight(to_tsvector('simple', coalesce(subject, '')), 'A') ||
                         setweight(to_tsvector('simple', coalesce(body_text, '')), 'B')
                       ) STORED,
  UNIQUE (user_id, email_id, chunk_no)
);
CREATE INDEX IF NOT EXISTS email_index_tsv_idx      ON email_index USING gin (tsv);
CREATE INDEX IF NOT EXISTS email_index_user_idx     ON email_index (user_id, received_at DESC);
CREATE INDEX IF NOT EXISTS email_index_conv_idx     ON email_index (user_id, conversation_id);
CREATE INDEX IF NOT EXISTS email_index_from_idx     ON email_index (user_id, from_address);

-- ------------------------------------------------------------------- chat --
CREATE TABLE IF NOT EXISTS chat_sessions (
  id          uuid PRIMARY KEY,
  user_id     text NOT NULL,
  title       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_sessions_user_idx ON chat_sessions (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS chat_messages (
  id          bigserial PRIMARY KEY,
  session_id  uuid NOT NULL REFERENCES chat_sessions (id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('user','assistant')),
  content     text NOT NULL,
  sources     jsonb,
  audit_id    uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_messages_session_idx ON chat_messages (session_id, id);

-- ---------------------------------------------------------------- actions --
-- A proposal groups the actions suggested for one email/thread; 30 min validity.
CREATE TABLE IF NOT EXISTS action_proposals (
  id               uuid PRIMARY KEY,
  user_id          text NOT NULL,
  audit_id         uuid NOT NULL,
  email_id         text,
  conversation_id  text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS action_proposals_user_idx ON action_proposals (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS proposed_actions (
  id           uuid PRIMARY KEY,
  proposal_id  uuid NOT NULL REFERENCES action_proposals (id) ON DELETE CASCADE,
  type         text NOT NULL,
  action       jsonb NOT NULL,             -- full ProposedAction (contract)
  status       text NOT NULL DEFAULT 'proposed'
               CHECK (status IN ('proposed','executed','pending_client','pending_compliance','rejected','failed','cancelled')),
  message      text,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS proposed_actions_proposal_idx ON proposed_actions (proposal_id);

-- ------------------------------------------------------------ escalations --
CREATE TABLE IF NOT EXISTS escalations (
  id                uuid PRIMARY KEY,
  user_id           text NOT NULL,
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  requested_by      text NOT NULL,
  requested_at      timestamptz NOT NULL DEFAULT now(),
  reason            text NOT NULL,
  decided_by        text,
  decided_at        timestamptz,
  decision_comment  text,
  issues            jsonb NOT NULL DEFAULT '[]'::jsonb,
  action_id         uuid,
  draft             jsonb
);
CREATE INDEX IF NOT EXISTS escalations_status_idx ON escalations (status, requested_at DESC);
CREATE INDEX IF NOT EXISTS escalations_user_idx   ON escalations (user_id, requested_at DESC);

-- ------------------------------------------------------------ automations --
CREATE TABLE IF NOT EXISTS automations (
  id               uuid PRIMARY KEY,
  user_id          text NOT NULL,
  fingerprint      text NOT NULL,          -- trigger + step types, avoids duplicate proposals
  name             text NOT NULL,
  description      text NOT NULL DEFAULT '',
  trigger          jsonb NOT NULL,
  steps            jsonb NOT NULL,
  status           text NOT NULL DEFAULT 'proposed'
                   CHECK (status IN ('proposed','simulated','approved','active','rejected','paused')),
  stats            jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence       real NOT NULL DEFAULT 0.5,
  risk_level       text NOT NULL DEFAULT 'low' CHECK (risk_level IN ('low','medium','high')),
  last_simulation  jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS automations_user_idx ON automations (user_id, updated_at DESC);

-- User actions observed by the add-in (input of the routine detector).
CREATE TABLE IF NOT EXISTS user_action_events (
  id           uuid PRIMARY KEY,
  user_id      text NOT NULL,
  type         text NOT NULL,
  occurred_at  timestamptz NOT NULL,
  email        jsonb NOT NULL,
  parameters   jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS user_action_events_user_idx ON user_action_events (user_id, occurred_at DESC);

-- --------------------------------------------------------------- feedback --
CREATE TABLE IF NOT EXISTS feedback (
  id          uuid PRIMARY KEY,
  audit_id    uuid NOT NULL,
  user_id     text NOT NULL,
  rating      text NOT NULL CHECK (rating IN ('up','down')),
  comment     text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS feedback_audit_idx ON feedback (audit_id);

-- ------------------------------------------------- pgvector (optional) -----
-- Try to enable pgvector; if it is not installed we simply keep lexical search.
DO $$
DECLARE
  dims integer := coalesce(nullif(current_setting('oao.embedding_dimensions', true), ''), '1024')::integer;
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS vector;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pgvector not available (%): embeddings disabled, lexical search only', SQLERRM;
  END;

  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'email_index' AND column_name = 'embedding') THEN
      EXECUTE format('ALTER TABLE email_index ADD COLUMN embedding vector(%s)', dims);
    END IF;
    BEGIN
      EXECUTE 'CREATE INDEX IF NOT EXISTS email_index_embedding_idx ON email_index USING hnsw (embedding vector_cosine_ops)';
    EXCEPTION WHEN OTHERS THEN
      -- older pgvector without HNSW: ivfflat needs data, so skip the index (sequential scan is fine for a mailbox)
      RAISE NOTICE 'vector index not created (%)', SQLERRM;
    END;
  END IF;
END $$;
