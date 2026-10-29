# Decision records

Read relevant [records](../adr/README.md) before changing an area with an accepted decision. Surface conflicts instead of silently overriding them.

## When to offer a record

Offer a record only when all three conditions hold:

1. The choice is hard to reverse.
2. It would surprise a future reader without context.
3. It resulted from a real trade-off between alternatives.

Qualifying choices can include architectural boundaries, infrastructure lock-in, deliberate departures from an expected design, constraints invisible in code, and non-obvious rejection of alternatives.

Do not create a record for routine implementation choices or to populate the index. Specifications own current technical intent; records explain consequential choices and why they were made.

## Location and format

Store records in `docs/adr/` as `0001-short-title.md`. Scan existing record filenames and increment the highest number; do not reuse a number.

Use a short title and one to three sentences covering context, choice, and rationale:

```markdown
# Short decision title

Status: proposed

Context, choice, and rationale.
```

Add considered options or consequences only when they help future readers.

## Acceptance and supersession

The project owner accepts a decision. Set `Status: accepted` only after approval, and add the record to the index. An agent proposal is not acceptance.

To revisit an accepted decision, propose a new record. Once approved, mark the earlier record `Status: superseded by <record link>` and link back from the new record. Use `Status: deprecated` when the owner retires a decision without a replacement. Preserve the original rationale.

Reconcile affected consumer guidance, specifications, procedures, and checks. A record does not override the constitution or authorize a public behavior change.

## Maintenance

Update index links and pointers when records move. Changes to these conventions require owner approval. Do not reconstruct historical decisions without an explicit request and supporting evidence.
