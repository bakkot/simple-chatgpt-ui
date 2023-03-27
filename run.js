'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const { Configuration, OpenAIApi } = require('openai');

let PORT = 21665; // 'gpt' in base 36

let OPENAI_API_KEY = fs.readFileSync(path.join(__dirname, 'OPENAI_KEY.txt'), 'utf8').trim();

let configuration = new Configuration({
  apiKey: OPENAI_API_KEY,
});
let openai = new OpenAIApi(configuration);

let app = express();
app.use(express.json());
app.get('/', function (req, res) {
  res.sendFile(path.join(__dirname, 'index.html'));
});
app.post('/api', async (req, res) => {
  let { messages, max_tokens } = req.body;
  if (!Array.isArray(messages) || typeof max_tokens !== 'number') {
    throw new Error('bad request');
  }
  // TODO save log to disk

  // streaming per https://github.com/openai/openai-node/issues/18#issuecomment-1369996933
  res.setHeader('content-type', 'text/plain');
  try {
    const completion = await openai.createChatCompletion(
      {
        model: 'gpt-4',
        messages,
        max_tokens,
        stream: true,
      },
      { responseType: 'stream' },
    );

    completion.data.on('data', data => {
      const lines = data
        .toString()
        .split('\n')
        .filter(line => line.trim() !== '');
      for (const line of lines) {
        const message = line.replace(/^data: /, '');
        if (message === '[DONE]') {
          res.end();
          return;
        }
        const parsed = JSON.parse(message);
        res.write(JSON.stringify(parsed.choices[0]) + '\n');
        console.log(parsed.choices[0]);
      }
    });
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
    throw error;
  }
});

app.listen(PORT);
console.log(`Listening at http://localhost:${PORT}`);
