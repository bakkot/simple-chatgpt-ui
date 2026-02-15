import type { Message, ChatConfig, SSEEvent } from './run.ts';

const messagesDiv = document.getElementById('messages')!;
const textarea = document.getElementById('message') as HTMLTextAreaElement;
const sendBtn = document.getElementById('send') as HTMLButtonElement;
const filesInput = document.getElementById('files') as HTMLInputElement;

const conversationHistory: Message[] = [];

const config: ChatConfig = {
  model: 'claude-sonnet-4-5-20250514',
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

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // strip data:...;base64, prefix
      resolve(result.split(',')[1]);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
type UserBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: ImageMediaType; data: string } }
  | { type: 'document'; source: { type: 'base64'; media_type: 'application/pdf'; data: string } };

async function buildUserContent(text: string, files: FileList | null): Promise<string | UserBlock[]> {
  if (!files || files.length === 0) {
    return text;
  }

  const blocks: UserBlock[] = [];
  for (const file of Array.from(files)) {
    const base64 = await readFileAsBase64(file);
    if (file.type.startsWith('image/')) {
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: file.type as ImageMediaType, data: base64 },
      });
    } else if (file.type === 'application/pdf') {
      blocks.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: base64 },
      });
    } else {
      // For non-image, non-PDF files, read as text and include inline
      const textContent = atob(base64);
      blocks.push({ type: 'text', text: `[File: ${file.name}]\n${textContent}` });
    }
  }

  if (text) {
    blocks.push({ type: 'text', text });
  }

  return blocks;
}

async function sendMessage() {
  const text = textarea.value.trim();
  const files = filesInput.files;
  if (!text && (!files || files.length === 0)) return;

  sendBtn.disabled = true;
  textarea.value = '';

  const content = await buildUserContent(text, files);
  filesInput.value = '';

  const userMessage: Message = { role: 'user', content };
  conversationHistory.push(userMessage);

  // Display user message
  const userDiv = appendMessageDiv('user');
  const userText = document.createElement('span');
  userText.textContent = text || '(file attachment)';
  userDiv.appendChild(userText);
  scrollToBottom();

  // Stream assistant response
  await streamChat();
  sendBtn.disabled = false;
  textarea.focus();
}

async function streamChat() {
  const assistantDiv = appendMessageDiv('assistant');
  let textSpan: HTMLSpanElement | null = null;
  let thinkingDetails: HTMLDetailsElement | null = null;
  let thinkingContent: HTMLElement | null = null;

  try {
    const resp = await fetch('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: conversationHistory, config }),
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
        const json = line.slice(6);
        const event: SSEEvent = JSON.parse(json);

        switch (event.type) {
          case 'text_delta':
            if (!textSpan) {
              textSpan = document.createElement('span');
              assistantDiv.appendChild(textSpan);
            }
            textSpan.textContent += event.text;
            scrollToBottom();
            break;

          case 'thinking_delta':
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
            thinkingContent!.textContent += event.thinking;
            scrollToBottom();
            break;

          case 'done':
            conversationHistory.push(event.message);
            break;

          case 'error':
            const errSpan = document.createElement('span');
            errSpan.style.color = 'red';
            errSpan.textContent = `Error: ${event.error}`;
            assistantDiv.appendChild(errSpan);
            scrollToBottom();
            break;
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
