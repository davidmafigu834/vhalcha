# Routing

Optimised AI systems select a model after Knowledge retrieval and before budget reservation. Fixed systems keep the client model.

Streaming fallback is allowed only when the provider fails before the first response byte. If any output has already been written, the stream fails and Vhalcha does not switch models.

Estimated savings use catalogue prices and token estimates against the AI system's baseline model. When no baseline is configured, the product shows "Baseline not configured" and does not invent a saving.

Organisation provider credentials are encrypted with `VHALCHA_SECRETS_KEY`. Vhalcha-managed billing is not implemented.
