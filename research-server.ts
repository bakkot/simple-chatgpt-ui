import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import type { GoogleGenAI } from '@google/genai';

import { ALLOWED_USERS } from './run.ts';

interface DeepResearchEvent {
  event_type: string;
  event_id?: string;
  interaction?: { id: string };
  delta?: {
    type: 'text' | 'thought_summary';
    text?: string;
    content?: { text: string };
  };
}

interface QueryState {
  queryId: string;
  user: string;
  prompt: string;
  interactionId: string | null;
  lastEventId: string | null;
  isComplete: boolean;
  events: DeepResearchEvent[];
  createdAt: number;
  listeners: Set<(event: DeepResearchEvent) => void>;
}

let outdir = path.join(import.meta.dirname, 'research-outputs');
fs.mkdirSync(outdir, { recursive: true });

export function addResearchEndpoints(app: Express, google: GoogleGenAI) {
  // In-memory storage for queries
  const queries = new Map<string, QueryState>();

  // Helper to handle streaming and store events
  async function handleStream(user: string, queryId: string, stream: AsyncIterable<any>) {
    const query = queries.get(queryId);
    if (!query) return;

    try {
      for await (const chunk of stream) {
        if (chunk.event_type === 'interaction.start') {
          query.interactionId = chunk.interaction.id;
          console.log(`Query ${queryId}: interaction started with ID ${query.interactionId}`);
        }

        // Store the event
        query.events.push(chunk);
        fs.writeFileSync(path.join(outdir, `${user} - ${new Date(query.createdAt).toISOString().split('T')[0]} - ${query.interactionId}.json`), JSON.stringify(query), 'utf8');

        // Notify all listeners
        for (const listener of query.listeners) {
          listener(chunk);
        }

        if (chunk.event_id) {
          query.lastEventId = chunk.event_id;
        }
        if (chunk.event_type === 'interaction.complete') {
          query.isComplete = true;
        }
      }
    } catch (e) {
      console.error(`Error in stream for query ${queryId}:`, e);
    }
  }

  // Background task to reconnect and continue streaming
  async function continueQuery(user: string, queryId: string) {
    const query = queries.get(queryId);
    if (!query || query.isComplete) return;

    while (!query.isComplete && query.interactionId) {
      console.log(`Reconnecting to interaction ${query.interactionId} from event ${query.lastEventId}...`);
      try {
        const stream = await google.interactions.get(query.interactionId, {
          stream: true,
          last_event_id: query.lastEventId || undefined,
        });
        await handleStream(user, queryId, stream);
      } catch (e) {
        console.log(`Reconnection failed for query ${queryId}, retrying in 2s...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  }

  app.get('/research', function (req, res) {
    res.sendFile(path.join(import.meta.dirname, 'research.html'));
  });

  // Start a new research query
  // This is the only one gated by a user parameter because the others have unguessable IDs in them
  app.post('/api/research/start', async (req, res) => {
    const { user, prompt } = req.body;

    if (!user || !prompt) {
      res.status(400).json({ error: 'Missing user or prompt' });
      return;
    }
    if (!ALLOWED_USERS.includes(user)) {
      res.status(403);
      res.send('unknown user');
      return;
    }

    const queryId = randomUUID();
    const query: QueryState = {
      queryId,
      user,
      prompt,
      interactionId: null,
      lastEventId: null,
      isComplete: false,
      events: [],
      createdAt: Date.now(),
      listeners: new Set(),
    };

    queries.set(queryId, query);

    // Start the interaction in the background
    (async () => {
      try {
        const stream = await google.interactions.create({
          input: prompt,
          agent: 'deep-research-pro-preview-12-2025',
          background: true,
          stream: true,
          agent_config: {
            type: 'deep-research',
            thinking_summaries: 'auto',
          },
        });

        await handleStream(user, queryId, stream);

        // Continue reconnecting if needed
        if (!query.isComplete) {
          continueQuery(user, queryId);
        }
      } catch (e) {
        console.error(`Error starting query ${queryId}:`, e);
        query.isComplete = true;
        query.events.push({
          event_type: 'error',
          delta: {
            type: 'text',
            text: `Error: ${e instanceof Error ? e.message : String(e)}`,
          },
        });
      }
    })();

    res.json({ queryId });
  });

  // Get events for a query, optionally starting from a specific event_id
  app.get('/api/research/events/:queryId', (req, res) => {
    const { queryId } = req.params;
    const { last_event_id } = req.query;

    const query = queries.get(queryId);

    if (!query) {
      res.status(404).json({ error: 'Query not found' });
      return;
    }

    // Find events after the last_event_id
    let events = query.events;
    if (last_event_id) {
      const lastIndex = events.findIndex(e => e.event_id === last_event_id);
      if (lastIndex !== -1) {
        events = events.slice(lastIndex + 1);
      }
    }

    res.json({
      queryId: query.queryId,
      prompt: query.prompt,
      isComplete: query.isComplete,
      events,
      lastEventId: query.lastEventId,
    });
  });

  // SSE endpoint for real-time updates
  app.get('/api/research/stream/:queryId', (req, res) => {
    const { queryId } = req.params;
    const lastEventId = req.query.last_event_id as string | undefined;

    const query = queries.get(queryId);

    if (!query) {
      res.status(404).send('Query not found');
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Send existing events after the specified event_id
    let startIndex = 0;
    if (lastEventId) {
      const lastIndex = query.events.findIndex(e => e.event_id === lastEventId);
      if (lastIndex !== -1) {
        startIndex = lastIndex + 1;
      }
    }

    // Send existing events
    for (let i = startIndex; i < query.events.length; i++) {
      res.write(`data: ${JSON.stringify(query.events[i])}\n\n`);
    }

    // Set up listener for new events
    const listener = (event: DeepResearchEvent) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    query.listeners.add(listener);

    // Check if already complete
    if (query.isComplete) {
      res.write(`data: ${JSON.stringify({ event_type: 'stream.end' })}\n\n`);
      query.listeners.delete(listener);
      res.end();
    }

    req.on('close', () => {
      query.listeners.delete(listener);
    });
  });

  // Get status of all queries for a user
  app.get('/api/research/status/:user', (req, res) => {
    const { user } = req.params;

    const userQueries = Array.from(queries.values())
      .filter(q => q.user === user)
      .map(q => ({
        queryId: q.queryId,
        prompt: q.prompt,
        isComplete: q.isComplete,
        lastEventId: q.lastEventId,
        createdAt: q.createdAt,
      }));

    res.json({ queries: userQueries });
  });

  // Reload interaction from Google API (fallback for early termination)
  app.post('/api/research/reload', async (req, res) => {
    const { interactionId } = req.body;

    if (!interactionId) {
      res.status(400).json({ error: 'Missing interactionId' });
      return;
    }

    try {
      const interaction = await google.interactions.get(interactionId);

      if (interaction.status === 'completed') {

        // Convert interaction outputs to DeepResearchEvent format
        const events: DeepResearchEvent[] = [];

        // Add interaction start event
        events.push({
          event_type: 'interaction.start',
          interaction: { id: interactionId },
        });

        // Process outputs
        for (const item of interaction.outputs ?? []) {
          if (item.type === 'text') {
            events.push({
              event_type: 'content.delta',
              delta: {
                type: 'text',
                text: item.text,
              },
            });
          } else if (item.type === 'thought') {
            // @ts-expect-error types are wrong
            for (const thought of item.summary?.items ?? []) {
              if (thought.type === 'text') {
                events.push({
                  event_type: 'content.delta',
                  delta: {
                    type: 'thought_summary',
                    content: { text: thought.text },
                  },
                });
              }
            }
          }
        }

        // Add completion event
        events.push({
          event_type: 'interaction.complete',
        });

        fs.writeFileSync(path.join(outdir, `${new Date().toISOString().split('T')[0]} - ${interactionId} - completed.json`), JSON.stringify({ events }), 'utf8');

        res.json({
          status: 'completed',
          events,
        });
      } else if (interaction.status === 'failed') {
        // @ts-ignore
        res.json({
          status: 'failed',
          // @ts-ignore
          error: interaction.error,
          events: [],
        });
      } else {
        // Non-completed status, just return the status
        res.json({
          status: interaction.status,
          events: [],
        });
      }
    } catch (e) {
      console.error('Error reloading interaction:', e);
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });
}