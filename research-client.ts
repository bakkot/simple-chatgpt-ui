// @ts-ignore
import { marked } from "https://cdn.jsdelivr.net/npm/marked/lib/marked.esm.js";

// Types
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

interface Query {
  queryId: string;
  prompt: string;
  response: string;
  thoughts: string[];
  isComplete: boolean;
  lastEventId: string | null;
  interactionId: string | null;
}

interface LocalStorage {
  queries: Record<string, Query>;
}

// State
let user: string;
let queries: Record<string, Query> = {};
let currentQueryId: string | null = null;
let activeStreams: Record<string, EventSource> = {};

// DOM elements
const queryList = document.getElementById('query-list')!;
const messagesContainer = document.getElementById('messages')!;
const inputElement = document.getElementById('input') as HTMLTextAreaElement;
const sendButton = document.getElementById('send-button')!;

// Initialize
function initialize() {
  let savedUser = localStorage.getItem('chatgpt-ui-user');
  if (savedUser) {
    user = savedUser;
  } else {
    if (location.pathname === '/') {
      alert('no saved user found, this will not work');
      user = 'NO USER';
    } else {
      // assume the normal UI has user handling
      alert('no saved user found, redirecting...');
      // @ts-expect-error TS is bad
      location = '..';
    }
  }

  const stored = localStorage.getItem('deep-research-state');
  if (stored) {
    try {
      const data: LocalStorage = JSON.parse(stored);
      queries = data.queries || {};
    } catch (e) {
      console.error('Failed to parse stored data:', e);
    }
  }

  // Render sidebar
  renderQueryList();

  // Check for running queries on the server
  reconnectToRunningQueries();

  // Set up input handlers
  inputElement.addEventListener('input', fixupTextboxSize);
  inputElement.addEventListener('keydown', (e) => {
    if (e.code === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      submitQuery();
    }
  });
  sendButton.addEventListener('click', submitQuery);
}

function saveState() {
  const data: LocalStorage = {
    queries,
  };
  localStorage.setItem('deep-research-state', JSON.stringify(data));
}

function fixupTextboxSize() {
  const parent = inputElement.parentNode as HTMLElement;
  parent.dataset.replicatedValue = inputElement.value;
}

async function submitQuery() {
  const prompt = inputElement.value.trim();
  if (!prompt) return;

  inputElement.value = '';
  fixupTextboxSize();

  try {
    const response = await fetch('/api/research/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user, prompt }),
    });

    if (!response.ok) {
      throw new Error('Failed to start query');
    }

    const { queryId } = await response.json();

    // Create query object
    queries[queryId] = {
      queryId,
      prompt,
      response: '',
      thoughts: [],
      isComplete: false,
      lastEventId: null,
      interactionId: null,
    };

    saveState();
    renderQueryList();
    selectQuery(queryId);
    connectToQuery(queryId);
  } catch (e) {
    console.error('Error submitting query:', e);
    alert('Failed to submit query');
  }
}

function renderQueryList() {
  queryList.innerHTML = '';

  const sortedQueries = Object.values(queries).sort((a, b) => {
    // Running queries first, then by order added
    if (a.isComplete !== b.isComplete) {
      return a.isComplete ? 1 : -1;
    }
    return 0;
  });

  for (const query of sortedQueries) {
    const item = document.createElement('div');
    item.className = 'query-item';
    if (query.queryId === currentQueryId) {
      item.className += ' selected';
    }

    const status = document.createElement('span');
    status.className = `query-status ${query.isComplete ? 'finished' : 'running'}`;
    status.textContent = query.isComplete ? 'Done' : 'Running';

    const text = document.createElement('span');
    text.className = 'query-text';
    text.textContent = query.prompt;

    item.appendChild(status);
    item.appendChild(text);
    item.addEventListener('click', () => selectQuery(query.queryId));

    queryList.appendChild(item);
  }
}

function selectQuery(queryId: string) {
  currentQueryId = queryId;
  renderQueryList();
  renderMessages();
}

function renderMessages() {
  if (!currentQueryId) {
    messagesContainer.innerHTML = '<div class="empty-state">Enter a query below to start</div>';
    return;
  }

  const query = queries[currentQueryId];
  if (!query) return;

  messagesContainer.innerHTML = '';

  // User message
  const userContainer = document.createElement('div');
  userContainer.className = 'message-container';

  const userLabel = document.createElement('div');
  userLabel.className = 'message-label';
  userLabel.textContent = 'Your Query';

  const userMessage = document.createElement('div');
  userMessage.className = 'user-message';
  userMessage.textContent = query.prompt;

  userContainer.appendChild(userLabel);
  userContainer.appendChild(userMessage);
  messagesContainer.appendChild(userContainer);

  // Bot response
  const botContainer = document.createElement('div');
  botContainer.className = 'message-container';

  const botLabel = document.createElement('div');
  botLabel.className = 'message-label';
  botLabel.textContent = query.isComplete ? 'Response' : 'Response (in progress...)';

  const botMessage = document.createElement('div');
  botMessage.className = 'bot-message';

  // Add thoughts
  for (const thought of query.thoughts) {
    const thoughtDiv = document.createElement('div');
    thoughtDiv.className = 'thought-summary';
    thoughtDiv.textContent = `💭 ${thought}`;
    botMessage.appendChild(thoughtDiv);
  }

  // Add response text
  const responseDiv = document.createElement('div');
  responseDiv.className = 'message-content';
  // yolo
  responseDiv.innerHTML = query.response ? marked.parse(query.response) : (query.isComplete ? 'No response received' : 'Thinking...');
  botMessage.appendChild(responseDiv);

  // Add reload button if complete but empty/whitespace response
  if (query.isComplete && (!query.response || query.response.trim() === '') && query.interactionId) {
    const reloadButton = document.createElement('button');
    reloadButton.textContent = 'Reload from API';
    reloadButton.style.marginTop = '1rem';
    reloadButton.style.padding = '0.5rem 1rem';
    reloadButton.style.cursor = 'pointer';
    reloadButton.addEventListener('click', () => reloadQuery(query.queryId));
    botMessage.appendChild(reloadButton);
  }

  botContainer.appendChild(botLabel);
  botContainer.appendChild(botMessage);
  messagesContainer.appendChild(botContainer);

  // Scroll to bottom
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function connectToQuery(queryId: string) {
  if (activeStreams[queryId]) {
    return; // Already connected
  }

  const query = queries[queryId];
  if (!query || query.isComplete) {
    return;
  }

  const lastEventId = query.lastEventId || '';
  const url = `/api/research/stream/${queryId}?last_event_id=${encodeURIComponent(lastEventId)}`;

  const eventSource = new EventSource(url);
  activeStreams[queryId] = eventSource;

  eventSource.onmessage = (event) => {
    try {
      const data: DeepResearchEvent = JSON.parse(event.data);

      if (data.event_type === 'stream.end') {
        eventSource.close();
        delete activeStreams[queryId];
        return;
      }

      handleEvent(queryId, data);
    } catch (e) {
      console.error('Error parsing event:', e);
    }
  };

  eventSource.onerror = () => {
    console.error('SSE error for query', queryId);
    eventSource.close();
    delete activeStreams[queryId];

    // Try to reconnect after a delay if not complete
    if (!query.isComplete) {
      setTimeout(() => connectToQuery(queryId), 2000);
    }
  };
}

function handleEvent(queryId: string, event: DeepResearchEvent) {
  const query = queries[queryId];
  if (!query) return;

  if (event.event_id) {
    query.lastEventId = event.event_id;
  }

  if (event.event_type === 'interaction.start') {
    query.interactionId = event.interaction?.id || null;
  } else if (event.event_type === 'content.delta') {
    if (event.delta?.type === 'text') {
      query.response += event.delta.text || '';
    } else if (event.delta?.type === 'thought_summary') {
      const thought = event.delta.content?.text || '';
      query.thoughts.push(thought);
    }
  } else if (event.event_type === 'interaction.complete') {
    query.isComplete = true;
    if (activeStreams[queryId]) {
      activeStreams[queryId].close();
      delete activeStreams[queryId];
    }
  }

  saveState();

  // Update UI if this is the current query
  if (currentQueryId === queryId) {
    renderMessages();
  }

  // Update sidebar status
  renderQueryList();
}

async function reconnectToRunningQueries() {
  try {
    const response = await fetch(`/api/research/status/${user}`);
    if (!response.ok) {
      console.error('Failed to fetch query status');
      return;
    }

    const { queries: serverQueries } = await response.json();

    for (const serverQuery of serverQueries) {
      const localQuery = queries[serverQuery.queryId];

      if (!localQuery) {
        // Query exists on server but not locally - fetch its events
        const eventsResponse = await fetch(`/api/research/events/${serverQuery.queryId}`);
        if (eventsResponse.ok) {
          const eventsData = await eventsResponse.json();

          queries[serverQuery.queryId] = {
            queryId: serverQuery.queryId,
            prompt: eventsData.prompt,
            response: '',
            thoughts: [],
            isComplete: eventsData.isComplete,
            lastEventId: eventsData.lastEventId,
            interactionId: null,
          };

          // Process all events
          for (const event of eventsData.events) {
            handleEvent(serverQuery.queryId, event);
          }
        }
      } else if (!localQuery.isComplete && serverQuery.isComplete) {
        // Server has completed but local hasn't - sync up
        const eventsResponse = await fetch(
          `/api/research/events/${serverQuery.queryId}?last_event_id=${encodeURIComponent(localQuery.lastEventId || '')}`
        );
        if (eventsResponse.ok) {
          const eventsData = await eventsResponse.json();
          for (const event of eventsData.events) {
            handleEvent(serverQuery.queryId, event);
          }
        }
      }

      // Connect to running queries
      if (!serverQuery.isComplete) {
        connectToQuery(serverQuery.queryId);
      }
    }

    // Check for queries that don't exist on server anymore
    for (const queryId in queries) {
      const query = queries[queryId];
      if (!query.isComplete && !serverQueries.find((q: any) => q.queryId === queryId)) {
        // Query doesn't exist on server - mark as complete with error
        query.isComplete = true;
        query.response += '\n\n[Error: Server does not recognize this query. It may have been lost due to a server restart.]';
      }
    }

    saveState();
    renderQueryList();
    if (currentQueryId) {
      renderMessages();
    }
  } catch (e) {
    console.error('Error reconnecting to queries:', e);
  }
}

async function reloadQuery(queryId: string) {
  const query = queries[queryId];
  if (!query || !query.interactionId) {
    alert('Cannot reload: missing interaction ID');
    return;
  }

  try {
    const response = await fetch('/api/research/reload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interactionId: query.interactionId }),
    });

    if (!response.ok) {
      throw new Error('Failed to reload interaction');
    }

    const data = await response.json();

    if (data.status === 'completed' && data.events) {
      // Clear existing state and replay events
      query.response = '';
      query.thoughts = [];
      query.isComplete = false;

      for (const event of data.events) {
        handleEvent(queryId, event);
      }

      saveState();
      renderMessages();
    } else {
      // Non-completed status
      alert(`Interaction status: ${data.status}. Click reload again to retry.`);
    }
  } catch (e) {
    console.error('Error reloading query:', e);
    alert('Failed to reload interaction');
  }
}

// Start the app
initialize();
