import type { ChatMessage, ContentBlock, ToolCallInfo } from '../../../core/types';
import type {
  AcpContentBlock,
  AcpSessionUpdate,
  AcpToolCall,
  AcpToolCallStatus,
  AcpToolCallUpdate,
} from '../../acp';
import { renderAcpContentBlock } from '../../acp/AcpSessionUpdateNormalizer';
import { stripCursorSystemInstructions } from '../runtime/buildCursorPrompt';

interface MutableAssistantMessage extends ChatMessage {
  contentBlocks: ContentBlock[];
  toolCalls: ToolCallInfo[];
}

export class CursorHistoryAccumulator {
  private assistantCount = 0;
  private readonly messages: ChatMessage[] = [];
  private readonly tools = new Map<string, ToolCallInfo>();
  private userCount = 0;

  constructor(
    private readonly sessionId: string,
    private readonly baseTimestamp = Date.now(),
  ) {}

  push(update: AcpSessionUpdate): void {
    switch (update.sessionUpdate) {
      case 'user_message_chunk':
        this.appendUserContent(update.content, update.messageId);
        return;
      case 'agent_message_chunk':
        this.appendAssistantContent('text', update.content, update.messageId);
        return;
      case 'agent_thought_chunk':
        this.appendAssistantContent('thinking', update.content, update.messageId);
        return;
      case 'tool_call':
        this.applyToolCall(update);
        return;
      case 'tool_call_update':
        this.applyToolCallUpdate(update);
        return;
      default:
        return;
    }
  }

  toMessages(): ChatMessage[] {
    const messages = this.messages.map((message) => {
      if (message.role === 'user') {
        return { ...message };
      }
      const assistant = message as MutableAssistantMessage;
      return {
        ...assistant,
        contentBlocks: assistant.contentBlocks.length > 0
          ? assistant.contentBlocks.map(block => ({ ...block }))
          : undefined,
        toolCalls: assistant.toolCalls.length > 0
          ? assistant.toolCalls.map(toolCall => ({ ...toolCall, input: { ...toolCall.input } }))
          : undefined,
      };
    });

    const firstUserMessage = messages.find(message => message.role === 'user');
    if (firstUserMessage) {
      firstUserMessage.content = stripCursorSystemInstructions(firstUserMessage.content);
    }
    return messages;
  }

  private appendUserContent(content: AcpContentBlock, messageId?: string | null): void {
    const text = renderAcpContentBlock(content);
    if (!text) {
      return;
    }

    const previous = this.messages[this.messages.length - 1];
    if (
      previous?.role === 'user'
      && (!messageId || previous.userMessageId === messageId)
    ) {
      previous.content += text;
      return;
    }

    this.userCount += 1;
    const id = messageId?.trim() || `${this.sessionId}-user-${this.userCount}`;
    this.messages.push({
      content: text,
      id,
      role: 'user',
      timestamp: this.nextTimestamp(),
      userMessageId: messageId?.trim() || undefined,
    });
  }

  private appendAssistantContent(
    type: 'text' | 'thinking',
    content: AcpContentBlock,
    messageId?: string | null,
  ): void {
    const text = renderAcpContentBlock(content);
    if (!text) {
      return;
    }

    const message = this.ensureAssistantMessage(messageId);
    if (type === 'text') {
      message.content += text;
    }
    appendContentBlock(message.contentBlocks, { type, content: text });
  }

  private applyToolCall(toolCall: AcpToolCall): void {
    const message = this.ensureAssistantMessage();
    const existing = this.tools.get(toolCall.toolCallId);
    const mapped = existing ?? {
      id: toolCall.toolCallId,
      input: normalizeToolInput(toolCall.rawInput),
      name: normalizeToolName(toolCall.title, toolCall.kind),
      status: mapToolStatus(toolCall.status),
    };

    mapped.input = toolCall.rawInput === undefined
      ? mapped.input
      : normalizeToolInput(toolCall.rawInput);
    mapped.name = normalizeToolName(toolCall.title, toolCall.kind);
    mapped.status = mapToolStatus(toolCall.status);
    const result = renderToolResult(toolCall.content, toolCall.rawOutput);
    if (result) {
      mapped.result = result;
    }
    this.attachTool(message, mapped);
  }

  private applyToolCallUpdate(update: AcpToolCallUpdate): void {
    const message = this.ensureAssistantMessage();
    const existing = this.tools.get(update.toolCallId) ?? {
      id: update.toolCallId,
      input: {},
      name: normalizeToolName(update.title, update.kind),
      status: 'running' as const,
    };

    if (update.rawInput !== undefined) {
      existing.input = normalizeToolInput(update.rawInput);
    }
    if (update.title || update.kind) {
      existing.name = normalizeToolName(update.title, update.kind);
    }
    if (update.status !== undefined) {
      existing.status = mapToolStatus(update.status);
    }
    const result = renderToolResult(update.content, update.rawOutput);
    if (result) {
      existing.result = result;
    }
    this.attachTool(message, existing);
  }

  private attachTool(message: MutableAssistantMessage, toolCall: ToolCallInfo): void {
    this.tools.set(toolCall.id, toolCall);
    if (!message.toolCalls.some(entry => entry.id === toolCall.id)) {
      message.toolCalls.push(toolCall);
      message.contentBlocks.push({ type: 'tool_use', toolId: toolCall.id });
    }
  }

  private ensureAssistantMessage(messageId?: string | null): MutableAssistantMessage {
    const previous = this.messages[this.messages.length - 1];
    if (
      previous?.role === 'assistant'
      && (!messageId || previous.assistantMessageId === messageId || !previous.assistantMessageId)
    ) {
      if (messageId && !previous.assistantMessageId) {
        previous.assistantMessageId = messageId;
      }
      return previous as MutableAssistantMessage;
    }

    this.assistantCount += 1;
    const id = messageId?.trim() || `${this.sessionId}-assistant-${this.assistantCount}`;
    const message: MutableAssistantMessage = {
      assistantMessageId: messageId?.trim() || undefined,
      content: '',
      contentBlocks: [],
      id,
      role: 'assistant',
      timestamp: this.nextTimestamp(),
      toolCalls: [],
    };
    this.messages.push(message);
    return message;
  }

  private nextTimestamp(): number {
    return this.baseTimestamp + this.messages.length;
  }
}

function appendContentBlock(
  blocks: ContentBlock[],
  block: Extract<ContentBlock, { type: 'text' | 'thinking' }>,
): void {
  const previous = blocks[blocks.length - 1];
  if (previous?.type === block.type && (previous.type === 'text' || previous.type === 'thinking')) {
    previous.content += block.content;
    return;
  }
  blocks.push(block);
}

function normalizeToolInput(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : value === undefined
    ? {}
    : { value };
}

function normalizeToolName(title?: string | null, kind?: string | null): string {
  return title?.trim() || kind?.trim() || 'tool';
}

function mapToolStatus(status?: AcpToolCallStatus | null): ToolCallInfo['status'] {
  if (status === 'completed') {
    return 'completed';
  }
  if (status === 'failed') {
    return 'error';
  }
  return 'running';
}

function renderToolResult(
  content: AcpToolCall['content'] | AcpToolCallUpdate['content'],
  rawOutput: unknown,
): string {
  if (Array.isArray(content) && content.length > 0) {
    return content.map((entry) => {
      if (entry.type === 'content') {
        return renderAcpContentBlock(entry.content);
      }
      if (entry.type === 'diff') {
        return `Diff: ${entry.path}`;
      }
      return `Terminal: ${entry.terminalId}`;
    }).filter(Boolean).join('\n\n');
  }
  if (typeof rawOutput === 'string') {
    return rawOutput;
  }
  if (rawOutput === undefined) {
    return '';
  }
  try {
    return JSON.stringify(rawOutput, null, 2) ?? '';
  } catch {
    return '[unserializable]';
  }
}
