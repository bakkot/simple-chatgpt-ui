'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const OpenAI = require('openai');
const Anthropic = require('@anthropic-ai/sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');

let PORT = 21665; // 'gpt' in base 36

let OPENAI_API_KEY = fs.readFileSync(path.join(__dirname, 'OPENAI_KEY.txt'), 'utf8').trim();
let ANTHROPIC_API_KEY = fs.readFileSync(path.join(__dirname, 'ANTHROPIC_KEY.txt'), 'utf8').trim();
let GOOGLE_API_KEY = fs.readFileSync(path.join(__dirname, 'GOOGLE_KEY.txt'), 'utf8').trim();

let ALLOWED_USERS = fs.readFileSync(path.join(__dirname, 'ALLOWED_USERS.txt'), 'utf8').split('\n').map(x => x.trim()).filter(x => x.length > 0);

let outdir = path.join(__dirname, 'outputs');
fs.mkdirSync(outdir, { recursive: true });

let openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

let anthropic = new Anthropic({
  apiKey: ANTHROPIC_API_KEY,
});

let google = (new GoogleGenerativeAI(GOOGLE_API_KEY));


let _fail = e => { throw new Error(e); };

function anthropicToOpenAIContent(content) {
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

function anthropicToOpenAI(messages) {
  return messages.map(m => ({
    role: m.role,
    content: Array.isArray(m.content) ? m.content.map(anthropicToOpenAIContent) : anthropicToOpenAIContent(m.content)
  }));
}

function anthropicToGemini(messages) {
  return messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts:
      Array.isArray(m.content)
        ? m.content.length === 1 && m.content[0].type === 'text'
          ? [{ text: m.content[0].text }]
          : _fail('message is too complicated for google ' + JSON.stringify(m))
        : [{ text: m.content }],
  }));
}

async function* openaiStream({ model, systemPrompt, messages }) {
  const stream = await openai.chat.completions.create({
    model,
    messages: [{ role: 'system', content: systemPrompt }, ...anthropicToOpenAI(messages)],
    stream: true,
  });

  for await (const chunk of stream) {
    let tok = chunk.choices[0];
    if (tok.delta?.content != null) {
      yield tok.delta.content;
    }
  }
}

async function openaiO1({ model, messages }) {
  const response = await openai.chat.completions.create({
    model,
    messages,
  });
  return response.choices[0].message.content;
}

async function* anthropicStream({ model, systemPrompt, messages }) {
  const stream = anthropic.messages.stream({
    model,
    system: systemPrompt,
    messages,
    max_tokens: 4096,
  });

  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      yield event.delta.text;
    }
  }
}

async function* googleStream({ model, systemPrompt, messages }) {
  let mgr = google.getGenerativeModel({ model });

  // gemini does not support system prompts

  messages = anthropicToGemini(messages);
  let last = messages.pop().parts[0].text;
  const chat = mgr.startChat({ history: messages });
  let result = await chat.sendMessageStream(last);
  for await (const chunk of result.stream) {
    yield chunk.text();
  }
}


let models = {
  __proto__: null,
  'gpt-4-turbo': openaiStream,
  'gpt-4o-mini': openaiStream,
  'gpt-4o': openaiStream,
  'o1-mini': openaiO1,
  'o1-preview': openaiO1,
  'gemini-pro': googleStream,
  'gemini-1.5-pro-latest': googleStream,
  'gemini-1.5-flash-latest': googleStream,
  'claude-3-haiku-20240307': anthropicStream,
  'claude-3-opus-20240229': anthropicStream,
  'claude-3-sonnet-20240229': anthropicStream,
  'claude-3-5-sonnet-20240620': anthropicStream,
};

let nonStream = {
  __proto__: null,
  'o1-mini': true,
  'o1-preview': true,
};


let app = express();
app.use(express.json({ limit: '50mb' }));
app.get('/', function (req, res) {
  res.sendFile(path.join(__dirname, 'index.html'));
});
app.get('/tokenize-bundled.js', function (req, res) {
  res.setHeader('content-type', 'text/javascript');
  res.sendFile(path.join(__dirname, 'tokenize-bundled.js'));
});
app.post('/check-user', (req, res) => {
  let { user } = req.body;
  if (ALLOWED_USERS.includes(user)) {
    res.send('ok');
  } else {
    res.send('fail');
  }
});
app.post('/api', async (req, res) => {
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

  res.setHeader('content-type', 'text/plain');
  try {
    if (model in nonStream) {
      const message = await models[model]({ model, systemPrompt, messages });
      res.write(JSON.stringify(message) + '\n');
      messages.push({
        role: 'assistant',
        content: message,
      });
      res.end();
    } else {
      const stream = models[model]({ model, systemPrompt, messages });

      let mess = '';
      for await (const chunk of stream) {
        res.write(JSON.stringify(chunk) + '\n');
        mess += chunk;
      }
      messages.push({
        role: 'assistant',
        content: mess,
      });
      res.end();
    }
    let name = (new Date).toISOString().replaceAll(':', '.').replaceAll('T', ' ');
    fs.writeFileSync(path.join(outdir, name + '.json'), JSON.stringify({ user, model, systemPrompt, messages }), 'utf8');
  } catch (error) {
    if (error.response?.status) {
      console.error(error.response.status, error.message);
      error.response.data.on('data', data => {
        const message = data.toString();
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
    throw new Error('failed'); // suppress gross express stack
  }
});

app.listen(PORT);
console.log(`Listening at http://localhost:${PORT}`);
