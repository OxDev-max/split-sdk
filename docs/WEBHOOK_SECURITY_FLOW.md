# Webhook Security Flow

This document describes how webhook signature validation is expected to work for
incoming webhook deliveries, including the signing scheme, the verification
steps, and the event handling contract that consumers rely on.

## Overview

Every webhook delivery is signed by the sender using an HMAC over the raw
request body. Receivers must verify the signature before trusting or acting on
the payload. Validation is a hard gate: an unsigned, malformed, or mismatched
signature must cause the delivery to be rejected and no event to be emitted.

## Signing scheme

- Algorithm: HMAC-SHA256.
- Secret: a per-endpoint shared secret, never transmitted with the payload.
- Signed content: the exact raw request body bytes, before any JSON parsing or
  normalization. Re-serializing the parsed body will change the bytes and break
  verification.
- Signature header: `X-Webhook-Signature`, formatted as `sha256=<hex digest>`.
- Timestamp header: `X-Webhook-Timestamp`, a Unix epoch value in seconds.

## Verification steps

1. Read the raw body as bytes and keep it unmodified for the duration of the
   check.
2. Read the signature and timestamp headers. If either is missing, reject the
   delivery with a `400`-class response and do not emit an event.
3. Reject deliveries whose timestamp is outside the allowed tolerance window
   (default: 5 minutes) to limit replay attacks.
4. Compute `HMAC-SHA256(secret, timestamp + "." + rawBody)` and hex-encode the
   result.
5. Compare the computed digest against the provided digest using a
   constant-time comparison. Never use `==` or `===` on signature strings.
6. On success, parse the body and dispatch the event. On failure, reject and
   log the attempt without emitting an event.

## Event handling

Once a delivery passes verification, it is dispatched as a typed event:

- The event name is taken from the payload's `type` field.
- The event payload is the parsed body, plus the verified timestamp and the
  delivery identifier when present.
- Handlers are invoked only after verification succeeds. A handler that throws
  must not cause the delivery to be re-verified or re-dispatched.
- Duplicate deliveries (same delivery identifier) should be ignored by
  consumers that require idempotency.

## Failure modes

| Condition | Result |
| --- | --- |
| Missing signature or timestamp header | Reject, no event |
| Timestamp outside tolerance window | Reject, no event |
| Signature mismatch | Reject, no event |
| Malformed JSON after valid signature | Reject, no event |
| Valid signature and body | Dispatch event |

## Testing expectations

Tests for this flow should cover at least:

- A valid signature over an unmodified body is accepted and the event is
  dispatched.
- A signature computed with the wrong secret is rejected and no event is
  dispatched.
- A body that is modified after signing (tampered payload) is rejected.
- A missing or malformed signature header is rejected.
- A timestamp outside the tolerance window is rejected.
- Signature comparison is constant-time and does not short-circuit on the
  first differing byte.
