import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import Anthropic from '@anthropic-ai/sdk';
import { stripTypeScriptTypes } from 'node:module';

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

const ALLOWED_USERS = fs.readFileSync(path.join(import.meta.dirname, 'ALLOWED_USERS.txt'), 'utf8').split('\n').map(x => x.trim()).filter(x => x.length > 0);

const anthropic = new Anthropic({
  apiKey: ANTHROPIC_API_KEY,
});

export type Message = Anthropic.MessageParam;

export type ChatConfig = {
  model: string;
  system?: string;
  thinking?: boolean;
  max_tokens?: number;
};

export type DoneEvent = { type: 'done'; userMessage: Message; assistantMessage: Message };
export type ErrorEvent = { type: 'error'; error: string };

function contentBlockToParam(block: Anthropic.ContentBlock): Anthropic.ContentBlockParam {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'thinking':
      return { type: 'thinking', thinking: block.thinking, signature: block.signature };
    case 'redacted_thinking':
      return { type: 'redacted_thinking', data: block.data };
    default:
      return { type: 'text', text: '' };
  }
}

async function streamAnthropicChat(
  messages: Message[],
  config: ChatConfig,
  sendRaw: (json: string) => void,
): Promise<Message> {
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
    sendRaw(JSON.stringify(event));
  }

  const finalMessage = await stream.finalMessage();
  const content = finalMessage.content.map(contentBlockToParam);
  return { role: 'assistant', content };
}

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

function buildUserMessage(text: string, files: Express.Multer.File[]): Message {
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

app.post('/chat', upload.array('files'), async (req, res) => {
  const messages: Message[] = JSON.parse(req.body.messages);
  const config: ChatConfig = JSON.parse(req.body.config);
  const text: string = req.body.text || '';
  const files = (req.files as Express.Multer.File[]) || [];

  const userMessage = buildUserMessage(text, files);
  messages.push(userMessage);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  function sendRaw(json: string) {
    res.write(`data: ${json}\n\n`);
  }

  try {
    const assistantMessage = await streamAnthropicChat(messages, config, sendRaw);
    const done: DoneEvent = { type: 'done', userMessage, assistantMessage };
    sendRaw(JSON.stringify(done));
  } catch (err: any) {
    const error: ErrorEvent = { type: 'error', error: err.message ?? String(err) };
    sendRaw(JSON.stringify(error));
  }

  res.end();
});

app.listen(PORT, (error) => {
  if (error) {
    throw error;
  }
  console.log(`Listening at http://localhost:${PORT}`);
});
