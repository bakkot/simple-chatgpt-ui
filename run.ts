import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI, type Part as GooglePart, type Content as GoogleContent, HarmBlockThreshold, HarmCategory } from '@google/genai';

let PORT = 21665; // 'gpt' in base 36

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

let OPENAI_API_KEY = readKeyOrEmpty('OPENAI_KEY.txt');
let ANTHROPIC_API_KEY = readKeyOrEmpty('ANTHROPIC_KEY.txt');
let GOOGLE_API_KEY = readKeyOrEmpty('GOOGLE_KEY.txt');
let OPENROUTER_API_KEY = readKeyOrEmpty('OPENROUTER_KEY.txt');

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

let openrouter = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: OPENROUTER_API_KEY,
});


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

function anthropicToOpenAIResponseContent(content: Anthropic.ContentBlockParam | string, isAssistant: false): OpenAI.Responses.ResponseInputContent;
function anthropicToOpenAIResponseContent(content: Anthropic.ContentBlockParam | string, isAssistant: true): OpenAI.Responses.ResponseOutputText;
function anthropicToOpenAIResponseContent(content: Anthropic.ContentBlockParam | string, isAssistant: boolean): OpenAI.Responses.ResponseInputContent | OpenAI.Responses.ResponseOutputText {
  if (typeof content === 'string') content = { type: 'text', text: content };
  if (isAssistant) {
    if (content.type === 'text') {
      return { type: 'output_text', text: content.text, annotations: [] };
    }
    throw new Error('openai responses should be text, got ' + JSON.stringify(content));
  }
  if (content.type === 'text') {
    return { type: 'input_text', text: content.text };
  } else if (content.type === 'image' && content.source.type === 'base64') {
    return {
      type: 'input_image',
      image_url: 'data:' + content.source.media_type + ';base64,' + content.source.data,
      detail: 'auto',
    };
  }
  throw new Error('unknown message ' + JSON.stringify(content));
}

function anthropicToOpenAIResponse(messages: Anthropic.MessageParam[]): OpenAI.Responses.ResponseInputItem[] {
  return messages.map(m => {
    if (m.role === 'assistant') {
      return {
        role: 'assistant',
        content: Array.isArray(m.content)
          ? m.content.map(c => anthropicToOpenAIResponseContent(c, true))
          : [anthropicToOpenAIResponseContent(m.content, true)],
          // we need to use a value which passes format checks but it doesn't appear to matter what it is
        id: 'msg_' + '0'.repeat(48),
      };
    } else {
      return {
        role: 'user',
        content: Array.isArray(m.content)
          ? m.content.map(c => anthropicToOpenAIResponseContent(c, false))
          : [anthropicToOpenAIResponseContent(m.content, false)],
      };
    }
  });
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

async function* openaiResponseStream({ model, systemPrompt, messages }: StreamArgs) {
  const adjusted: OpenAI.Responses.ResponseInputItem[] = [{ role: 'system', content: systemPrompt }, ...anthropicToOpenAIResponse(messages)];
  const stream = await openai.responses.create({
    model,
    input: adjusted,
    stream: true,
    store: false,
  });

  for await (const chunk of stream) {
    // console.dir(chunk, { depth: Infinity });
    switch (chunk.type) {
      case 'response.output_text.delta': {
        yield chunk.delta;
        break;
      }
      default: {
        break;
      }
    }
  }
}

// so we can tell it to actually think
const gpt5Stream = (effort: 'minimal' | 'low' | 'medium' | 'high') => async function* ({ model, systemPrompt, messages }: StreamArgs) {
  if (model.endsWith('-' + effort)) {
    model = model.slice(0, -('-' + effort).length);
  }
  const adjusted: OpenAI.Responses.ResponseInputItem[] = [{ role: 'system', content: systemPrompt }, ...anthropicToOpenAIResponse(messages)];
  const stream = await openai.responses.create({
    model,
    input: adjusted,
    stream: true,
    store: false,
    reasoning: {
      effort,
    },
  });

  for await (const chunk of stream) {
    // console.dir(chunk, { depth: Infinity });
    switch (chunk.type) {
      case 'response.output_text.delta': {
        yield chunk.delta;
        break;
      }
      default: {
        break;
      }
    }
  }
}


let anthropicStreamBase = (thinking: boolean) => async function* anthropicStream({ model, systemPrompt, messages }: StreamArgs) {
  if (thinking && model.endsWith('-thinking')) {
    model = model.slice(0, -'-thinking'.length);
  }
  const stream = anthropic.messages.stream({
    model,
    system: systemPrompt,
    messages,
    thinking: thinking ? {
      type: 'enabled',
      budget_tokens: 10000,
    } : undefined,

    // Include the beta header output-128k-2025-02-19 in your API request to increase the maximum output token length to 128k tokens for Claude 3.7 Sonnet.
    // it complains if it's more than 64000 though
    max_tokens: model.includes('opus') ? 32_000 : 64_000,
  });

  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      yield event.delta.text;
    }
  }
};

let anthropicStream = anthropicStreamBase(false);
let anthropicThinkingStream = anthropicStreamBase(true);



async function* googleStream({ model, systemPrompt, messages }: StreamArgs) {
  let adjusted = anthropicToGemini(messages);

  const response = await google.models.generateContentStream({
    model,
    contents: adjusted,
    config: {
      systemInstruction: systemPrompt,
      // does this do anything? probably not but we might as well try
      safetySettings: [
        {
          category: HarmCategory.HARM_CATEGORY_CIVIC_INTEGRITY,
          threshold: HarmBlockThreshold.OFF,
        },
        {
          category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
          threshold: HarmBlockThreshold.OFF,
        },
        {
          category: HarmCategory.HARM_CATEGORY_HARASSMENT,
          threshold: HarmBlockThreshold.OFF,
        },
        {
          category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
          threshold: HarmBlockThreshold.OFF,
        },
        {
          category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
          threshold: HarmBlockThreshold.OFF,
        },
      ],
    },
  });
  for await (const chunk of response) {
    yield chunk.text!;
  }
}

async function* googleImages({ model, systemPrompt, messages }: StreamArgs) {
  let adjusted = anthropicToGemini(messages);

  const response = await google.models.generateContent({
    model,
    contents: adjusted,
    config: {
      responseModalities: ['Text', 'Image']
    },
  });
  for (const part of response.candidates![0].content!.parts!) {
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

async function* openrouterStream({ model, systemPrompt, messages }: StreamArgs) {
  const adjusted: OpenAI.ChatCompletionMessageParam[] = model in nonSystem
    ? anthropicToOpenAI(messages)
    : [{ role: 'system', content: systemPrompt }, ...anthropicToOpenAI(messages)];
  const stream = await openrouter.chat.completions.create({
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

let models: Record<string, (args: StreamArgs) => AsyncIterable<string>> = {
  // @ts-expect-error ugh
  __proto__: null,
  'gpt-4-turbo': openaiStream,
  'gpt-4o-mini': openaiStream,
  'gpt-4o': openaiStream,
  'gpt-4.5-preview': openaiStream,
  'chatgpt-4o-latest': openaiStream,
  'gpt-5-low': gpt5Stream('low'),
  'gpt-5-high': gpt5Stream('high'),
  'gpt-5-chat-latest': openaiResponseStream,
  'o1-mini': openaiStream,
  'o1-preview': openaiStream,
  'o1': openaiStream,
  'o3-mini': openaiStream,
  'o3': openaiStream,
  'o3-pro': openaiResponseStream,
  'o4-mini': openaiStream,
  'gemini-pro': googleStream,
  'gemini-1.5-pro-latest': googleStream,
  'gemini-1.5-flash-latest': googleStream,
  'gemini-2.0-flash-exp': googleStream,
  'gemini-2.0-flash-thinking-exp': googleStream,
  'gemini-2.5-pro-exp-03-25': googleStream,
  'gemini-2.0-flash-exp-image-generation': googleImages,
  'gemini-2.5-flash-image-preview': googleImages,
  'gemini-2.5-pro-preview-03-25': googleStream,
  'gemini-2.5-pro-preview-05-06': googleStream,
  'gemini-2.5-pro': googleStream,
  'gemini-2.5-flash-preview-04-17': googleStream,
  'gemini-2.5-flash-preview-05-20': googleStream,
  'gemini-2.5-flash': googleStream,
  'gemini-3-pro-image-preview': googleImages,
  'gemini-3-pro-preview': googleStream,
  'claude-3-haiku-20240307': anthropicStream,
  'claude-3-opus-20240229': anthropicStream,
  'claude-3-5-sonnet-latest': anthropicStream,
  'claude-3-7-sonnet-latest': anthropicStream,
  'claude-sonnet-4-20250514': anthropicStream,
  'claude-haiku-4-5-20251001': anthropicStream,
  'claude-sonnet-4-5-20250929': anthropicStream,
  'claude-sonnet-4-5-20250929-thinking': anthropicThinkingStream,
  'claude-opus-4-20250514': anthropicStream,
  'claude-opus-4-1-20250805': anthropicStream,
  'moonshotai/kimi-k2': openrouterStream,
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
        if (chunk) {
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          mess += chunk;
        }
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
