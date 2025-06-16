import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI, type Part as GooglePart, type Content as GoogleContent } from '@google/genai';

let PORT = 21665; // 'gpt' in base 36

let OPENAI_API_KEY = fs.readFileSync(path.join(import.meta.dirname, 'OPENAI_KEY.txt'), 'utf8').trim();
let ANTHROPIC_API_KEY = fs.readFileSync(path.join(import.meta.dirname, 'ANTHROPIC_KEY.txt'), 'utf8').trim();
let GOOGLE_API_KEY = fs.readFileSync(path.join(import.meta.dirname, 'GOOGLE_KEY.txt'), 'utf8').trim();

let ALLOWED_USERS = fs.readFileSync(path.join(import.meta.dirname, 'ALLOWED_USERS.txt'), 'utf8').split('\n').map(x => x.trim()).filter(x => x.length > 0);

let outdir = path.join(import.meta.dirname, 'outputs');
fs.mkdirSync(outdir, { recursive: true });

let openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

let anthropic = new Anthropic({
  apiKey: ANTHROPIC_API_KEY,
  defaultHeaders: {
    // @ts-expect-error
    'output-128k-2025-02-19': true,
  }
});

let google = new GoogleGenAI({ apiKey: GOOGLE_API_KEY });


let _fail = (e: any) => { throw new Error(e); };

function anthropicToOpenAIContent(content: Anthropic.ContentBlockParam | string): OpenAI.ChatCompletionContentPart {
  return typeof content === 'string'
    ? { type: 'text', text: content }
    : content.type === 'text'
    ? content
    : content.type === 'image' && content.source.type === 'base64'
    ? {
      type: 'image_url',
      image_url: {
        url: 'data:' + content.source.media_type + ';base64,' + content.source.data,
      }
    }
    : _fail('unknown message ' + JSON.stringify(content));
}

function anthropicToOpenAI(messages: Anthropic.MessageParam[]): OpenAI.ChatCompletionMessageParam[] {
  // we need the cast because OpenAI's types say assistants cannot include images
  // which is true but annoying to type correctly
  return messages.map(m => ({
    role: m.role,
    content: Array.isArray(m.content) ? m.content.map(anthropicToOpenAIContent) : anthropicToOpenAIContent(m.content)
  })) as OpenAI.ChatCompletionMessageParam[];
}

function anthropicToGeminiContent(content: Anthropic.ContentBlockParam | string): GooglePart {
  return typeof content === 'string'
    ? { text: content }
    : content.type === 'text'
    ? { text: content.text }
    : content.type === 'image' && content.source.type === 'base64'
    ? {
        inlineData: {
          data: content.source.data,
          mimeType: content.source.media_type,
        },
      }
    : _fail('unknown message ' + JSON.stringify(content));
}

function anthropicToGemini(messages: Anthropic.MessageParam[]): GoogleContent[] {
  return messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: Array.isArray(m.content) ? m.content.map(anthropicToGeminiContent) : [anthropicToGeminiContent(m.content)]
  }));
}

type StreamArgs = { model: string, systemPrompt: string, messages: Anthropic.MessageParam[]};

async function* openaiStream({ model, systemPrompt, messages }: StreamArgs) {
  const adjusted: OpenAI.ChatCompletionMessageParam[] = model in nonSystem
    ? anthropicToOpenAI(messages)
    : [{ role: 'system', content: systemPrompt }, ...anthropicToOpenAI(messages)];
  const stream = await openai.chat.completions.create({
    model,
    messages: adjusted,
    stream: true,
  });

  for await (const chunk of stream) {
    let tok = chunk.choices[0];
    if (tok.delta?.content != null) {
      yield tok.delta.content;
    }
  }
}

async function* anthropicStream({ model, systemPrompt, messages }: StreamArgs) {
  const stream = anthropic.messages.stream({
    model,
    system: systemPrompt,
    messages,
    // Include the beta header output-128k-2025-02-19 in your API request to increase the maximum output token length to 128k tokens for Claude 3.7 Sonnet.
    // it complains if it's more than 64000 though
    max_tokens: model.includes('opus') ? 32_000 : 64_000,
  });

  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      yield event.delta.text;
    }
  }
}

async function* googleStream({ model, systemPrompt, messages }: StreamArgs) {
  let adjusted = anthropicToGemini(messages);

  const response = await google.models.generateContentStream({
    model,
    contents: adjusted,
    config: {
      systemInstruction: systemPrompt,
    },
  });
  for await (const chunk of response) {
    yield chunk.text!;
  }
}

async function* googleImages({ model, systemPrompt, messages }: StreamArgs) {
  let adjusted = anthropicToGemini(messages);

  const response2 = await google.models.generateContent({
    model: 'gemini-2.0-flash-exp-image-generation',
    contents: adjusted,
    config: {
      responseModalities: ['Text', 'Image']
    },
  });
  for (const part of response2.candidates![0].content!.parts!) {
    // Based on the part type, either show the text or save the image
    if (part.text) {
      yield part.text;
    } else if (part.inlineData) {
      const imageData = part.inlineData.data!;
      yield '!!!@@@!!!' + imageData;
    } else {
      console.log(part);
      throw new Error('idk what that is');
    }
  }
}


let models: Record<string, (args: StreamArgs) => AsyncIterable<string>> = {
  // @ts-expect-error ugh
  __proto__: null,
  'gpt-4-turbo': openaiStream,
  'gpt-4o-mini': openaiStream,
  'gpt-4o': openaiStream,
  'gpt-4.5-preview': openaiStream,
  'chatgpt-4o-latest': openaiStream,
  'o1-mini': openaiStream,
  'o1-preview': openaiStream,
  'o1': openaiStream,
  'o3-mini': openaiStream,
  'o3': openaiStream,
  'o4-mini': openaiStream,
  'gemini-pro': googleStream,
  'gemini-1.5-pro-latest': googleStream,
  'gemini-1.5-flash-latest': googleStream,
  'gemini-2.0-flash-exp': googleStream,
  'gemini-2.0-flash-thinking-exp': googleStream,
  'gemini-2.5-pro-exp-03-25': googleStream,
  'gemini-2.0-flash-exp-image-generation': googleImages,
  'gemini-2.5-pro-preview-03-25': googleStream,
  'gemini-2.5-pro-preview-05-06': googleStream,
  'gemini-2.5-flash-preview-04-17': googleStream,
  'gemini-2.5-flash-preview-05-20': googleStream,
  'claude-3-haiku-20240307': anthropicStream,
  'claude-3-opus-20240229': anthropicStream,
  'claude-3-5-sonnet-latest': anthropicStream,
  'claude-3-7-sonnet-latest': anthropicStream,
  'claude-sonnet-4-20250514': anthropicStream,
  'claude-opus-4-20250514': anthropicStream,
};

let nonStream = {
  __proto__: null,
  // 'o1-mini': true,
  // 'o1-preview': true,
  // 'o1': true,
};

// these don't support system messages
let nonSystem = {
  __proto__: null,
  'o1-mini': true,
  'o1-preview': true,
  'o1': true,
  'o3-mini': true,
};


interface SessionData {
  user: string;
  model: string;
  systemPrompt: string;
  messages: Anthropic.MessageParam[];
  timestamp: number;
}

let activeSessions = new Map<string, SessionData>();

function cleanupOldSessions() {
  let cutoff = Date.now() - 60_000; // 1 minute
  for (let [sessionId, data] of activeSessions) {
    if (data.timestamp < cutoff) {
      activeSessions.delete(sessionId);
    } else {
      // Map is insertion-ordered, so if this one is fresh, all following ones are too
      break;
    }
  }
}

let app = express();
app.use(express.json({ limit: '50mb' }));
app.get('/', function (req, res) {
  res.sendFile(path.join(import.meta.dirname, 'index.html'));
});
app.get('/tokenize-bundled.js', function (req, res) {
  res.setHeader('content-type', 'text/javascript');
  res.sendFile(path.join(import.meta.dirname, 'tokenize-bundled.js'));
});
app.post('/check-user', (req, res) => {
  let { user } = req.body;
  if (ALLOWED_USERS.includes(user)) {
    res.send('ok');
  } else {
    res.send('fail');
  }
});
app.post('/api/start', async (req, res) => {
  let { user, model, systemPrompt, messages } = req.body;
  if (!ALLOWED_USERS.includes(user)) {
    res.status(403);
    res.send('unknown user');
    return;
  }
  if (!Array.isArray(messages)) {
    res.status(400);
    res.send('bad request');
    return;
  }
  if (!(model in models)) {
    res.status(400);
    res.send(`got unknown model ${model}`);
    return;
  }

  cleanupOldSessions();

  let sessionId = Math.random().toString(36).substring(2, 15);
  activeSessions.set(sessionId, { user, model, systemPrompt, messages, timestamp: Date.now() });

  res.json({ sessionId });
});

app.get('/api/stream/:sessionId', async (req, res) => {
  let sessionId = req.params.sessionId;
  let sessionData = activeSessions.get(sessionId);

  if (!sessionData) {
    res.status(404).send('Session not found');
    return;
  }

  activeSessions.delete(sessionId);
  let { user, model, systemPrompt, messages } = sessionData;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    if (model in nonStream) {
      throw new Error('no current non-streaming models');
    } else {
      const stream = models[model]({ model, systemPrompt, messages });

      let mess = '';
      for await (const chunk of stream) {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        mess += chunk;
      }
      messages.push({
        role: 'assistant',
        content: mess,
      });
      res.write(`data: null\n\n`);
      res.end();
    }
    let name = (new Date).toISOString().replaceAll(':', '.').replaceAll('T', ' ');
    fs.writeFileSync(path.join(outdir, name + '.json'), JSON.stringify({ user, model, systemPrompt, messages }), 'utf8');
  } catch (error: any) {
    if (error.response?.status) {
      console.error(error.response.status, error.message);
      error.response.data.on('data', (data: any) => {
        let message = data.toString();
        try {
          message = JSON.parse(message);
        } catch {
          // ignored
        }
        console.error('An error occurred during upstream request: ', message);
      });
    } else {
      console.error('An error occurred during upstream request', error);
    }
    res.write(`data: {"error": ${JSON.stringify(error.message)}}\n\n`);
    res.end();
  }
});

app.listen(PORT);
console.log(`Listening at http://localhost:${PORT}`);
