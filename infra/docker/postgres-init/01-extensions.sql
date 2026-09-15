-- Runs once, automatically, the first time the postgres data volume is
-- initialised (standard /docker-entrypoint-initdb.d/ mechanism of the
-- pgvector/pgvector image). Enables the extension the orchestrator's
-- migrations rely on for the email semantic index (apps/orchestrator/migrations).
CREATE EXTENSION IF NOT EXISTS vector;
