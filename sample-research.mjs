import fs from 'node:fs';
import path from 'node:path';

import { GoogleGenAI } from '@google/genai';

let GOOGLE_API_KEY = readKeyOrEmpty('GOOGLE_KEY.txt');
function readKeyOrEmpty(name) {
  try {
    return fs.readFileSync(path.join(import.meta.dirname, name), 'utf8').trim();
  } catch (e) {
    if (e.code === 'ENOENT') {
      return '';
    }
    throw e;
  }
}

let google = new GoogleGenAI({ apiKey: GOOGLE_API_KEY });

let lastEventId;
let interactionId;
let isComplete = false;

// Helper to handle the event logic
const handleStream = async stream => {
  for await (const chunk of stream) {
    if (chunk.event_type === 'interaction.start') {
      interactionId = chunk.interaction.id;
      console.log({ interactionId });
    }
    if (chunk.event_id) lastEventId = chunk.event_id;

    if (chunk.event_type === 'content.delta') {
      if (chunk.delta.type === 'text') {
        process.stdout.write(chunk.delta.text);
      } else if (chunk.delta.type === 'thought_summary') {
        console.log(`Thought: ${chunk.delta.content.text}`);
      }
    } else if (chunk.event_type === 'interaction.complete') {
      isComplete = true;
    }
  }
};

// 1. Start the task with streaming
try {
  const stream = await google.interactions.create({
    input: 'Briefly summarize history of Italian food in San Francisco.',
    agent: 'deep-research-pro-preview-12-2025',
    background: true,
    stream: true,
    agent_config: {
      type: 'deep-research',
      thinking_summaries: 'auto',
    },
  });
  await handleStream(stream);
} catch (e) {
  console.log('\nInitial stream interrupted.');
}

// 2. Reconnect Loop
while (!isComplete && interactionId) {
  console.log(`\nReconnecting to interaction ${interactionId} from event ${lastEventId}...`);
  try {
    const stream = await google.interactions.get(interactionId, {
      stream: true,
      last_event_id: lastEventId,
    });
    await handleStream(stream);
  } catch (e) {
    console.log('Reconnection failed, retrying in 2s...');
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}

const interaction = await google.interactions.get(interactionId);
console.log(`Status: ${interaction.status}`);
if (interaction.status === 'completed') {
  console.log('\nFinal Report:\n', interaction.outputs.at(-1).text);
} else if (['failed', 'cancelled'].includes(interaction.status)) {
  console.log(`Failed with status: ${interaction.status}`);
}
