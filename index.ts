import type {
  AnthropicHistory, AnthropicMessageParam,
  OpenAIHistory, OpenAIInputItem, OpenAIResponse,
  AnthropicConfig, OpenAIConfig, ChatConfig, ChatRequest, StreamEvent,
} from './run.ts';

const messagesDiv = document.getElementById('messages')!;
const textarea = document.getElementById('message') as HTMLTextAreaElement;
const sendBtn = document.getElementById('send') as HTMLButtonElement;
const filesInput = document.getElementById('files') as HTMLInputElement;
const modelSelectionDiv = document.getElementById('model-selection')!;
const modelConfigDiv = document.getElementById('model-config')!;
const modelRadios = document.querySelectorAll<HTMLInputElement>('input[name="model"]');

// --- Per-provider conversation history ---
// Only one is active at a time; which one depends on the selected model.
let anthropicHistory: AnthropicHistory = [];
let openaiHistory: OpenAIHistory = [];
let hasSentMessage = false;

function getSelectedModel(): ChatConfig['model'] {
  const checked = document.querySelector<HTMLInputElement>('input[name="model"]:checked');
  return (checked?.value ?? 'claude-sonnet-4-5') as ChatConfig['model'];
}

function getChatRequest(text: string): ChatRequest {
  const model = getSelectedModel();
  if (model === 'claude-sonnet-4-5') {
    const thinkingCheckbox = document.getElementById('anthropic-thinking') as HTMLInputElement | null;
    return {
      messages: anthropicHistory,
      config: { model, thinking: thinkingCheckbox?.checked ?? true, max_tokens: 16384 },
      text,
    };
  }
  return {
    messages: openaiHistory,
    config: { model },
    text,
  };
}

// --- Model config UI ---

function renderModelConfig() {
  const model = getSelectedModel();
  if (model === 'claude-sonnet-4-5') {
    modelConfigDiv.innerHTML = '<label><input type="checkbox" id="anthropic-thinking" checked> Thinking</label>';
  } else {
    modelConfigDiv.innerHTML = '';
  }
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

// --- Streaming display helpers ---

type StreamingUI = {
  container: HTMLDivElement;
  textSpan: HTMLSpanElement | null;
  thinkingDetails: HTMLDetailsElement | null;
  thinkingContent: HTMLElement | null;
};

function createStreamingUI(): StreamingUI {
  return {
    container: appendMessageDiv('assistant'),
    textSpan: null,
    thinkingDetails: null,
    thinkingContent: null,
  };
}

function appendText(ui: StreamingUI, text: string) {
  if (!ui.textSpan) {
    ui.textSpan = document.createElement('span');
    ui.container.appendChild(ui.textSpan);
  }
  ui.textSpan.textContent += text;
  scrollToBottom();
}

function appendThinking(ui: StreamingUI, text: string) {
  if (!ui.thinkingDetails) {
    ui.thinkingDetails = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'Thinking...';
    ui.thinkingDetails.appendChild(summary);
    ui.thinkingContent = document.createElement('pre');
    ui.thinkingContent.style.whiteSpace = 'pre-wrap';
    ui.thinkingContent.style.fontSize = '13px';
    ui.thinkingDetails.appendChild(ui.thinkingContent);
    ui.container.appendChild(ui.thinkingDetails);
  }
  ui.thinkingContent!.textContent += text;
  scrollToBottom();
}

function showError(container: HTMLElement, message: string) {
  const errSpan = document.createElement('span');
  errSpan.style.color = 'red';
  errSpan.textContent = message;
  container.appendChild(errSpan);
  scrollToBottom();
}

// --- UI helpers ---

function scrollToBottom() {
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

function appendMessageDiv(role: 'user' | 'assistant'): HTMLDivElement {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  const roleLabel = document.createElement('div');
  roleLabel.className = 'role';
  roleLabel.textContent = role === 'user' ? 'You' : 'Assistant';
  div.appendChild(roleLabel);
  messagesDiv.appendChild(div);
  return div;
}

// --- Send ---

async function sendMessage() {
  const text = textarea.value.trim();
  const files = filesInput.files;
  if (!text && (!files || files.length === 0)) return;

  sendBtn.disabled = true;
  textarea.value = '';
  lockModelSelection();

  // Display user message
  const userDiv = appendMessageDiv('user');
  const userText = document.createElement('span');
  userText.textContent = text || '(file attachment)';
  userDiv.appendChild(userText);
  scrollToBottom();

  const request = getChatRequest(text);
  filesInput.value = '';

  await streamChat(request, files);
  sendBtn.disabled = false;
  textarea.focus();
}

// --- Stream ---

async function streamChat(request: ChatRequest, files: FileList | null) {
  const ui = createStreamingUI();

  const formData = new FormData();
  formData.append('messages', JSON.stringify(request.messages));
  formData.append('config', JSON.stringify(request.config));
  formData.append('text', request.text);
  if (files) {
    for (const file of Array.from(files)) {
      formData.append('files', file);
    }
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
