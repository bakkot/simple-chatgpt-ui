import type {
  AnthropicHistory, AnthropicMessageParam,
  OpenAIHistory, OpenAIInputItem, OpenAIResponse,
  GoogleContent, GoogleHistory, GroundingMetadata,
  Sonnet45Config, Opus46Config, GPT52Config, Gemini3FlashConfig, Gemini3ProConfig, ChatConfig, ChatRequest, StreamEvent, ReasoningEffort,
} from './run.ts';

const messagesDiv = document.getElementById('messages')!;
const textarea = document.getElementById('message') as HTMLTextAreaElement;
const sendBtn = document.getElementById('send') as HTMLButtonElement;
const filesInput = document.getElementById('files') as HTMLInputElement;
const modelConfigDiv = document.getElementById('model-config')!;
const modelRadios = document.querySelectorAll<HTMLInputElement>('input[name="model"]');
const attachLink = document.getElementById('attach')!;
const attachContainer = document.getElementById('attach-container')!;
const unattachLink = document.getElementById('unattach')!;
const historyButton = document.getElementById('history-button')!;
const historyDialog = document.getElementById('history-dialog') as HTMLDialogElement;
const historyList = document.getElementById('history-list')!;
const historyDialogClose = document.getElementById('history-dialog-close')!;
const confirmDialog = document.getElementById('confirm-dialog') as HTMLDialogElement;
const confirmDialogMessage = document.getElementById('confirm-dialog-message')!;
const confirmDialogCancel = document.getElementById('confirm-dialog-cancel')!;
const confirmDialogOk = document.getElementById('confirm-dialog-ok')!;

// --- Conversation history persistence ---

type ConversationMeta = {
  id: string;
  config: ChatConfig;
  history: AnthropicHistory | OpenAIHistory | GoogleHistory;
  container?: string;
  updatedAt: number;
  bookmarked: boolean;
  preview: string;
};

type Conversation = ConversationMeta & {
  turns: StreamEvent[][];
};

type TurnRecord = {
  conversationId: string;
  turnIndex: number;
  events: StreamEvent[];
};

function generateId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

// Turns are stored separately from conversation metadata so that appending a
// new turn after streaming is a single put() — no need to read-modify-write the
// entire conversation. This also keeps the conversations store lightweight for
// the history dialog (no need to load potentially large event arrays with
// embedded base64 images just to list conversations).
const DB_NAME = 'chatbot-history';
const DB_VERSION = 1;
let dbConnection: IDBDatabase | undefined;

function openDB(): Promise<IDBDatabase> {
  if (dbConnection) return Promise.resolve(dbConnection);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('conversations')) {
        db.createObjectStore('conversations', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('turns')) {
        const turns = db.createObjectStore('turns', { keyPath: ['conversationId', 'turnIndex'] });
        turns.createIndex('conversationId', 'conversationId');
      }
    };
    req.onsuccess = () => { dbConnection = req.result; resolve(req.result); };
    req.onerror = () => reject(req.error);
  });
}

const currentConversation: Conversation = {
  id: generateId(),
  config: undefined as unknown as ChatConfig, // set on first turn
  history: [],
  turns: [],
  bookmarked: false,
  updatedAt: 0,
  preview: '',
};

async function loadConversations(): Promise<ConversationMeta[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('conversations', 'readonly');
    const req = tx.objectStore('conversations').getAll();
    req.onsuccess = () => resolve(req.result as ConversationMeta[]);
    req.onerror = () => reject(req.error);
  });
}

async function saveCurrentConversation(turnEvents?: StreamEvent[]): Promise<void> {
  currentConversation.updatedAt = Date.now();
  if (turnEvents && currentConversation.turns.length === 1 && !currentConversation.preview) {
    currentConversation.preview = extractUserText(turnEvents);
  }
  const db = await openDB();
  const tx = db.transaction(['conversations', 'turns'], 'readwrite');
  const { turns: _, ...meta } = currentConversation;
  tx.objectStore('conversations').put(meta);
  if (turnEvents) {
    const turnRecord: TurnRecord = {
      conversationId: currentConversation.id,
      turnIndex: currentConversation.turns.length - 1,
      events: turnEvents,
    };
    tx.objectStore('turns').put(turnRecord);
  }
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function saveConversation(conv: ConversationMeta): Promise<void> {
  const db = await openDB();
  const tx = db.transaction('conversations', 'readwrite');
  tx.objectStore('conversations').put(conv);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function deleteConversation(id: string): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(['conversations', 'turns'], 'readwrite');
  tx.objectStore('conversations').delete(id);
  const turnsIndex = tx.objectStore('turns').index('conversationId');
  const cursorReq = turnsIndex.openKeyCursor(IDBKeyRange.only(id));
  cursorReq.onsuccess = () => {
    const cursor = cursorReq.result;
    if (cursor) {
      tx.objectStore('turns').delete(cursor.primaryKey);
      cursor.continue();
    }
  };
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function loadConversation(id: string): Promise<Conversation> {
  const db = await openDB();
  const tx = db.transaction(['conversations', 'turns'], 'readonly');
  const metaReq = tx.objectStore('conversations').get(id);
  const turnsReq = tx.objectStore('turns').index('conversationId').getAll(id);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => {
      const meta = metaReq.result as ConversationMeta | undefined;
      if (!meta) { reject(new Error(`conversation ${id} not found`)); return; }
      const turnRecords = (turnsReq.result as TurnRecord[]).sort((a, b) => a.turnIndex - b.turnIndex);
      resolve({ ...meta, turns: turnRecords.map(t => t.events) });
    };
    tx.onerror = () => reject(tx.error);
  });
}

// --- Per-provider conversation history ---
let anthropicHistory: AnthropicHistory = [];
let anthropicContainer: string | undefined;
let openaiHistory: OpenAIHistory = [];
let openaiContainer: string | undefined;
let googleHistory: GoogleHistory = [];
let hasSentMessage = false;
let pendingFiles: File[] = [];

function getSelectedModel(): ChatConfig['model'] {
  const checked = document.querySelector<HTMLInputElement>('input[name="model"]:checked');
  return (checked?.value ?? 'claude-sonnet-4-5') as ChatConfig['model'];
}

function getChatRequest(text: string): ChatRequest {
  saveModelConfig();
  const model = getSelectedModel();
  switch (model) {
    case 'claude-sonnet-4-5':
    case 'claude-opus-4-6': {
      return {
        messages: anthropicHistory,
        config: { model, ...configState[model], container: anthropicContainer },
        text,
      } as ChatRequest;
    }
    case 'gpt-5.2': {
      return {
        messages: openaiHistory,
        config: { model, ...configState[model], container: openaiContainer },
        text,
      };
    }
    case 'gemini-3-flash-preview': {
      return {
        messages: googleHistory,
        config: { model },
        text,
      };
    }
    case 'gemini-3-pro-preview': {
      return {
        messages: googleHistory,
        config: { model, ...configState[model] },
        text,
      };
    }
    default: {
      model satisfies never; // assert switch exhaustiveness
      throw new Error(`unknown model ${model}`);
    }
  }
}

// --- Model config UI ---
const configState: { [K in ChatConfig['model']]: Omit<Extract<ChatConfig, { model: K }>, 'model'> } = {
  'claude-sonnet-4-5': { thinking: true, max_tokens: 16384, web_search: false, web_search_max_uses: 10, code_execution: false },
  'claude-opus-4-6': { thinking: true, web_search: false, web_search_max_uses: 10, code_execution: false },
  'gpt-5.2': { web_search: false, image_generation: false, code_interpreter: false, reasoning_effort: 'none' as const },
  'gemini-3-flash-preview': { google_search: false, code_execution: false },
  'gemini-3-pro-preview': { image_generation: false, google_search: false, code_execution: false },
};

type SavedState = { model: ChatConfig['model']; config: typeof configState };
const STORAGE_KEY = 'chatbot-config';

function loadSavedState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const saved: SavedState = JSON.parse(raw);
    // Restore per-model config
    for (const key of Object.keys(configState) as ChatConfig['model'][]) {
      if (saved.config[key]) {
        Object.assign(configState[key], saved.config[key]);
      }
    }
    // Restore selected model
    const radio = document.querySelector<HTMLInputElement>(`input[name="model"][value="${saved.model}"]`);
    if (radio) radio.checked = true;
  } catch {}
}

function persistState() {
  const saved: SavedState = { model: getSelectedModel(), config: configState };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
}

loadSavedState();
let currentModel: ChatConfig['model'] = getSelectedModel();

function saveModelConfig() {
  if (currentModel === 'claude-sonnet-4-5' || currentModel === 'claude-opus-4-6') {
    const cb = document.getElementById('anthropic-thinking') as HTMLInputElement | null;
    if (cb) configState[currentModel].thinking = cb.checked;
    const ce = document.getElementById('anthropic-code-execution') as HTMLInputElement | null;
    if (ce) configState[currentModel].code_execution = ce.checked;
  }
  if (currentModel === 'claude-sonnet-4-5' || currentModel === 'claude-opus-4-6' || currentModel === 'gpt-5.2') {
    const ws = document.getElementById('config-web-search') as HTMLInputElement | null;
    if (ws) configState[currentModel].web_search = ws.checked;
  }
  if (currentModel === 'gpt-5.2') {
    const ig = document.getElementById('config-image-generation') as HTMLInputElement | null;
    if (ig) configState[currentModel].image_generation = ig.checked;
    const ci = document.getElementById('config-code-interpreter') as HTMLInputElement | null;
    if (ci) configState[currentModel].code_interpreter = ci.checked;
    const re = document.getElementById('config-reasoning-effort') as HTMLSelectElement | null;
    if (re) configState[currentModel].reasoning_effort = re.value as ReasoningEffort;
  }
  if (currentModel === 'gemini-3-pro-preview') {
    const ig = document.getElementById('config-image-generation') as HTMLInputElement | null;
    if (ig) configState[currentModel].image_generation = ig.checked;
  }
  if (currentModel === 'gemini-3-flash-preview' || currentModel === 'gemini-3-pro-preview') {
    const gs = document.getElementById('config-google-search') as HTMLInputElement | null;
    if (gs) configState[currentModel].google_search = gs.checked;
    const ce = document.getElementById('config-code-execution') as HTMLInputElement | null;
    if (ce) configState[currentModel].code_execution = ce.checked;
  }
  persistState();
}

function renderModelConfig() {
  saveModelConfig();
  const model = getSelectedModel();
  currentModel = model;
  if (model === 'claude-sonnet-4-5' || model === 'claude-opus-4-6') {
    const config = configState[model];
    modelConfigDiv.innerHTML =
      `<label><input type="checkbox" id="anthropic-thinking" ${config.thinking ? 'checked' : ''}> thinking</label>` +
      `<label><input type="checkbox" id="config-web-search" ${config.web_search ? 'checked' : ''}> web search</label>` +
      `<label><input type="checkbox" id="anthropic-code-execution" ${config.code_execution ? 'checked' : ''}> code execution</label>`;
  } else if (model === 'gpt-5.2') {
    const config = configState[model];
    modelConfigDiv.innerHTML =
      `<label>thinking <select id="config-reasoning-effort">` +
        (['none', 'low', 'medium', 'high', 'xhigh'] as const).map(v =>
          `<option value="${v}" ${config.reasoning_effort === v ? 'selected' : ''}>${v}</option>`
        ).join('') +
      `</select></label>` +
      `<label><input type="checkbox" id="config-web-search" ${config.web_search ? 'checked' : ''}> web search</label>` +
      `<label><input type="checkbox" id="config-image-generation" ${config.image_generation ? 'checked' : ''}> image generation</label>` +
      `<label><input type="checkbox" id="config-code-interpreter" ${config.code_interpreter ? 'checked' : ''}> code execution</label>`;
  } else if (model === 'gemini-3-pro-preview') {
    const config = configState[model];
    modelConfigDiv.innerHTML =
      `<label><input type="checkbox" id="config-google-search" ${config.google_search ? 'checked' : ''}> web search</label>` +
      `<label><input type="checkbox" id="config-image-generation" ${config.image_generation ? 'checked' : ''}> image generation</label>` +
      `<label><input type="checkbox" id="config-code-execution" ${config.code_execution ? 'checked' : ''}> code execution</label>`;
  } else if (model === 'gemini-3-flash-preview') {
    const config = configState[model];
    modelConfigDiv.innerHTML =
      `<label><input type="checkbox" id="config-google-search" ${config.google_search ? 'checked' : ''}> web search</label>` +
      `<label><input type="checkbox" id="config-code-execution" ${config.code_execution ? 'checked' : ''}> code execution</label>`;
  } else {
    modelConfigDiv.innerHTML = '';
  }
  persistState();
}

function lockModelSelection() {
  if (!hasSentMessage) {
    hasSentMessage = true;
    for (const radio of modelRadios) {
      radio.disabled = true;
    }
    historyButton.remove();
  }
}

for (const radio of modelRadios) {
  radio.addEventListener('change', renderModelConfig);
}
renderModelConfig();

// --- Auto-growing textarea ---

function fixupTextboxSize() {
  const growWrap = textarea.parentElement!;
  growWrap.dataset.replicatedValue = textarea.value;
}
textarea.addEventListener('input', fixupTextboxSize);

// --- File attachment ---

attachLink.addEventListener('click', () => filesInput.click());

filesInput.addEventListener('change', () => {
  if (filesInput.files && filesInput.files.length > 0) {
    pendingFiles = Array.from(filesInput.files);
    attachContainer.style.display = 'none';
    unattachLink.style.display = '';
  }
});

unattachLink.addEventListener('click', () => {
  pendingFiles = [];
  filesInput.value = '';
  attachContainer.style.display = '';
  unattachLink.style.display = 'none';
});

// --- Streaming display helpers ---

type StreamingUI = {
  container: HTMLElement;
  placeholder: HTMLElement | null;
  textSpan: HTMLSpanElement | null;
  thinkingDetails: HTMLDetailsElement | null;
  thinkingContent: HTMLElement | null;
  searchDetails: HTMLDetailsElement | null;
  searchContent: HTMLElement | null;
  citationCount: number;
};

type TurnRenderState = {
  ui: StreamingUI;
  serverToolJson: string;
  serverToolName: string;
  serverToolId: string;
  serverToolElements: Map<string, HTMLDetailsElement>;
  openaiCodePres: Map<string, HTMLPreElement>;
  googleCodeDetails: HTMLDetailsElement | undefined;
};

function createStreamingUI(): StreamingUI {
  const container = addMessageDiv(true);
  const placeholder = document.createElement('span');
  placeholder.textContent = 'Thinking...';
  placeholder.style.color = '#999';
  container.appendChild(placeholder);
  return {
    container,
    placeholder,
    textSpan: null,
    thinkingDetails: null,
    thinkingContent: null,
    searchDetails: null,
    searchContent: null,
    citationCount: 0,
  };
}

function createTurnRenderState(): TurnRenderState {
  return {
    ui: createStreamingUI(),
    serverToolJson: '',
    serverToolName: '',
    serverToolId: '',
    serverToolElements: new Map(),
    openaiCodePres: new Map(),
    googleCodeDetails: undefined,
  };
}

function clearPlaceholder(ui: StreamingUI) {
  if (ui.placeholder) {
    ui.placeholder.remove();
    ui.placeholder = null;
  }
}

function appendText(ui: StreamingUI, text: string) {
  clearPlaceholder(ui);
  if (!ui.textSpan) {
    // Reuse trailing span left by processCodeBlocks so text keeps accumulating in one span
    const lastChild = ui.container.lastElementChild;
    if (lastChild instanceof HTMLSpanElement) {
      ui.textSpan = lastChild;
    } else {
      ui.textSpan = document.createElement('span');
      ui.container.appendChild(ui.textSpan);
    }
  }
  ui.textSpan.textContent += text;
  // Process complete code blocks immediately
  if (/```\w*\n[\s\S]*?\n```/.test(ui.textSpan.textContent ?? '')) {
    processCodeBlocks(ui.container);
    ui.textSpan = null;
  }
  scrollToBottom();
}

function appendThinking(ui: StreamingUI, text: string) {
  clearPlaceholder(ui);
  if (!ui.thinkingDetails) {
    ui.thinkingDetails = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'Thinking...';
    ui.thinkingDetails.appendChild(summary);
    ui.thinkingContent = document.createElement('pre');
    ui.thinkingDetails.appendChild(ui.thinkingContent);
    ui.container.appendChild(ui.thinkingDetails);
  }
  ui.thinkingContent!.textContent += text;
  scrollToBottom();
}

function appendCitation(ui: StreamingUI, citation: { url: string; title: string | null; cited_text: string }) {
  clearPlaceholder(ui);
  ui.citationCount++;
  const a = document.createElement('a');
  a.href = citation.url;
  a.target = '_blank';
  a.rel = 'noopener';
  a.className = 'citation';
  a.textContent = `[cite ${ui.citationCount}]`;
  a.title = (citation.title ? citation.title + '\n\n' : '') + citation.cited_text;
  // Insert after current textSpan, or append to container
  if (ui.textSpan?.nextSibling) {
    ui.container.insertBefore(a, ui.textSpan.nextSibling);
  } else {
    ui.container.appendChild(a);
  }
  // Force next text to create a new span (so it appears after the citation)
  ui.textSpan = null;
  scrollToBottom();
}

function startSearch(ui: StreamingUI, query: string) {
  clearPlaceholder(ui);
  // Each search gets its own <details> block
  ui.searchDetails = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = `Search: ${query}`;
  ui.searchDetails.appendChild(summary);
  ui.searchContent = document.createElement('ul');
  ui.searchContent.classList.add('link-list');
  ui.searchDetails.appendChild(ui.searchContent);
  ui.container.appendChild(ui.searchDetails);
  scrollToBottom();
}

function addSearchResults(ui: StreamingUI, results: Array<{ title: string; url: string }>) {
  if (!ui.searchContent) return;
  for (const result of results) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = result.url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = result.title;
    li.appendChild(a);
    ui.searchContent.appendChild(li);
  }
  scrollToBottom();
}

function renderGroundingMetadata(ui: StreamingUI, gm: GroundingMetadata) {
  // Show search queries
  if (gm.webSearchQueries) {
    for (const query of gm.webSearchQueries) {
      startSearch(ui, query);
    }
  }
  // Show search result links
  const chunks = gm.groundingChunks;
  if (chunks && ui.searchContent) {
    const results: Array<{ title: string; url: string }> = [];
    for (const chunk of chunks) {
      if (chunk.web?.uri && chunk.web.title) {
        results.push({ title: chunk.web.title, url: chunk.web.uri });
      }
    }
    if (results.length > 0) {
      addSearchResults(ui, results);
    }
  }
  // Inline citations
  if (chunks && gm.groundingSupports) {
    for (const support of gm.groundingSupports) {
      if (!support.groundingChunkIndices?.length) continue;
      for (const i of support.groundingChunkIndices) {
        const chunk = chunks[i];
        if (chunk?.web?.uri) {
          appendCitation(ui, {
            url: chunk.web.uri,
            title: chunk.web.title ?? null,
            cited_text: support.segment?.text ?? '',
          });
        }
      }
    }
  }
}

function startServerTool(ui: StreamingUI, summary: string, body: string): HTMLDetailsElement {
  clearPlaceholder(ui);
  const details = document.createElement('details');
  const summaryEl = document.createElement('summary');
  summaryEl.textContent = summary;
  details.appendChild(summaryEl);
  if (body) {
    const pre = document.createElement('pre');
    pre.textContent = body;
    details.appendChild(pre);
  }
  ui.container.appendChild(details);
  scrollToBottom();
  return details;
}

function formatExecutionResult(result: { stdout: string; stderr: string }): string {
  const parts: string[] = [];
  if (result.stdout) parts.push(result.stdout);
  if (result.stderr) parts.push(`stderr:\n${result.stderr}`);
  return parts.join('\n') || '(no output)';
}

function addExecutionResult(container: HTMLElement, result: { stdout: string; stderr: string }) {
  const pre = document.createElement('pre');
  pre.textContent = formatExecutionResult(result);
  container.appendChild(pre);
  scrollToBottom();
}

function showError(container: HTMLElement, message: string) {
  const div = document.createElement('div');
  div.style.color = 'red';
  div.textContent = message;
  container.appendChild(div);
  scrollToBottom();
}

// --- File/image rendering ---

function renderImage(container: HTMLElement, src: string) {
  const img = document.createElement('img');
  img.src = src;
  container.appendChild(img);
}

function renderFileLink(container: HTMLElement, url: string, filename: string) {
  const link = document.createElement('a');
  link.className = 'attachment';
  link.href = url;
  link.download = filename;
  link.textContent = `\u{1F4CE} ${filename}`;
  container.appendChild(link);
}

function renderUserFiles(container: HTMLElement, files: File[]) {
  for (const file of files) {
    if (file.type.startsWith('image/')) {
      renderImage(container, URL.createObjectURL(file));
    } else {
      renderFileLink(container, URL.createObjectURL(file), file.name);
    }
  }
}

function renderBase64Image(container: HTMLElement, mediaType: string, data: string) {
  renderImage(container, `data:${mediaType};base64,${data}`);
}

// --- Event rendering (shared between streaming and replay) ---

function renderStreamEvent(state: TurnRenderState, event: StreamEvent) {
  const { ui } = state;
  switch (event.type) {
    case 'anthropic': {
      const raw = event.event;
      if (raw.type === 'content_block_delta') {
        const delta = raw.delta;
        if (delta.type === 'text_delta') {
          appendText(ui, delta.text);
        } else if (delta.type === 'thinking_delta') {
          appendThinking(ui, delta.thinking);
        } else if (delta.type === 'citations_delta') {
          const c = delta.citation;
          if ('url' in c) {
            appendCitation(ui, c);
          }
        } else if (delta.type === 'input_json_delta') {
          state.serverToolJson += delta.partial_json;
        } else if (delta.type !== 'signature_delta') {
          console.warn('unhandled content_block_delta type:', delta.type, delta);
        }
      } else if (raw.type === 'content_block_start') {
        const blockType = raw.content_block?.type;
        if (blockType === 'text') {
          ui.textSpan = null;
        } else if (blockType === 'server_tool_use') {
          state.serverToolJson = '';
          state.serverToolName = raw.content_block.name;
          state.serverToolId = raw.content_block.id;
        } else if (blockType === 'web_search_tool_result') {
          const content = raw.content_block.content;
          if (Array.isArray(content)) {
            addSearchResults(ui, content);
          }
        } else if (blockType === 'code_execution_tool_result' || blockType === 'bash_code_execution_tool_result') {
          const { content, tool_use_id } = raw.content_block;
          if ('stdout' in content) {
            const pairedDetails = state.serverToolElements.get(tool_use_id);
            if (pairedDetails) {
              addExecutionResult(pairedDetails, content);
              state.serverToolElements.delete(tool_use_id);
            } else {
              const details = startServerTool(ui, 'Execution result', '');
              addExecutionResult(details, content);
            }
          }
        } else if (blockType === 'text_editor_code_execution_tool_result') {
          // Text editor results are structural (create/view/str_replace) — no stdout to show
        } else if (blockType !== 'thinking' && blockType !== 'redacted_thinking') {
          console.warn('unhandled content_block_start type:', blockType, raw.content_block);
        }
      } else if (raw.type === 'content_block_stop') {
        if (state.serverToolJson) {
          try {
            const parsed = JSON.parse(state.serverToolJson);
            let details: HTMLDetailsElement | undefined;
            switch (state.serverToolName) {
              case 'web_search':
                startSearch(ui, parsed.query);
                break;
              case 'code_execution':
                details = startServerTool(ui, parsed.code.split('\n')[0], parsed.code);
                break;
              case 'bash_code_execution':
                details = startServerTool(ui, `$ ${parsed.command}`, '');
                break;
              case 'text_editor_code_execution':
                details = startServerTool(ui, `${parsed.command} ${parsed.path}`, parsed.file_text ?? parsed.new_str ?? '');
                break;
              default:
                console.warn('unhandled server tool:', state.serverToolName, parsed);
                details = startServerTool(ui, state.serverToolName, JSON.stringify(parsed, null, 2));
                break;
            }
            if (details) {
              state.serverToolElements.set(state.serverToolId, details);
            }
          } catch {}
          state.serverToolJson = '';
          state.serverToolName = '';
        }
      } else if (raw.type !== 'message_start' && raw.type !== 'message_delta' && raw.type !== 'message_stop') {
        raw satisfies never;
        console.warn('unhandled anthropic event type:', (raw as { type: string }).type, raw);
      }
      break;
    }

    case 'openai': {
      const raw = event.event;
      if (raw.type === 'response.output_text.delta') {
        appendText(ui, raw.delta);
      } else if (raw.type === 'response.reasoning_text.delta' || raw.type === 'response.reasoning_summary_text.delta') {
        appendThinking(ui, raw.delta);
      } else if (raw.type === 'response.output_text.annotation.added') {
        const ann = raw.annotation as { type: string; url: string; title: string };
        if (ann.type === 'url_citation') {
          appendCitation(ui, { url: ann.url, title: ann.title, cited_text: '' });
        } else {
          console.warn('unhandled openai annotation type:', ann.type, ann);
        }
      } else if (raw.type === 'response.code_interpreter_call_code.delta') {
        clearPlaceholder(ui);
        let pre = state.openaiCodePres.get(raw.item_id);
        if (!pre) {
          const details = document.createElement('details');
          const summary = document.createElement('summary');
          summary.textContent = 'Code...';
          details.appendChild(summary);
          pre = document.createElement('pre');
          details.appendChild(pre);
          ui.container.appendChild(details);
          state.openaiCodePres.set(raw.item_id, pre);
          state.serverToolElements.set(raw.item_id, details);
        }
        pre.textContent += raw.delta;
        scrollToBottom();
      } else if (raw.type === 'response.code_interpreter_call_code.done') {
        // Update summary to first line of code
        const details = state.serverToolElements.get(raw.item_id);
        if (details) {
          const summary = details.querySelector('summary');
          if (summary) {
            const firstLine = raw.code.split('\n')[0];
            summary.textContent = firstLine || 'Code';
          }
        }
      } else if (raw.type === 'response.output_item.done') {
        const item = raw.item;
        if (item.type === 'web_search_call' && item.action.type === 'search') {
          const query = item.action.queries?.join(', ') ?? item.action.query;
          startSearch(ui, query);
        } else if (item.type === 'code_interpreter_call' && item.outputs) {
          const details = state.serverToolElements.get(item.id);
          for (const output of item.outputs) {
            if (output.type === 'logs') {
              const pre = document.createElement('pre');
              pre.textContent = output.logs || '(no output)';
              if (details) {
                details.appendChild(pre);
              } else {
                ui.container.appendChild(pre);
              }
            } else if (output.type === 'image') {
              clearPlaceholder(ui);
              renderImage(details ?? ui.container, output.url);
            }
          }
          scrollToBottom();
        }
      } else if (
        raw.type !== 'response.created' &&
        raw.type !== 'response.in_progress' &&
        raw.type !== 'response.completed' &&
        raw.type !== 'response.output_item.added' &&
        raw.type !== 'response.content_part.added' &&
        raw.type !== 'response.content_part.done' &&
        raw.type !== 'response.output_text.done' &&
        raw.type !== 'response.reasoning_text.done' &&
        raw.type !== 'response.reasoning_summary_text.done' &&
        raw.type !== 'response.reasoning_summary_part.added' &&
        raw.type !== 'response.reasoning_summary_part.done' &&
        raw.type !== 'response.web_search_call.in_progress' &&
        raw.type !== 'response.web_search_call.searching' &&
        raw.type !== 'response.web_search_call.completed' &&
        raw.type !== 'response.image_generation_call.in_progress' &&
        raw.type !== 'response.image_generation_call.generating' &&
        raw.type !== 'response.image_generation_call.partial_image' &&
        raw.type !== 'response.image_generation_call.completed' &&
        raw.type !== 'response.code_interpreter_call.in_progress' &&
        raw.type !== 'response.code_interpreter_call.interpreting' &&
        raw.type !== 'response.code_interpreter_call.completed'
      ) {
        console.warn('unhandled openai event type:', raw.type, raw);
      }
      break;
    }

    case 'google': {
      for (const part of event.event.parts) {
        if (part.text != null) {
          appendText(ui, part.text);
        } else if (part.inlineData?.data && part.inlineData.mimeType) {
          clearPlaceholder(ui);
          renderBase64Image(ui.container, part.inlineData.mimeType, part.inlineData.data);
          scrollToBottom();
        } else if (part.executableCode?.code) {
          const firstLine = part.executableCode.code.split('\n')[0];
          const details = startServerTool(ui, firstLine, part.executableCode.code);
          state.googleCodeDetails = details;
        } else if (part.codeExecutionResult) {
          const output = part.codeExecutionResult.output ?? '(no output)';
          const target = state.googleCodeDetails ?? ui.container;
          const pre = document.createElement('pre');
          pre.textContent = output;
          target.appendChild(pre);
          state.googleCodeDetails = undefined;
          scrollToBottom();
        }
      }
      const gm = event.event.groundingMetadata;
      if (gm) {
        renderGroundingMetadata(ui, gm);
      }
      break;
    }

    case 'done': {
      // Render OpenAI generated images (history mutation is handled by the caller)
      if (event.provider === 'openai') {
        for (const item of event.assistantMessage.output) {
          if ('type' in item && item.type === 'image_generation_call' && 'result' in item && item.result) {
            clearPlaceholder(ui);
            renderBase64Image(ui.container, 'image/png', item.result);
          }
        }
      }
      break;
    }

    case 'error': {
      showError(ui.container, `Error: ${event.error}`);
      break;
    }

    default: {
      event satisfies never;
      showError(ui.container, `Error: got bad message type ${(event as { type: string }).type}`);
      break;
    }
  }
}

// --- Code block rendering ---

function createCopyButton(codeContent: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.textContent = 'Copy';
  button.className = 'copy-button';
  button.addEventListener('click', () => {
    navigator.clipboard.writeText(codeContent).then(() => {
      button.textContent = 'Copied!';
      button.style.backgroundColor = '#aeffae';
      setTimeout(() => {
        button.textContent = 'Copy';
        button.style.backgroundColor = '';
      }, 2000);
    }).catch(() => {
      button.textContent = 'Error';
      button.style.backgroundColor = '#ffaaaa';
      setTimeout(() => {
        button.textContent = 'Copy';
        button.style.backgroundColor = '';
      }, 2000);
    });
  });
  return button;
}

function processCodeBlocks(container: HTMLElement) {
  const codeBlockRegex = /```(\w*)\n([\s\S]*?)\n```/g;
  // Collect spans to process (avoid mutating while iterating)
  const spans = Array.from(container.querySelectorAll<HTMLSpanElement>(':scope > span'));
  for (const span of spans) {
    const text = span.textContent ?? '';
    if (!codeBlockRegex.test(text)) continue;
    codeBlockRegex.lastIndex = 0;

    const fragment = document.createDocumentFragment();
    let lastIndex = 0;
    let match;

    while ((match = codeBlockRegex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        const before = document.createElement('span');
        before.textContent = text.substring(lastIndex, match.index);
        fragment.appendChild(before);
      }

      const lang = match[1];
      const codeContent = match[2];

      const codeContainer = document.createElement('div');
      codeContainer.className = 'code-block-container';

      const pre = document.createElement('pre');
      const code = document.createElement('code');
      if (lang) code.className = `language-${lang}`;
      code.textContent = codeContent;
      pre.appendChild(code);

      codeContainer.appendChild(createCopyButton(codeContent));
      codeContainer.appendChild(pre);
      fragment.appendChild(codeContainer);

      lastIndex = codeBlockRegex.lastIndex;
    }

    if (lastIndex < text.length) {
      const after = document.createElement('span');
      after.textContent = text.substring(lastIndex);
      fragment.appendChild(after);
    }

    span.replaceWith(fragment);
  }
}

// --- UI helpers ---

function scrollToBottom() {
  const threshold = 50;
  const distanceFromBottom = messagesDiv.scrollHeight - messagesDiv.scrollTop - messagesDiv.clientHeight;
  if (distanceFromBottom <= threshold) {
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
  }
}

function addMessageDiv(isBot: boolean): HTMLElement {
  const container = document.createElement('div');
  container.className = isBot ? 'bot-message-container' : 'user-message-container';

  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = isBot ? 'bot' : 'user';
  container.appendChild(name);

  const text = document.createElement('div');
  text.className = 'text';
  container.appendChild(text);

  messagesDiv.appendChild(container);
  return text;
}

// --- History dialog ---

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString();
}

function confirmAction(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    confirmDialogMessage.innerHTML = message;
    const cleanup = () => {
      confirmDialogOk.removeEventListener('click', onOk);
      confirmDialogCancel.removeEventListener('click', onCancel);
      confirmDialog.removeEventListener('close', onClose);
    };
    const onOk = () => { cleanup(); confirmDialog.close(); resolve(true); };
    const onCancel = () => { cleanup(); confirmDialog.close(); resolve(false); };
    const onClose = () => { cleanup(); resolve(false); };
    confirmDialogOk.addEventListener('click', onOk);
    confirmDialogCancel.addEventListener('click', onCancel);
    confirmDialog.addEventListener('close', onClose);
    confirmDialog.showModal();
  });
}

async function showHistoryDialog() {
  const convs = (await loadConversations()).sort((a, b) => {
    if (a.bookmarked !== b.bookmarked) return a.bookmarked ? -1 : 1;
    return b.updatedAt - a.updatedAt;
  });

  historyList.innerHTML = '';
  if (convs.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'history-item';
    empty.style.color = '#999';
    empty.style.justifyContent = 'center';
    empty.textContent = '(empty)';
    historyList.appendChild(empty);
  }
  for (const conv of convs) {
    const preview = conv.preview;
    const li = document.createElement('li');
    li.className = 'history-item';

    const previewSpan = document.createElement('span');
    previewSpan.className = 'history-item-preview';
    previewSpan.textContent = preview || '(empty)';
    li.appendChild(previewSpan);

    const meta = document.createElement('span');
    meta.className = 'history-item-meta';
    meta.textContent = `${conv.config.model} \u00b7 ${formatDate(conv.updatedAt)}`;
    li.appendChild(meta);

    const actions = document.createElement('span');
    actions.className = 'history-item-actions';

    const bookmarkBtn = document.createElement('button');
    bookmarkBtn.className = 'history-item-action';
    bookmarkBtn.textContent = conv.bookmarked ? '\u2605' : '\u2606';
    bookmarkBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      conv.bookmarked = !conv.bookmarked;
      bookmarkBtn.textContent = conv.bookmarked ? '\u2605' : '\u2606';
      await saveConversation(conv);
    });
    actions.appendChild(bookmarkBtn);

    const trashBtn = document.createElement('button');
    trashBtn.className = 'history-item-action';
    const trashIcon = document.getElementById('trash-icon')!.cloneNode(true) as HTMLElement;
    trashIcon.removeAttribute('style');
    trashIcon.removeAttribute('id');
    trashBtn.appendChild(trashIcon);
    trashBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (e.shiftKey || await confirmAction('Delete this conversation? This cannot be undone.<br><br>Tip: hold "shift" while clicking the trash icon to skip this confirmation.')) {
        await deleteConversation(conv.id);
        await showHistoryDialog();
      }
    });
    actions.appendChild(trashBtn);

    li.appendChild(actions);

    li.addEventListener('click', async () => {
      historyDialog.close();
      await restoreConversation(conv.id);
    });

    historyList.appendChild(li);
  }

  historyDialog.showModal();
}

historyButton.addEventListener('click', showHistoryDialog);
historyDialogClose.addEventListener('click', () => historyDialog.close());

// --- Send ---

async function sendMessage() {
  const text = textarea.value.trim();
  if (!text && pendingFiles.length === 0) return;

  sendBtn.disabled = true;
  textarea.value = '';
  fixupTextboxSize();
  lockModelSelection();

  // Display user message
  const userDiv = addMessageDiv(false);
  if (text) {
    const userText = document.createElement('span');
    userText.textContent = text;
    userDiv.appendChild(userText);
  }
  renderUserFiles(userDiv, pendingFiles);
  scrollToBottom();

  const request = getChatRequest(text);
  const files = pendingFiles;
  pendingFiles = [];
  filesInput.value = '';
  attachContainer.style.display = '';
  unattachLink.style.display = 'none';

  await streamChat(request, files);
  sendBtn.disabled = false;
  textarea.focus();
}

// --- Stream ---

async function streamChat(request: ChatRequest, files: File[]) {
  const state = createTurnRenderState();
  const turnEvents: StreamEvent[] = [];

  const formData = new FormData();
  formData.append('messages', JSON.stringify(request.messages));
  formData.append('config', JSON.stringify(request.config));
  formData.append('text', request.text);
  for (const file of files) {
    formData.append('files', file);
  }

  try {
    const resp = await fetch('/chat', {
      method: 'POST',
      body: formData,
    });

    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop()!;

      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith('data: ')) continue;
        const event: StreamEvent = JSON.parse(line.slice(6));
        turnEvents.push(event);

        renderStreamEvent(state, event);

        // Update conversation history from done event
        if (event.type === 'done') {
          if (event.provider === 'anthropic') {
            anthropicHistory.push(event.userMessage);
            anthropicHistory.push({ role: 'assistant', content: event.assistantMessage.content });
            if (event.container) {
              anthropicContainer = event.container;
            }
          } else if (event.provider === 'openai') {
            openaiHistory.push(event.userInput);
            for (const item of event.assistantMessage.output) {
              openaiHistory.push(item);
            }
            if (event.container) {
              openaiContainer = event.container;
            }
          } else if (event.provider === 'google') {
            googleHistory.push(event.userContent);
            googleHistory.push(event.assistantContent);
          }
        }
      }
    }
    processCodeBlocks(state.ui.container);
    // Persist completed turn
    currentConversation.turns.push(turnEvents);
    currentConversation.config = request.config;
    const model = request.config.model;
    if (model === 'gpt-5.2') {
      currentConversation.history = openaiHistory;
      currentConversation.container = openaiContainer;
    } else if (model === 'gemini-3-flash-preview' || model === 'gemini-3-pro-preview') {
      currentConversation.history = googleHistory;
    } else {
      currentConversation.history = anthropicHistory;
      currentConversation.container = anthropicContainer;
    }
    await saveCurrentConversation(turnEvents);
  } catch (err: any) {
    showError(state.ui.container, `Error: ${err.message}`);
  }
}

// --- Restore conversation from history ---

function extractUserText(events: StreamEvent[]): string {
  for (const event of events) {
    if (event.type !== 'done') continue;
    if (event.provider === 'anthropic') {
      const { content } = event.userMessage;
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if ('text' in block && typeof block.text === 'string') return block.text;
        }
      }
    } else if (event.provider === 'openai') {
      if ('content' in event.userInput) {
        const { content } = event.userInput;
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
          for (const part of content) {
            if ('text' in part && typeof part.text === 'string') return part.text;
          }
        }
      }
    } else if (event.provider === 'google') {
      const parts = event.userContent.parts;
      if (parts) {
        for (const part of parts) {
          if (part.text) return part.text;
        }
      }
    }
  }
  return '';
}

async function restoreConversation(id: string) {
  const conv = await loadConversation(id);

  // Update currentConversation
  currentConversation.id = conv.id;
  currentConversation.config = conv.config;
  currentConversation.history = conv.history;
  currentConversation.container = conv.container;
  currentConversation.turns = conv.turns;
  currentConversation.updatedAt = conv.updatedAt;

  // Set provider-specific globals
  const model = conv.config.model;
  if (model === 'gpt-5.2') {
    openaiHistory = conv.history as OpenAIHistory;
    openaiContainer = conv.container;
    anthropicHistory = [];
    anthropicContainer = undefined;
    googleHistory = [];
  } else if (model === 'gemini-3-flash-preview' || model === 'gemini-3-pro-preview') {
    googleHistory = conv.history as GoogleHistory;
    anthropicHistory = [];
    anthropicContainer = undefined;
    openaiHistory = [];
    openaiContainer = undefined;
  } else {
    anthropicHistory = conv.history as AnthropicHistory;
    anthropicContainer = conv.container;
    openaiHistory = [];
    openaiContainer = undefined;
    googleHistory = [];
  }

  // Set model radio and config
  const radio = document.querySelector<HTMLInputElement>(`input[name="model"][value="${model}"]`);
  if (radio) radio.checked = true;
  const { model: _, ...configFields } = conv.config;
  Object.assign(configState[model], configFields);
  renderModelConfig();
  lockModelSelection();

  // Clear and replay UI
  messagesDiv.innerHTML = '';
  for (const turnEvents of conv.turns) {
    const userText = extractUserText(turnEvents);
    if (userText) {
      const userDiv = addMessageDiv(false);
      const span = document.createElement('span');
      span.textContent = userText;
      userDiv.appendChild(span);
    }

    const state = createTurnRenderState();
    for (const event of turnEvents) {
      renderStreamEvent(state, event);
    }
    processCodeBlocks(state.ui.container);
  }
  scrollToBottom();
}

// Expose for console testing
Object.assign(window, { restoreConversation, loadConversations });

sendBtn.addEventListener('click', sendMessage);
textarea.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (!sendBtn.disabled) sendMessage();
  }
});
