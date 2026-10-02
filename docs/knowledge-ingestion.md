# Knowledge ingestion

Uploads do not index inside the HTTP request.

```text
upload
  create document and version
  store the file when there is one
  enqueue knowledge.ingest
  return processing
```

The worker then extracts, chunks, embeds, and marks the version ready. The document's `current_version_id` changes in that same transaction. A failed version does not become current.

## Files

V1 extracts PDF, DOCX, TXT, Markdown, and CSV. Images and OCR are not supported. A PDF with almost no extractable text fails as `unsupported_scanned_document` and the operator message says OCR is not supported. The worker does not execute macros, embedded scripts, or remote URLs in the file.

Limits live in `@vhalcha/knowledge` `knowledgeLimits`: 20 MB, 100 PDF pages, 500,000 extracted characters, chunk target 600 tokens, 15% overlap, embedding batch 64, and 3 ingest attempts.

## Jobs

`knowledge.ingest` carries `organisationId`, `documentVersionId`, and optional `force`. The job is idempotent: chunks and embeddings for that version are replaced in one transaction. A retryable provider or storage error is requeued until the attempt limit. Unsupported or corrupt files are not retried. After the limit, the version is `failed` with a safe error code and message. It does not stay `processing`.

Reindex sets the current version back to `pending` and enqueues the same version. It does not create version n+1.

## Embeddings

The worker uses `VHALCHA_EMBEDDING_MODE` when set. Otherwise development follows `VHALCHA_PROVIDER_MODE=mock` to the deterministic embedder, and any other environment uses OpenAI. Production configuration rejects mock embeddings. Tests pass the mock provider directly and do not call OpenAI.

Estimated embedding cost is `(input tokens / 1_000_000) * 0.02` for the OpenAI small embedding price, stored on `knowledge_ingestion_usage`. There is no separate Knowledge budget in V1. The rows are there so a later budget can read them.

## Local pgvector

`docker-compose.yml` uses `pgvector/pgvector:pg16`. Recreating the container keeps the `vhalcha_postgres` volume. Apply `0004_knowledge.sql` with `corepack pnpm db:migrate`. If the server refuses to start on the existing data directory, stop and repair the volume. Do not delete it to get past a startup error.

Set `KNOWLEDGE_STORAGE_DIR` to one absolute directory shared by the dashboard and the worker. When it is unset, both look for the repository root and use `.local/knowledge`.

Development seed adds a fictional Acme space named Product & Support and a Returns Policy, and grants Customer Support AI read access. It does not run in production. The seeded system stays `knowledge_enabled = false` until an operator turns Knowledge on.
