import { getEncoding, getEncodingNameForModel } from 'js-tiktoken';

let modelName = getEncodingNameForModel('gpt-4');
let encoder = getEncoding(modelName);

let tokensPerMessage = 3; // fpr gpt-4; 3.5 is 4 per https://github.com/openai/openai-cookbook/blob/41a5d394ca355e276ba21290696116c33f55ad9f/examples/How_to_count_tokens_with_tiktoken.ipynb

export function countTokens(messages) {
  let count = 0;
  for (let message of messages) {
    count += tokensPerMessage;
    for (let [key, value] of Object.entries(message)) {
      count += encoder.encode(value, 'all').length;
      if (key === 'name') {
        count += 1; // tokens_per_name
      }
    }
  }
  count += 3; // every reply is primed with <|start|>assistant<|message|>
  return count;
}
