# Project memory

## Product intent & audience

- Finora AI — financial consultant app with an AI chat endpoint (`ai-consultant` Edge Function).
- Audience: authenticated end-users who consult AI about personal financial context.
- Edge Function owned at `supabase/functions/ai-consultant/index.ts`.

## Brand personality & voice

- Security-forward and non-destructive by default; hardening prompts emphasize preserving existing behavior and architecture.
- Internal reports are written in Indonesian (Bahasa Indonesia), structured, and honest about unverified test paths (no claiming test success without runtime evidence).

## Visual design & UX direction

- Frontend untouched in current prompt; no UI/UX inferences beyond Vite + React + TypeScript stack.
- API response contract kept stable: `{ reply, conversationId }`, optional `persisted: false` added for failed persistence (backward-compatible).

## Decisions, constraints & rationale

- Stack locked: React, Vite, TypeScript, Supabase. No new dependencies unless strictly required.
- Do not rebuild or replace existing AI architecture: Provider Adapter, Model Registry, AI Router, Financial Context Builder must remain intact.
- Request validation: POST-only (besides OPTIONS), valid JSON body, non-empty `message` string ≤ 5,000 chars, UUID-format `conversationId` when provided, boolean-only `includeProfile`. Invalid → 400 (or 405 for method).
- Conversation ownership: history filtered by both `conversation_id` and `user_id` (verified JWT user); never fetch another user's messages.
- History now fetches latest 20 messages (desc + reverse) instead of first 20 — intentional improvement, not regression.
- DB error handling: user-message insert / history fetch / conversation create failures → generic 500, details only in server logs. Assistant-message insert failure → 200 with `persisted: false` so user still sees reply; timestamp update failure only logged.
- Security preserved: JWT mandatory, service role key server-only, provider API keys in edge env (never frontend), Financial Context Builder keyed to verified `user.id`, `includeProfile` consent honored, RLS untouched, no migrations.
- OpenAI provider present; testing constrained by lack of active credits/login sessions at report time.

## Open questions & assumptions

- Untested at runtime with valid JWT: cross-user `conversationId` rejection, empty/oversized message rejection, end-to-end normal conversation. Verified by code review only.
- Assumption: existing frontend ignores unknown response fields, so `persisted: false` is safe.
- Assumption: existing DB RLS policies are already correct and need no changes.