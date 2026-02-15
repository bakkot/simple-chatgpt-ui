import type {
  AnthropicHistory, AnthropicMessageParam,
  OpenAIHistory, OpenAIInputItem, OpenAIResponse,
  AnthropicConfig, OpenAIConfig, ChatConfig, StreamEvent,
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

function getConfig(): ChatConfig {
  const model = getSelectedModel();
  if (model === 'claude-sonnet-4-5') {
    const thinkingCheckbox = document.getElementById('anthropic-thinking') as HTMLInputElement | null;
    return {
      model,
      thinking: thinkingCheckbox?.checked ?? true,
      max_tokens: 16384,
    } satisfies AnthropicConfig;
  }
  return { model } satisfies OpenAIConfig;
}

function getHistory(): AnthropicHistory | OpenAIHistory {
  const model = getSelectedModel();
  if (model === 'claude-sonnet-4-5') return anthropicHistory;
  return openaiHistory;
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

  // Build FormData
  const formData = new FormData();
  formData.append('messages', JSON.stringify(getHistory()));
  formData.append('config', JSON.stringify(getConfig()));
  formData.append('text', text);
  if (files) {
    for (const file of Array.from(files)) {
      formData.append('files', file);
    }
  }
  filesInput.value = '';

  await streamChat(formData);
  sendBtn.disabled = false;
  textarea.focus();
}

// --- Stream ---

async function streamChat(formData: FormData) {
  const assistantDiv = appendMessageDiv('assistant');
  let textSpan: HTMLSpanElement | null = null;
  let thinkingDetails: HTMLDetailsElement | null = null;
  let thinkingContent: HTMLElement | null = null;

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
                if (!textSpan) {
                  textSpan = document.createElement('span');
                  assistantDiv.appendChild(textSpan);
                }
                textSpan.textContent += delta.text;
                scrollToBottom();
              } else if (delta.type === 'thinking_delta') {
                if (!thinkingDetails) {
                  thinkingDetails = document.createElement('details');
                  const summary = document.createElement('summary');
                  summary.textContent = 'Thinking...';
                  thinkingDetails.appendChild(summary);
                  thinkingContent = document.createElement('pre');
                  thinkingContent.style.whiteSpace = 'pre-wrap';
                  thinkingContent.style.fontSize = '13px';
                  thinkingDetails.appendChild(thinkingContent);
                  assistantDiv.appendChild(thinkingDetails);
                }
                thinkingContent!.textContent += delta.thinking;
                scrollToBottom();
              }
            } else if (raw.type === 'content_block_start') {
              if (raw.content_block?.type === 'text') {
                textSpan = null;
              }
            }
            break;
          }

          case 'openai': {
            const raw = event.event;
            if (raw.type === 'response.output_text.delta') {
              if (!textSpan) {
                textSpan = document.createElement('span');
                assistantDiv.appendChild(textSpan);
              }
              textSpan.textContent += raw.delta;
              scrollToBottom();
            } else if (raw.type === 'response.reasoning_text.delta') {
              if (!thinkingDetails) {
                thinkingDetails = document.createElement('details');
                const summary = document.createElement('summary');
                summary.textContent = 'Thinking...';
                thinkingDetails.appendChild(summary);
                thinkingContent = document.createElement('pre');
                thinkingContent.style.whiteSpace = 'pre-wrap';
                thinkingContent.style.fontSize = '13px';
                thinkingDetails.appendChild(thinkingContent);
                assistantDiv.appendChild(thinkingDetails);
              }
              thinkingContent!.textContent += raw.delta;
              scrollToBottom();
            }
            break;
          }

          case 'done': {
            if (event.provider === 'anthropic') {
              anthropicHistory.push(event.userMessage);
              anthropicHistory.push({ role: 'assistant', content: event.assistantMessage.content });
            } else {
              openaiHistory.push(event.userInput);
              // Push output items from the response into history for multi-turn
              for (const item of event.assistantMessage.output) {
                openaiHistory.push(item);
              }
            }
            break;
          }

          case 'error': {
            const errSpan = document.createElement('span');
            errSpan.style.color = 'red';
            errSpan.textContent = `Error: ${event.error}`;
            assistantDiv.appendChild(errSpan);
            scrollToBottom();
            break;
          }

          default: {
            event satisfies never; // assert switch exhaustiveness
            const errSpan = document.createElement('span');
            errSpan.style.color = 'red';
            errSpan.textContent = `Error: got bad message type ${(event as { type: string }).type}`;
            assistantDiv.appendChild(errSpan);
            scrollToBottom();
            break;
          }
        }
      }
    }
  } catch (err: any) {
    const errSpan = document.createElement('span');
    errSpan.style.color = 'red';
    errSpan.textContent = `Error: ${err.message}`;
    assistantDiv.appendChild(errSpan);
  }
}

sendBtn.addEventListener('click', sendMessage);
textarea.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});
