'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const OpenAI = require('openai');

let PORT = 21665; // 'gpt' in base 36

let OPENAI_API_KEY = fs.readFileSync(path.join(__dirname, 'OPENAI_KEY.txt'), 'utf8').trim();

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
  let { messages, max_tokens } = req.body;
  if (!Array.isArray(messages) || typeof max_tokens !== 'number') {
    throw new Error('bad request');
  }
  // TODO save log to disk

  res.setHeader('content-type', 'text/plain');
  try {
    const stream = await openai.chat.completions.create({
      model: 'gpt-4-1106-preview',
      messages,
      stream: true,
    });

    for await (const chunk of stream) {
      res.write(JSON.stringify(chunk.choices[0]) + '\n');
      console.log(chunk.choices[0]);
    }
    res.end();
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
