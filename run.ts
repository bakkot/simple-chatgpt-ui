import fs from 'node:fs';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import express from 'express';
import multer from 'multer';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

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

const ALLOWED_USERS = fs.readFileSync(path.join(import.meta.dirname, 'ALLOWED_USERS.txt'), 'utf8').split('\n').map(x => x.trim()).filter(x => x.length > 0);

const anthropic = new Anthropic({
  apiKey: ANTHROPIC_API_KEY,
});
const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

// --- Anthropic types ---
export type AnthropicMessageParam = Anthropic.MessageParam;
export type AnthropicMessage = Anthropic.Message;
export type AnthropicHistory = AnthropicMessageParam[];

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
};

export type GPT5Config = {
  model: 'gpt-5';
};

export type ChatConfig = Sonnet45Config | GPT5Config;

// --- Request type ---
export type ChatRequest =
  | { messages: AnthropicHistory; config: Sonnet45Config; text: string }
  | { messages: OpenAIHistory; config: GPT5Config; text: string };

// --- Stream events ---
export type AnthropicEvent = { type: 'anthropic'; event: Anthropic.RawMessageStreamEvent };
export type OpenAIEvent = { type: 'openai'; event: OpenAI.Responses.ResponseStreamEvent };
export type DoneEvent =
  | { type: 'done'; provider: 'anthropic'; userMessage: AnthropicMessageParam; assistantMessage: AnthropicMessage }
  | { type: 'done'; provider: 'openai'; userInput: OpenAIInputItem; assistantMessage: OpenAIResponse };
export type ErrorEvent = { type: 'error'; error: string };
export type StreamEvent = AnthropicEvent | OpenAIEvent | DoneEvent | ErrorEvent;

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
  config: Sonnet45Config,
  send: (event: StreamEvent) => void,
): Promise<void> {
  try {
    const userMessage = buildAnthropicUserMessage(text, files);
    messages.push(userMessage);

    const thinkingConfig: Anthropic.ThinkingConfigParam = config.thinking
      ? { type: 'enabled', budget_tokens: Math.max(1024, (config.max_tokens ?? 16384) - 1) }
      : { type: 'disabled' };

    const stream = anthropic.messages.stream({
      model: config.model,
      max_tokens: config.max_tokens ?? 16384,
      messages,
      system: config.system || undefined,
      thinking: thinkingConfig,
    });

    for await (const event of stream) {
      send({ type: 'anthropic', event });
    }

    const assistantMessage = await stream.finalMessage();
    send({ type: 'done', provider: 'anthropic', userMessage, assistantMessage });
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
  config: GPT5Config,
  send: (event: StreamEvent) => void,
): Promise<void> {
  try {
    const userInput = buildOpenAIUserInput(text, files);
    input.push(userInput);

    const stream = await openai.responses.stream({
      model: config.model,
      input,
    });

    for await (const event of stream) {
      send({ type: 'openai', event });
    }

    const assistantMessage = await stream.finalResponse();
    console.dir({ assistantMessage }, { depth: Infinity });
    send({ type: 'done', provider: 'openai', userInput, assistantMessage });
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

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

app.post('/chat', upload.array('files'), async (req, res) => {
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

  if (chat.config.model === 'claude-sonnet-4-5') {
    await streamAnthropicChat(chat.messages as AnthropicHistory, chat.text, files, chat.config, send);
  } else {
    await streamOpenAIChat(chat.messages as OpenAIHistory, chat.text, files, chat.config, send);
  }

  res.end();
});

app.listen(PORT, (error) => {
  if (error) {
    throw error;
  }
  console.log(`Listening at http://localhost:${PORT}`);
});
