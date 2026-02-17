import fs from 'node:fs';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import express from 'express';
import multer from 'multer';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { GoogleGenAI } from '@google/genai';
import type { Content as GoogleContent, Part as GooglePart, GroundingMetadata } from '@google/genai';

const PORT = 21665; // 'gpt' in base 36

function readKeyOrEmpty(name: string) {
  try {
    return fs.readFileSync(path.join(import.meta.dirname, name), 'utf8').trim()
  } catch (e: any) {
    if (e.code === 'ENOENT') {
      return '';
    }
    throw e;
  }
}

const ANTHROPIC_API_KEY = readKeyOrEmpty('ANTHROPIC_KEY.txt');
const OPENAI_API_KEY = readKeyOrEmpty('OPENAI_KEY.txt');
const GOOGLE_API_KEY = readKeyOrEmpty('GOOGLE_KEY.txt');

const ALLOWED_USERS = fs.readFileSync(path.join(import.meta.dirname, 'ALLOWED_USERS.txt'), 'utf8').split('\n').map(x => x.trim()).filter(x => x.length > 0);

const anthropic = new Anthropic({
  apiKey: ANTHROPIC_API_KEY,
});
const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});
const google = new GoogleGenAI({
  apiKey: GOOGLE_API_KEY,
});


// --- Anthropic types ---
// History can contain both regular and beta message params, since assistant
// responses may include beta-only content blocks (e.g. code execution results).
export type AnthropicMessageParam = Anthropic.MessageParam | Anthropic.Beta.BetaMessageParam;
export type AnthropicMessage = Anthropic.Message | Anthropic.Beta.BetaMessage;
export type AnthropicStreamEvent = Anthropic.RawMessageStreamEvent | Anthropic.Beta.BetaRawMessageStreamEvent;
export type AnthropicHistory = AnthropicMessageParam[];

// --- Google types ---
export type { GoogleContent, GooglePart, GroundingMetadata };
export type GoogleHistory = GoogleContent[];

// --- OpenAI types ---
export type OpenAIInputItem = OpenAI.Responses.ResponseInputItem;
export type OpenAIResponse = OpenAI.Responses.Response;
export type OpenAIHistory = OpenAIInputItem[];

// --- Config ---
export type Sonnet45Config = {
  model: 'claude-sonnet-4-5';
  system?: string;
  thinking?: boolean;
  max_tokens?: number;
  web_search?: boolean;
  web_search_max_uses?: number;
  code_execution?: boolean;
  container?: string;
};

export type Opus46Config = {
  model: 'claude-opus-4-6';
  thinking?: boolean;
  web_search?: boolean;
  web_search_max_uses?: number;
  code_execution?: boolean;
  container?: string;
};

export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh';

export type GPT52Config = {
  model: 'gpt-5.2';
  web_search?: boolean;
  image_generation?: boolean;
  code_interpreter?: boolean;
  container?: string;
  reasoning_effort?: ReasoningEffort;
};

export type Gemini3FlashConfig = {
  model: 'gemini-3-flash-preview';
  google_search?: boolean;
  code_execution?: boolean;
};

export type Gemini3ProConfig = {
  model: 'gemini-3-pro-preview';
  image_generation?: boolean;
  google_search?: boolean;
  code_execution?: boolean;
};

export type ChatConfig = Sonnet45Config | Opus46Config | GPT52Config | Gemini3FlashConfig | Gemini3ProConfig;

// --- Request type ---
export type ChatRequest =
  | { messages: AnthropicHistory; config: Sonnet45Config; text: string }
  | { messages: AnthropicHistory; config: Opus46Config; text: string }
  | { messages: OpenAIHistory; config: GPT52Config; text: string }
  | { messages: GoogleHistory; config: Gemini3FlashConfig | Gemini3ProConfig; text: string };

// --- Stream events ---
export type AnthropicEvent = { type: 'anthropic'; event: AnthropicStreamEvent };
export type OpenAIEvent = { type: 'openai'; event: OpenAI.Responses.ResponseStreamEvent };
export type GoogleStreamChunk = { parts: GooglePart[]; groundingMetadata?: GroundingMetadata };
export type GoogleEvent = { type: 'google'; event: GoogleStreamChunk };
export type DoneEvent =
  | { type: 'done'; provider: 'anthropic'; userMessage: AnthropicMessageParam; assistantMessage: AnthropicMessage; container?: string }
  | { type: 'done'; provider: 'openai'; userInput: OpenAIInputItem; assistantMessage: OpenAIResponse; container?: string }
  | { type: 'done'; provider: 'google'; userContent: GoogleContent; assistantContent: GoogleContent };
export type ErrorEvent = { type: 'error'; error: string };
export type StreamEvent = AnthropicEvent | OpenAIEvent | GoogleEvent | DoneEvent | ErrorEvent;

// --- Anthropic ---

function buildAnthropicUserMessage(text: string, files: Express.Multer.File[]): AnthropicMessageParam {
  if (files.length === 0) {
    return { role: 'user', content: text };
  }

  const blocks: Anthropic.ContentBlockParam[] = [];
  for (const file of files) {
    const base64 = file.buffer.toString('base64');
    if (file.mimetype.startsWith('image/')) {
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: file.mimetype as 'image/jpeg', data: base64 },
      });
    } else if (file.mimetype === 'application/pdf') {
      blocks.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: base64 },
      });
    } else {
      blocks.push({ type: 'text', text: `[File: ${file.originalname}]\n${file.buffer.toString('utf8')}` });
    }
  }

  if (text) {
    blocks.push({ type: 'text', text });
  }

  return { role: 'user', content: blocks };
}

async function streamAnthropicChat(
  messages: AnthropicHistory,
  text: string,
  files: Express.Multer.File[],
  config: Sonnet45Config | Opus46Config,
  send: (event: StreamEvent) => void,
): Promise<void> {
  try {
    const userMessage = buildAnthropicUserMessage(text, files);
    messages.push(userMessage);

    let baseParams: { model: string; max_tokens: number; messages: AnthropicHistory; system?: string; thinking: Anthropic.ThinkingConfigParam };
    switch (config.model) {
      case 'claude-sonnet-4-5': {
        const maxTokens = config.max_tokens ?? 16384;
        baseParams = {
          model: config.model,
          max_tokens: maxTokens,
          messages,
          system: config.system || undefined,
          thinking: config.thinking
            ? { type: 'enabled', budget_tokens: Math.max(1024, maxTokens - 1) }
            : { type: 'disabled' },
        };
        break;
      }
      case 'claude-opus-4-6': {
        baseParams = {
          model: config.model,
          max_tokens: 16384,
          messages,
          thinking: config.thinking ? { type: 'adaptive' } : { type: 'disabled' },
        };
        break;
      }
      default: {
        config satisfies never;
        throw new Error(`unknown model ${(config as { model: string }).model}`);
      }
    }

    const tools: Anthropic.Beta.BetaToolUnion[] = [];
    if (config.code_execution) {
      tools.push({ type: 'code_execution_20250825', name: 'code_execution' });
    }
    if (config.web_search) {
      tools.push({ type: 'web_search_20250305', name: 'web_search', max_uses: config.web_search_max_uses ?? 10 });
    }

    // Always use the beta API — it's a superset of the regular API and accepts
    // the wider AnthropicHistory type (which may contain beta content blocks
    // from previous code execution responses).
    const stream = anthropic.beta.messages.stream({
      ...baseParams,
      tools: tools.length > 0 ? tools : undefined,
      betas: config.code_execution ? ['code-execution-2025-08-25'] : undefined,
      container: config.container ?? undefined,
    });

    for await (const event of stream) {
      send({ type: 'anthropic', event });
    }

    const msg = await stream.finalMessage();
    send({
      type: 'done', provider: 'anthropic', userMessage,
      assistantMessage: msg,
      container: msg.container?.id ?? undefined,
    });
  } catch (err: any) {
    send({ type: 'error', error: err.message ?? String(err) });
  }
}

// --- OpenAI ---

function buildOpenAIUserInput(text: string, files: Express.Multer.File[]): OpenAIInputItem {
  if (files.length === 0) {
    return { role: 'user', content: text };
  }

  const content: OpenAI.Responses.ResponseInputContent[] = [];
  for (const file of files) {
    const base64 = file.buffer.toString('base64');
    if (file.mimetype.startsWith('image/')) {
      content.push({
        type: 'input_image',
        image_url: `data:${file.mimetype};base64,${base64}`,
        detail: 'auto',
      });
    } else {
      content.push({
        type: 'input_file',
        file_data: `data:${file.mimetype};base64,${base64}`,
      });
    }
  }

  if (text) {
    content.push({ type: 'input_text', text });
  }

  return { role: 'user', content };
}

async function streamOpenAIChat(
  input: OpenAIHistory,
  text: string,
  files: Express.Multer.File[],
  config: GPT52Config,
  send: (event: StreamEvent) => void,
): Promise<void> {
  try {
    const userInput = buildOpenAIUserInput(text, files);
    input.push(userInput);

    const tools: OpenAI.Responses.Tool[] = [];
    if (config.web_search) {
      tools.push({ type: 'web_search' });
    }
    if (config.image_generation) {
      tools.push({ type: 'image_generation' });
    }
    if (config.code_interpreter) {
      tools.push({
        type: 'code_interpreter',
        container: config.container ?? { type: 'auto' },
      });
    }

    const reasoning = config.reasoning_effort && config.reasoning_effort !== 'none'
      ? { effort: config.reasoning_effort, summary: 'auto' as const } : undefined;

    const stream = await openai.responses.stream({
      model: config.model,
      input,
      tools: tools.length > 0 ? tools : undefined,
      reasoning,
    });

    for await (const event of stream) {
      send({ type: 'openai', event });
    }

    const assistantMessage = await stream.finalResponse();
    // Extract container_id from code_interpreter_call output items for round-tripping
    let container: string | undefined;
    for (const item of assistantMessage.output) {
      if (item.type === 'code_interpreter_call') {
        container = item.container_id;
        break;
      }
    }
    send({ type: 'done', provider: 'openai', userInput, assistantMessage, container });
  } catch (err: any) {
    send({ type: 'error', error: err.message ?? String(err) });
  }
}

// --- Google ---

function buildGoogleUserContent(text: string, files: Express.Multer.File[]): GoogleContent {
  const parts: GooglePart[] = [];
  for (const file of files) {
    const base64 = file.buffer.toString('base64');
    if (file.mimetype.startsWith('image/') || file.mimetype === 'application/pdf') {
      parts.push({
        inlineData: { mimeType: file.mimetype, data: base64 },
      });
    } else {
      parts.push({ text: `[File: ${file.originalname}]\n${file.buffer.toString('utf8')}` });
    }
  }
  if (text) {
    parts.push({ text });
  }
  return { role: 'user', parts };
}

async function streamGoogleChat(
  history: GoogleHistory,
  text: string,
  files: Express.Multer.File[],
  config: Gemini3FlashConfig | Gemini3ProConfig,
  send: (event: StreamEvent) => void,
): Promise<void> {
  try {
    const userContent = buildGoogleUserContent(text, files);
    history.push(userContent);

    let model: string = config.model;
    let generateConfig: Record<string, unknown> | undefined;
    if (config.model === 'gemini-3-pro-preview' && config.image_generation) {
      model = 'gemini-3-pro-image-preview';
      generateConfig = { responseModalities: ['TEXT', 'IMAGE'] };
    }
    const googleTools: Record<string, Record<string, never>>[] = [];
    if (config.google_search) googleTools.push({ googleSearch: {} });
    if (config.code_execution) googleTools.push({ codeExecution: {} });
    if (googleTools.length > 0) {
      generateConfig = { ...generateConfig, tools: googleTools };
    }

    const stream = await google.models.generateContentStream({
      model,
      contents: history,
      config: generateConfig,
    });

    const allParts: GooglePart[] = [];
    for await (const chunk of stream) {
      const candidate = chunk.candidates?.[0];
      const parts = candidate?.content?.parts;
      if (parts && parts.length > 0) {
        const groundingMetadata = candidate?.groundingMetadata;
        send({ type: 'google', event: { parts, groundingMetadata } });
        for (const part of parts) {
          // Merge consecutive text parts into one
          const last = allParts[allParts.length - 1];
          if (part.text != null && last?.text != null) {
            last.text += part.text;
          } else {
            allParts.push({ ...part });
          }
        }
      }
    }

    const assistantContent: GoogleContent = { role: 'model', parts: allParts };
    send({ type: 'done', provider: 'google', userContent, assistantContent });
  } catch (err: any) {
    send({ type: 'error', error: err.message ?? String(err) });
  }
}

// --- Express ---

const app = express();
app.use(express.json({ limit: '50mb' }));
app.get('/', function (req, res) {
  res.sendFile(path.join(import.meta.dirname, 'index.html'));
});
app.get('/*file.ts', function (req, res) {
  const filePath = path.join(import.meta.dirname, req.path);
  const resolvedPath = path.resolve(filePath);

  if (!resolvedPath.startsWith(import.meta.dirname + path.sep)) {
    res.status(403).send('Forbidden');
    return;
  }

  if (!fs.existsSync(resolvedPath)) {
    res.status(404).send('Not found');
    return;
  }

  const content = fs.readFileSync(resolvedPath, 'utf8');
  res.type('text/javascript');
  res.send(stripTypeScriptTypes(content, { mode: 'strip' }));
});
app.post('/check-user', (req, res) => {
  let { user } = req.body;
  if (ALLOWED_USERS.includes(user)) {
    res.send('ok');
  } else {
    res.send('fail');
  }
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024, fieldSize: 50 * 1024 * 1024 } });

app.post('/chat', upload.array('files'), async (req, res) => {
  const chatUser = req.body.user;
  if (!chatUser || !ALLOWED_USERS.includes(chatUser)) {
    res.status(403).send('invalid user');
    return;
  }

  const chat: ChatRequest = {
    messages: JSON.parse(req.body.messages),
    config: JSON.parse(req.body.config),
    text: req.body.text || '',
  };
  const files = (req.files as Express.Multer.File[]) || [];

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  function send(event: StreamEvent) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  switch (chat.config.model) {
    case 'claude-sonnet-4-5':
    case 'claude-opus-4-6': {
      await streamAnthropicChat(chat.messages as AnthropicHistory, chat.text, files, chat.config, send);
      break;
    }
    case 'gpt-5.2': {
      await streamOpenAIChat(chat.messages as OpenAIHistory, chat.text, files, chat.config, send);
      break;
    }
    case 'gemini-3-flash-preview':
    case 'gemini-3-pro-preview': {
      await streamGoogleChat(chat.messages as GoogleHistory, chat.text, files, chat.config, send);
      break;
    }
    default: {
      chat.config satisfies never; // assert switch exhaustiveness
      throw new Error(`unknown model ${(chat.config as { model: string }).model}`);
    }
  }

  res.end();
});

app.listen(PORT, (error) => {
  if (error) {
    throw error;
  }
  console.log(`Listening at http://localhost:${PORT}`);
});
