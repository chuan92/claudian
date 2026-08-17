import type { ChatTurnRequest } from '../../../core/runtime/types';
import type { ChatMessage } from '../../../core/types';
import { appendBrowserContext } from '../../../utils/browser';
import { appendCanvasContext } from '../../../utils/canvas';
import { appendCurrentNote } from '../../../utils/context';
import { appendEditorContext } from '../../../utils/editor';
import { buildContextFromHistory, buildPromptWithHistoryContext } from '../../../utils/session';
import type { AcpContentBlock } from '../../acp';

export const CURSOR_SYSTEM_INSTRUCTIONS_OPEN = '<claudian_system_instructions>';
export const CURSOR_SYSTEM_INSTRUCTIONS_CLOSE = '</claudian_system_instructions>';

export function buildCursorPromptText(
  request: ChatTurnRequest,
  conversationHistory: ChatMessage[] = [],
): string {
  let prompt = request.text;

  if (request.currentNotePath) {
    prompt = appendCurrentNote(prompt, request.currentNotePath);
  }
  if (request.editorSelection && request.editorSelection.mode !== 'none') {
    prompt = appendEditorContext(prompt, request.editorSelection);
  }
  if (request.browserSelection) {
    prompt = appendBrowserContext(prompt, request.browserSelection);
  }
  if (request.canvasSelection) {
    prompt = appendCanvasContext(prompt, request.canvasSelection);
  }
  if (conversationHistory.length > 0) {
    const historyContext = buildContextFromHistory(conversationHistory);
    prompt = buildPromptWithHistoryContext(
      historyContext,
      prompt,
      prompt,
      conversationHistory,
    );
  }

  return prompt;
}

export function buildCursorPromptBlocks(
  request: ChatTurnRequest,
  conversationHistory: ChatMessage[] = [],
  systemInstructions?: string,
): AcpContentBlock[] {
  const prompt = buildCursorPromptText(request, conversationHistory);
  const text = systemInstructions?.trim()
    ? wrapCursorPromptWithSystemInstructions(systemInstructions, prompt)
    : prompt;
  const blocks: AcpContentBlock[] = [{ type: 'text', text }];

  for (const image of request.images ?? []) {
    if (image.data) {
      blocks.push({
        data: image.data,
        mimeType: image.mediaType,
        type: 'image',
      });
    }
  }

  return blocks;
}

export function wrapCursorPromptWithSystemInstructions(
  systemInstructions: string,
  prompt: string,
): string {
  return `${CURSOR_SYSTEM_INSTRUCTIONS_OPEN}\n${systemInstructions.trim()}\n${CURSOR_SYSTEM_INSTRUCTIONS_CLOSE}\n\n${prompt}`;
}

export function stripCursorSystemInstructions(prompt: string): string {
  const start = prompt.indexOf(CURSOR_SYSTEM_INSTRUCTIONS_OPEN);
  if (start < 0) {
    return prompt;
  }
  const end = prompt.indexOf(CURSOR_SYSTEM_INSTRUCTIONS_CLOSE, start);
  if (end < 0) {
    return prompt;
  }

  return `${prompt.slice(0, start)}${prompt.slice(end + CURSOR_SYSTEM_INSTRUCTIONS_CLOSE.length)}`
    .trimStart();
}
