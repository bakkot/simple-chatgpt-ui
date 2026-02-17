import type {
  AnthropicHistory, AnthropicMessageParam,
  OpenAIHistory, OpenAIInputItem, OpenAIResponse,
  Sonnet45Config, Opus46Config, GPT52Config, ChatConfig, ChatRequest, StreamEvent,
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

// --- Conversation history persistence ---

type Conversation = {
  id: string;
  config: ChatConfig;
  history: AnthropicHistory | OpenAIHistory;
  container?: string;
  turns: StreamEvent[][];
  updatedAt: number;
};

function generateId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

const HISTORY_KEY = 'chatbot-history';

const currentConversation: Conversation = {
  id: generateId(),
  config: undefined as unknown as ChatConfig, // set on first turn
  history: [],
  turns: [],
  updatedAt: 0,
};

function loadConversations(): Record<string, Conversation> {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? JSON.parse(raw) as Record<string, Conversation> : {};
  } catch { return {}; }
}

function saveCurrentConversation() {
  currentConversation.updatedAt = Date.now();
  const all = loadConversations();
  all[currentConversation.id] = currentConversation;
  localStorage.setItem(HISTORY_KEY, JSON.stringify(all));
}

// --- Per-provider conversation history ---
let anthropicHistory: AnthropicHistory = [];
let anthropicContainer: string | undefined;
let openaiHistory: OpenAIHistory = [];
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
  'gpt-5.2': { web_search: false, image_generation: false },
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
      `<label><input type="checkbox" id="config-web-search" ${config.web_search ? 'checked' : ''}> web search</label>` +
      `<label><input type="checkbox" id="config-image-generation" ${config.image_generation ? 'checked' : ''}> image generation</label>`;
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

function clearPlaceholder(ui: StreamingUI) {
  if (ui.placeholder) {
    ui.placeholder.remove();
    ui.placeholder = null;
  }
}

function appendText(ui: StreamingUI, text: string) {
  clearPlaceholder(ui);
  if (!ui.textSpan) {
    ui.textSpan = document.createElement('span');
    ui.container.appendChild(ui.textSpan);
  }
  ui.textSpan.textContent += text;
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

// --- UI helpers ---

function scrollToBottom() {
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
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
  const ui = createStreamingUI();
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
    let serverToolJson = '';
    let serverToolName = '';
    let serverToolId = '';
    const serverToolElements = new Map<string, HTMLDetailsElement>();

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
                serverToolJson += delta.partial_json;
              } else if (delta.type !== 'signature_delta') {
                console.warn('unhandled content_block_delta type:', delta.type, delta);
              }
            } else if (raw.type === 'content_block_start') {
              const blockType = raw.content_block?.type;
              if (blockType === 'text') {
                ui.textSpan = null;
              } else if (blockType === 'server_tool_use') {
                serverToolJson = '';
                serverToolName = raw.content_block.name;
                serverToolId = raw.content_block.id;
              } else if (blockType === 'web_search_tool_result') {
                const content = raw.content_block.content;
                if (Array.isArray(content)) {
                  addSearchResults(ui, content);
                }
              } else if (blockType === 'code_execution_tool_result' || blockType === 'bash_code_execution_tool_result') {
                const { content, tool_use_id } = raw.content_block;
                if ('stdout' in content) {
                  const pairedDetails = serverToolElements.get(tool_use_id);
                  if (pairedDetails) {
                    addExecutionResult(pairedDetails, content);
                    serverToolElements.delete(tool_use_id);
                  } else {
                    // Fallback: result arrived without a matching invocation
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
              if (serverToolJson) {
                try {
                  const parsed = JSON.parse(serverToolJson);
                  let details: HTMLDetailsElement | undefined;
                  switch (serverToolName) {
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
                      console.warn('unhandled server tool:', serverToolName, parsed);
                      details = startServerTool(ui, serverToolName, JSON.stringify(parsed, null, 2));
                      break;
                  }
                  if (details) {
                    serverToolElements.set(serverToolId, details);
                  }
                } catch {}
                serverToolJson = '';
                serverToolName = '';
              }
            } else if (raw.type !== 'message_start' && raw.type !== 'message_delta' && raw.type !== 'message_stop') {
              // This branch is unreachable (raw is `never` here) but serves as
              // a runtime safety net in case the SDK adds new event types
              raw satisfies never;
              console.warn('unhandled anthropic event type:', (raw as { type: string }).type, raw);
            }
            break;
          }

          case 'openai': {
            const raw = event.event;
            if (raw.type === 'response.output_text.delta') {
              appendText(ui, raw.delta);
            } else if (raw.type === 'response.reasoning_text.delta') {
              appendThinking(ui, raw.delta);
            } else if (raw.type === 'response.output_text.annotation.added') {
              const ann = raw.annotation as { type: string; url: string; title: string };
              if (ann.type === 'url_citation') {
                appendCitation(ui, { url: ann.url, title: ann.title, cited_text: '' });
              } else {
                console.warn('unhandled openai annotation type:', ann.type, ann);
              }
            } else if (raw.type === 'response.output_item.done') {
              const item = raw.item;
              if (item.type === 'web_search_call' && item.action.type === 'search') {
                const query = item.action.queries?.join(', ') ?? item.action.query;
                startSearch(ui, query);
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
              raw.type !== 'response.reasoning_summary_text.delta' &&
              raw.type !== 'response.reasoning_summary_text.done' &&
              raw.type !== 'response.reasoning_summary_part.added' &&
              raw.type !== 'response.reasoning_summary_part.done' &&
              raw.type !== 'response.web_search_call.in_progress' &&
              raw.type !== 'response.web_search_call.searching' &&
              raw.type !== 'response.web_search_call.completed' &&
              raw.type !== 'response.image_generation_call.in_progress' &&
              raw.type !== 'response.image_generation_call.generating' &&
              raw.type !== 'response.image_generation_call.partial_image' &&
              raw.type !== 'response.image_generation_call.completed'
            ) {
              console.warn('unhandled openai event type:', raw.type, raw);
            }
            break;
          }

          case 'done': {
            if (event.provider === 'anthropic') {
              anthropicHistory.push(event.userMessage);
              anthropicHistory.push({ role: 'assistant', content: event.assistantMessage.content });
              if (event.container) {
                anthropicContainer = event.container;
              }
            } else {
              openaiHistory.push(event.userInput);
              for (const item of event.assistantMessage.output) {
                openaiHistory.push(item);
                // Render generated images
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
            event satisfies never; // assert switch exhaustiveness
            showError(ui.container, `Error: got bad message type ${(event as { type: string }).type}`);
            break;
          }
        }
      }
    }
    // Persist completed turn
    currentConversation.turns.push(turnEvents);
    currentConversation.config = request.config;
    const model = request.config.model;
    if (model === 'gpt-5.2') {
      currentConversation.history = openaiHistory;
    } else {
      currentConversation.history = anthropicHistory;
      currentConversation.container = anthropicContainer;
    }
    saveCurrentConversation();
  } catch (err: any) {
    showError(ui.container, `Error: ${err.message}`);
  }
}

sendBtn.addEventListener('click', sendMessage);
textarea.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});
