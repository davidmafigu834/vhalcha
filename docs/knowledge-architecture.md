# Knowledge architecture

Vhalcha Knowledge is the organisation's governed source of company information. Several AI systems can retrieve the same approved material. It is not a separate chatbot, and it does not claim to eliminate hallucinations.

```text
Organisation
  Knowledge Space
    Knowledge Source (manual_upload, manual_text)
      Document
        Document Version
          Extracted text
            Chunks
              Embeddings in pgvector
                Retrieval for one AI system
                  Grounded provider context
                    Response and citations
```

Later source types are named in the database check (`google_drive`, `sharepoint`, `onedrive`, `website`, `api`, `database`, `notion`) and are not implemented.

## Request path

When `knowledge_enabled` is false, the existing gateway path is unchanged.

When it is true:

```text
authenticate
tenant context
load AI system
system status
rate limit
model access
knowledge retrieval
construct provider context
estimate final model cost
budget reservation
create request
provider_started
provider
finalization
audit
```

Retrieval failure returns `knowledge_unavailable` and does not call the provider. That is the behaviour for both strict and non-strict systems. A document that fails to index does not make the gateway unavailable.

If strict grounding is on and no chunk passes the filters, the gateway returns a fixed insufficient-evidence sentence and does not call the provider or reserve a model budget.

## Retrieval filters

Results must be in an active space granted to that AI system with access level `read`. A client `knowledge_space_ids` list is intersected with those grants. Empty intersection returns no evidence.

Chunks must belong to the document's `current_version_id`, with document status `ready`, version status `ready`, `archived_at` null, `effective_date` not in the future, and `expiry_date` not in the past. Expired documents are never retrieved. Stale documents are retrieved only when `knowledge_allow_stale` is true and strict grounding is off. `review_soon` and `current` are retrieved. Failed documents are not.

Top K defaults to 6 and is clamped to 1–20. The starting minimum similarity is 0.2. That threshold is a filter, not a confidence claim. Retrieved text is capped at 6,000 estimated tokens.

The query embedding is the latest user message. There is no query-rewriting model call.

## Versions

A replacement file creates the next version and is indexed before it becomes `current_version_id`. A failed version does not replace the current one. Reindex rebuilds chunks and embeddings for the same version and the same content hash. Identical content uploaded again does not create another version when the current version is already ready with that hash.

## Embeddings

`EmbeddingProvider` has `embedDocuments` and `embedQuery`. Production uses OpenAI `text-embedding-3-small` at 1536 dimensions, batched. Development and tests use `vhalcha-deterministic-v1`, which is refused when `VHALCHA_ENV=production` or `VHALCHA_EMBEDDING_MODE=mock` in production. Vectors are compared only when the stored model and dimensions match.

Chat usage still comes from the provider's token counts after the knowledge context is included. Embedding tokens and estimated cost are written to `knowledge_ingestion_usage`.

## Dashboard

The console adds Knowledge, Spaces, a space detail page, and a document page. Upload enqueues `knowledge.ingest`. The page stays on processing until the worker marks the version ready.
