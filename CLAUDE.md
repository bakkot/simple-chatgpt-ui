Streaming chat UI for multiple providers.

## Structure

- `run.ts` — Express server. Serves static files, handles `/chat` POST endpoint via SSE. Uses Anthropic and OpenAI SDKs. Multer for file uploads. Contains all shared types (`ChatConfig`, `ChatRequest`, `StreamEvent`, etc.).
- `index.html` — Single-page UI. Minimal markup + all CSS inline.
- `index.ts` — Client-side logic. Sends messages via FormData, consumes SSE stream, renders responses. Maintains separate per-provider conversation histories.

## Key design decisions

- No build step. TypeScript is stripped at serve-time via `node:module`'s `stripTypeScriptTypes`. The `<script>` tag imports `.ts` directly; the server rewrites on the fly.
- Types shared across client/server. `index.ts` does `import type { ... } from './run.ts'` to keep the interface in sync.
- Raw provider events forwarded. Server wraps each provider's native stream events in `{ type: 'anthropic' | 'openai', event }` and forwards them. Client handles provider-specific rendering.
- Config is per-model (`export type ChatConfig = Sonnet45Config | GPT5Config`). Per-model config and model selection saved to localStorage.
- Tools are per-provider. Anthropic uses beta tool types (`BetaToolUnion`); OpenAI uses `OpenAI.Responses.Tool`. Each provider's streaming function builds a tools array from config booleans and passes it to the SDK.
- The client renders streaming events inline (text deltas, thinking, search, citations) and defers some output to the `done` event (e.g. OpenAI image generation results, which arrive as `image_generation_call` items in the final response output).
- When adding new OpenAI streaming event types, add them to the ignored-events guard in the `case 'openai'` branch to suppress console warnings.

## Constraints

Never, ever use `as any`. If you absolutely must you can cast `as unknown as Whatever`, but only if you leave a comment explaining why this is necessary, but before doing so you should think about whether there is a way to express the thing you need without it.

When a type error arises, prefer fixing the types to reflect reality rather than casting to silence the compiler. For example, if a variable can hold values from two different APIs, widen the type to a union instead of asserting at the point of assignment.

When branching over a string union (model names, provider names, etc.), every branch must explicitly check its value — never use a bare `else` or `default` as an implicit fallback for a known value. The final `else`/`default` must always be an unreachable error guard using `x satisfies never` + `throw new Error(...)`. This ensures TypeScript flags every branch point when a new variant is added.

## Type checking

```
npm run check
```

`tsconfig.json` uses `erasableSyntaxOnly` + `verbatimModuleSyntax` — only use `import type` for type-only imports, no enums or parameter properties.
