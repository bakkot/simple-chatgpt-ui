Streaming chat UI for multiple providers.

## Structure

- `run.ts` — Express server. Serves static files, handles `/chat` POST endpoint via SSE. Uses Anthropic and OpenAI SDKs. Multer for file uploads. Contains all shared types (`ChatConfig`, `ChatRequest`, `StreamEvent`, etc.).
- `index.html` — Single-page UI. Minimal markup + all CSS inline.
- `index.ts` — Client-side logic. Sends messages via FormData, consumes SSE stream, renders responses. Maintains separate per-provider conversation histories.

## Key design decisions

- No build step. TypeScript is stripped at serve-time via `node:module`'s `stripTypeScriptTypes`. The `<script>` tag imports `.ts` directly; the server rewrites on the fly.
- Types shared across client/server. `index.ts` does `import type { ... } from './run.ts'` to keep the interface in sync.
- Raw provider events forwarded. Server wraps each provider's native stream events in `{ type: 'anthropic' | 'openai', event }` and forwards them. Client handles provider-specific rendering.
- File handling is server-side. Client sends raw `File` objects via FormData; server builds provider-specific content blocks.
- Config is per-model (`export type ChatConfig = Sonnet45Config | GPT5Config`). Per-model config and model selection saved to localStorage.

## Type checking

```
npm run check
```

`tsconfig.json` uses `erasableSyntaxOnly` + `verbatimModuleSyntax` — only use `import type` for type-only imports, no enums or parameter properties.
