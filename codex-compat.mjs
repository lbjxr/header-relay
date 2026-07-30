import { randomUUID } from 'node:crypto';

import { getHeader, setHeader } from './lib/header-utils.mjs';

const ALLOWED_BODY_KEYS = new Set([
  'model',
  'input',
  'instructions',
  'tools',
  'tool_choice',
  'stream',
  'store',
  'reasoning',
  'service_tier',
  'include',
  'prompt_cache_key',
  'client_metadata',
  'text'
]);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeContentPart(part) {
  if (typeof part === 'string') return { type: 'input_text', text: part };
  if (!isObject(part)) return part;

  if (part.type === 'text') return { type: 'input_text', text: String(part.text ?? '') };
  if (part.type === 'image_url') {
    const imageUrl = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
    if (!imageUrl) return part;
    const normalized = { type: 'input_image', image_url: imageUrl };
    const detail = isObject(part.image_url) ? part.image_url.detail : part.detail;
    if (detail) normalized.detail = detail;
    return normalized;
  }
  if (part.type === 'input_image' && isObject(part.image_url)) {
    const normalized = { ...part, image_url: part.image_url.url };
    if (!normalized.detail && part.image_url.detail) normalized.detail = part.image_url.detail;
    return normalized;
  }
  return part;
}

function normalizeMessageContent(content) {
  if (typeof content === 'string') return [{ type: 'input_text', text: content }];
  if (Array.isArray(content)) return content.map(normalizeContentPart);
  if (content === undefined || content === null) return [];
  return [normalizeContentPart(content)];
}

function normalizeInputItem(item) {
  if (typeof item === 'string') {
    return {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: item }]
    };
  }
  if (!isObject(item)) return item;

  const normalized = structuredClone(item);
  if (normalized.type === 'additional_tools') {
    delete normalized.content;
    if (normalized.role === 'system') normalized.role = 'developer';
    return normalized;
  }

  if (normalized.type === 'message' || normalized.role) {
    if (!normalized.type) normalized.type = 'message';
    if (normalized.role === 'system') normalized.role = 'developer';
    normalized.content = normalizeMessageContent(normalized.content);
  }
  return normalized;
}

function normalizeInput(input) {
  if (typeof input === 'string') return [normalizeInputItem(input)];
  if (!Array.isArray(input) || input.length === 0) {
    return [{
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '...' }]
    }];
  }
  return input.map(normalizeInputItem);
}

function normalizeFunctionTool(tool) {
  const source = isObject(tool.function) ? tool.function : tool;
  const name = typeof source.name === 'string' ? source.name.trim() : '';
  if (!name) return null;

  const normalized = {
    type: 'function',
    name: name.slice(0, 128),
    parameters: isObject(source.parameters)
      ? structuredClone(source.parameters)
      : { type: 'object', properties: {} }
  };
  if (typeof source.description === 'string' && source.description) {
    normalized.description = source.description;
  }
  if (typeof source.strict === 'boolean') normalized.strict = source.strict;
  return normalized;
}

function normalizeTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  return tools.flatMap((tool) => {
    if (!isObject(tool)) return [];
    if (tool.type === 'function') {
      const normalized = normalizeFunctionTool(tool);
      return normalized ? [normalized] : [];
    }
    return [structuredClone(tool)];
  });
}

function normalizeToolChoice(toolChoice) {
  if (typeof toolChoice === 'string') return toolChoice;
  if (!isObject(toolChoice)) return 'auto';
  if (toolChoice.type === 'function') {
    const name = typeof toolChoice.name === 'string'
      ? toolChoice.name.trim()
      : typeof toolChoice.function?.name === 'string'
        ? toolChoice.function.name.trim()
        : '';
    return name ? { type: 'function', name } : 'auto';
  }
  return structuredClone(toolChoice);
}

function isNativeCodexRequest(body) {
  if (isObject(body.client_metadata)) return true;
  return Array.isArray(body.input)
    && body.input.some((item) => isObject(item) && item.type === 'additional_tools');
}

function mergeInstructions(relayInstructions, requestInstructions, nativeRequest) {
  const relay = typeof relayInstructions === 'string' ? relayInstructions.trim() : '';
  const request = typeof requestInstructions === 'string' ? requestInstructions.trim() : '';
  if (nativeRequest) return request || relay;
  if (!relay) return request;
  if (!request || request === relay) return relay;
  if (request.startsWith(`${relay}\n`)) return request;
  return `${relay}\n\n${request}`;
}

function normalizeReasoning(body, defaultEffort) {
  const source = isObject(body.reasoning) ? body.reasoning : {};
  let effort = source.effort ?? body.reasoning_effort ?? defaultEffort ?? 'low';
  if (effort === 'max') effort = 'xhigh';
  if (!['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(effort)) effort = 'low';
  const summary = typeof source.summary === 'string' && source.summary ? source.summary : 'auto';
  return { effort, summary };
}

function selectSessionId(body, headers, requestId) {
  const candidates = [
    getHeader(headers, 'session_id'),
    getHeader(headers, 'session-id'),
    body.prompt_cache_key,
    body.session_id,
    body.conversation_id,
    body.client_metadata?.session_id,
    requestId
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return randomUUID();
}

export function normalizeCodexRequest(inputBody, options = {}) {
  if (!isObject(inputBody)) throw new TypeError('Codex request body must be a JSON object');

  const body = structuredClone(inputBody);
  const headers = { ...(options.headers || {}) };
  const sessionId = selectSessionId(body, headers, options.requestId);
  const nativeRequest = isNativeCodexRequest(body);

  body.input = normalizeInput(body.input);
  body.instructions = mergeInstructions(options.instructions, body.instructions, nativeRequest);
  const tools = normalizeTools(body.tools);
  if (tools !== undefined) body.tools = tools;
  body.tool_choice = normalizeToolChoice(body.tool_choice);
  body.stream = true;
  body.store = false;
  body.reasoning = normalizeReasoning(body, options.reasoningEffort);
  body.include = ['reasoning.encrypted_content'];
  body.prompt_cache_key = sessionId;
  body.text = isObject(body.text) ? { ...body.text } : {};
  if (!body.text.verbosity) body.text.verbosity = options.verbosity || 'low';
  if (body.service_tier === 'fast') body.service_tier = 'priority';
  if (body.service_tier && body.service_tier !== 'priority') delete body.service_tier;

  for (const key of Object.keys(body)) {
    if (!ALLOWED_BODY_KEYS.has(key)) delete body[key];
  }

  setHeader(headers, 'User-Agent', options.userAgent || 'codex_cli_rs/0.136.0');
  setHeader(headers, 'originator', options.originator || 'codex_cli_rs');
  setHeader(headers, 'session_id', sessionId);
  setHeader(headers, 'Accept', 'text/event-stream');

  return { body, headers, sessionId, nativeRequest };
}
