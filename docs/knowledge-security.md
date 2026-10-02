# Knowledge security

Knowledge can hold sensitive company information. These controls reduce exposure. They are not a claim of perfect isolation or of immunity to prompt injection.

## Tenant isolation

Every Knowledge table has `organisation_id`. Row level security is enabled and forced. The policy is `tenant_isolation`: a row is visible when it matches `app.current_organisation_id()`, or the session user is `vhalcha_worker`.

The gateway and dashboard use `vhalcha_app` in production. The worker uses `vhalcha_worker`. The local Docker role `vhalcha` is a superuser and bypasses RLS, so it must not be the production Knowledge connection. Tests set the role to `vhalcha_app`.

Inserts and updates also run security-invoker triggers. A document, version, chunk, embedding, source, or access row cannot point at a parent the current tenant cannot see. Organisation A cannot grant Organisation B's AI system access to Organisation B's space while setting `organisation_id` to A.

## Storage

Objects use `KnowledgeObjectStore`. The V1 implementation is a local directory, not a public bucket. Keys look like `knowledge/{organisationId}/{documentId}/{versionId}/original`. `get` and `delete` reject a key whose prefix is a different organisation or that contains `..`. There are no public URLs. Downloads go through the server, which checks the tenant before reading bytes.

## AI-system access

An AI system does not receive every space. `ai_system_knowledge_access` grants `read` for one system and one space. Retrieval ignores any other space, including one named in the request body.

## Document lifecycle

Versions are immutable records. Only the current ready version is retrieved. Archive sets document status to `archived` and excludes it immediately. Expired and not-yet-effective documents are excluded. Hard delete is not the V1 path.

## Embeddings and traces

The embedding value stays in `knowledge_chunk_embeddings` with the model name and dimension count. Retrieval events store ids, rank, and similarity. They do not store chunk text or the user query.

## Content privacy

Chunk text can be sent to the model provider as delimited reference data. Audit metadata, policy metadata, idempotency records, and logs are not a place for that text. The canary `CONFIDENTIAL_KNOWLEDGE_CANARY_984273` is used to check those stores.

## Citations

Structured citations are built from retrieved sources whose ids appear in the model text. An invented id such as `[S99]` is omitted.

## Strict grounding and prompt injection

Strict mode tells the model to answer only from the supplied context and to say the answer cannot be verified when evidence is missing. If no chunk qualifies, Vhalcha does not call the model. The retrieved block says the text is reference information and must not be treated as system instructions.

That is a baseline. It does not detect every injection, and it does not guarantee the model will follow the instruction when a provider call is made.
