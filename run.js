'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const OpenAI = require('openai');

let PORT = 21665; // 'gpt' in base 36

let OPENAI_API_KEY = fs.readFileSync(path.join(__dirname, 'OPENAI_KEY.txt'), 'utf8').trim();

let outdir = path.join(__dirname, 'outputs');
fs.mkdirSync(outdir, { recursive: true });

let openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

let app = express();
app.use(express.json());
app.get('/', function (req, res) {
  res.sendFile(path.join(__dirname, 'index.html'));
});
app.get('/tokenize-bundled.js', function (req, res) {
  res.setHeader('content-type', 'text/javascript');
  res.sendFile(path.join(__dirname, 'tokenize-bundled.js'));
});
app.post('/api', async (req, res) => {
  let { messages } = req.body;
  if (!Array.isArray(messages)) {
    throw new Error('bad request');
  }
  // TODO save log to disk

  res.setHeader('content-type', 'text/plain');
  try {
    const stream = await openai.chat.completions.create({
      model: 'gpt-4-turbo-preview',
      messages,
      stream: true,
    });

    let mess = '';
    for await (const chunk of stream) {
      let tok = chunk.choices[0];
      res.write(JSON.stringify(tok) + '\n');
      if (tok.delta?.content != null) {
        mess += tok.delta.content;
      }
    }
    messages.push({
      role: 'assistant',
      content: mess,
    });
    res.end();
    let name = (new Date).toISOString().replaceAll(':', '.').replaceAll('T', ' ');
    fs.writeFileSync(path.join(outdir, name + '.json'), JSON.stringify(messages), 'utf8');
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
        console.error('An error occurred during OpenAI request: ', message);
      });
    } else {
      console.error('An error occurred during OpenAI request', error);
    }
    throw new Error('failed'); // suppress gross express stack
  }
});

app.listen(PORT);
console.log(`Listening at http://localhost:${PORT}`);
