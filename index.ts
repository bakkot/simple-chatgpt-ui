import type {
  AnthropicHistory, AnthropicMessageParam,
  OpenAIHistory, OpenAIInputItem, OpenAIResponse,
  Sonnet45Config, Opus46Config, GPT5Config, ChatConfig, ChatRequest, StreamEvent,
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

// --- Per-provider conversation history ---
let anthropicHistory: AnthropicHistory = [];
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
        config: { model, ...configState[model] },
        text,
      } as ChatRequest;
    }
    case 'gpt-5': {
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
  'claude-sonnet-4-5': { thinking: true, max_tokens: 16384 },
  'claude-opus-4-6': {},
  'gpt-5': {},
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
  if (currentModel === 'claude-sonnet-4-5') {
    const cb = document.getElementById('anthropic-thinking') as HTMLInputElement | null;
    if (cb) configState[currentModel].thinking = cb.checked;
  }
  persistState();
}

function renderModelConfig() {
  saveModelConfig();
  const model = getSelectedModel();
  currentModel = model;
  if (model === 'claude-sonnet-4-5') {
    const config = configState[model];
    modelConfigDiv.innerHTML = `<label><input type="checkbox" id="anthropic-thinking" ${config.thinking ? 'checked' : ''}> thinking</label>`;
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

        switch (event.type) {
          case 'anthropic': {
            const raw = event.event;
            if (raw.type === 'content_block_delta') {
              const delta = raw.delta;
              if (delta.type === 'text_delta') {
                appendText(ui, delta.text);
              } else if (delta.type === 'thinking_delta') {
                appendThinking(ui, delta.thinking);
              }
            } else if (raw.type === 'content_block_start') {
              if (raw.content_block?.type === 'text') {
                ui.textSpan = null;
              }
            }
            break;
          }

          case 'openai': {
            const raw = event.event;
            if (raw.type === 'response.output_text.delta') {
              appendText(ui, raw.delta);
            } else if (raw.type === 'response.reasoning_text.delta') {
              appendThinking(ui, raw.delta);
            }
            break;
          }

          case 'done': {
            if (event.provider === 'anthropic') {
              anthropicHistory.push(event.userMessage);
              anthropicHistory.push({ role: 'assistant', content: event.assistantMessage.content });
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
