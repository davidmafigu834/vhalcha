# Knowledge API

Knowledge is not a public unauthenticated API. Operators manage it in the dashboard. AI systems receive it through the existing gateway.

## Chat completions

`POST /v1/chat/completions` stays an OpenAI-compatible chat request. Optional `knowledge_space_ids` is a uuid array of at most 20 ids. The server intersects it with the AI system's grants. Unknown extra fields are still rejected by the strict schema.

When Knowledge is used, the JSON response adds:

```json
{
  "vhalcha": {
    "knowledge": {
      "used": true,
      "evidence": "retrieved",
      "citations": [
        {
          "citation_id": "S1",
          "document_id": "",
          "document_version_id": "",
          "document_title": "",
          "knowledge_space": "",
          "page_number": null,
          "section_title": null,
          "chunk_index": 0
        }
      ]
    }
  }
}
```

`evidence` is `retrieved`, `none`, or `insufficient`. `citations` contains only retrieved sources the model text referenced, such as `[S1]`. Invented ids are dropped.

Streaming keeps the provider's `text/event-stream` chunks. After the provider stream and before `data: [DONE]`, Vhalcha writes one SSE event:

```text
data: {"vhalcha":{"knowledge":{"used":true,"evidence":"retrieved","citations":[]}}}
```

The response header `x-vhalcha-request-id` is unchanged.

If Knowledge is enabled and retrieval throws, the status is 503 and the error code is `knowledge_unavailable`. The provider is not called.

If strict grounding finds no evidence, the status is 200, the assistant content is the fixed insufficient-evidence sentence, `evidence` is `insufficient`, and the provider is not called.

Citations do not include storage keys, database credentials, or another tenant's identifiers.

## Retrieval service

Gateway code calls `retrieve` with the organisation, AI system, query vector, model name, top K, minimum similarity, and the strict/stale flags. The same function is what a future internal HTTP route must call after authentication. V1 does not expose that search without the virtual key path above.

## Dashboard actions

Server actions require `knowledge:read` to view pages, `knowledge:write` to create spaces, upload, archive, and reindex, and `knowledge:manage_access` to grant or revoke AI-system access. Hiding a button is not the control. Owner and AI Admin receive these permissions. Developer, Security Admin, Finance, and Viewer do not receive document content permissions.
