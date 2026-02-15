import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
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

export type SSEEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'done'; message: Message }
  | { type: 'error'; error: string };

async function streamAnthropicChat(
  messages: Message[],
  config: ChatConfig,
  send: (event: SSEEvent) => void,
) {
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

  stream.on('text', (text) => {
    send({ type: 'text_delta', text });
  });

  stream.on('thinking', (thinking) => {
    send({ type: 'thinking_delta', thinking });
  });

  const finalMessage = await stream.finalMessage();

  // Convert ContentBlock[] to ContentBlockParam[] for the assistant message
  const contentParams: Anthropic.ContentBlockParam[] = finalMessage.content.map((block) => {
    switch (block.type) {
      case 'text':
        return { type: 'text' as const, text: block.text };
      case 'thinking':
        return { type: 'thinking' as const, thinking: block.thinking, signature: block.signature };
      case 'redacted_thinking':
        return { type: 'redacted_thinking' as const, data: block.data };
      default:
        return { type: 'text' as const, text: '' };
    }
  });

  const assistantMessage: Message = { role: 'assistant', content: contentParams };
  send({ type: 'done', message: assistantMessage });
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

app.post('/chat', async (req, res) => {
  const { messages, config } = req.body as { messages: Message[]; config: ChatConfig };

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  function send(event: SSEEvent) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  try {
    await streamAnthropicChat(messages, config, send);
  } catch (err: any) {
    send({ type: 'error', error: err.message ?? String(err) });
  }

  res.end();
});

app.listen(PORT, (error) => {
  if (error) {
    throw error;
  }
  console.log(`Listening at http://localhost:${PORT}`);
});
