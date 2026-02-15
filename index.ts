import type { MessageParam, ChatConfig, StreamEvent } from './run.ts';

const messagesDiv = document.getElementById('messages')!;
const textarea = document.getElementById('message') as HTMLTextAreaElement;
const sendBtn = document.getElementById('send') as HTMLButtonElement;
const filesInput = document.getElementById('files') as HTMLInputElement;

const conversationHistory: MessageParam[] = [];

const config: ChatConfig = {
  model: 'claude-sonnet-4-5',
  thinking: true,
  max_tokens: 16384,
};

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

async function sendMessage() {
  const text = textarea.value.trim();
  const files = filesInput.files;
  if (!text && (!files || files.length === 0)) return;

  sendBtn.disabled = true;
  textarea.value = '';

  // Display user message
  const userDiv = appendMessageDiv('user');
  const userText = document.createElement('span');
  userText.textContent = text || '(file attachment)';
  userDiv.appendChild(userText);
  scrollToBottom();

  // Build FormData — server handles file reading and content block construction
  const formData = new FormData();
  formData.append('messages', JSON.stringify(conversationHistory));
  formData.append('config', JSON.stringify(config));
  formData.append('text', text);
  if (files) {
    for (const file of Array.from(files)) {
      formData.append('files', file);
    }
  }
  filesInput.value = '';

  // Stream assistant response
  await streamChat(formData);
  sendBtn.disabled = false;
  textarea.focus();
}

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
          // Raw Anthropic stream events
          case 'content_block_delta': {
            const delta = event.delta;
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
            break;
          }

          case 'content_block_start': {
            // Reset spans when a new text block starts so multiple text blocks render separately
            if (event.content_block?.type === 'text') {
              textSpan = null;
            }
            break;
          }

          // Our custom events
          case 'done': {
            conversationHistory.push(event.userMessage);
            conversationHistory.push({ role: 'assistant', content: event.assistantMessage.content });
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
