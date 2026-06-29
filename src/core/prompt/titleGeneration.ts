const MAX_TITLE_INPUT_LENGTH = 500;
const MAX_TITLE_LENGTH = 50;

export interface TitleGenerationPromptContext {
  /** Path or name of the note/document in context, used to ground vague references. */
  notePath?: string;
}

export const TITLE_GENERATION_SYSTEM_PROMPT = `You are a specialist in summarizing user intent into a short conversation title.

**Task**: Generate a **concise, descriptive title** (max 50 chars) that names the specific subject of the user's request.

**Rules**:
1.  **Language**: Write the title in the SAME language the user wrote in. A Chinese request gets a Chinese title; an English request gets an English title. Never translate.
2.  **Be specific**: Name the actual subject. When the request points at a note, paper, or document (e.g. "this paper", "本文", "这篇论文") and a "Note in context" is provided, use that note's name instead of a vague word like "paper" or "document".
3.  **Structure**: Start with a **strong verb** describing the action (e.g. Explain / 解读, Fix / 修复, Analyze / 分析).
4.  **Format**: Sentence case. No surrounding quotes. No trailing punctuation.
5.  **Forbidden**: "Conversation with...", "Help me...", "Question about...", "I need...".
6.  **Tech context**: If code is present, include the primary language/framework (e.g. "Debug Python script", "Refactor React hook").

**Output**: Return ONLY the raw title text.`;

function noteDisplayName(notePath: string): string {
  const base = notePath.split(/[\\/]/).pop() ?? notePath;
  return base.replace(/\.md$/i, '').trim();
}

export function buildTitleGenerationPrompt(
  userMessage: string,
  context?: TitleGenerationPromptContext,
): string {
  const truncated = userMessage.length > MAX_TITLE_INPUT_LENGTH
    ? `${userMessage.slice(0, MAX_TITLE_INPUT_LENGTH)}...`
    : userMessage;
  const noteName = context?.notePath ? noteDisplayName(context.notePath) : '';
  const noteLine = noteName ? `\n\nNote in context: ${noteName}` : '';
  return `User's request:\n"""\n${truncated}\n"""${noteLine}\n\nGenerate a title for this conversation:`;
}

export function parseTitleGenerationResponse(responseText: string): string | null {
  const trimmed = responseText.trim();
  if (!trimmed) {
    return null;
  }

  let title = trimmed;
  if (
    (title.startsWith('"') && title.endsWith('"'))
    || (title.startsWith("'") && title.endsWith("'"))
  ) {
    title = title.slice(1, -1);
  }

  title = title.replace(/[.!?:;,]+$/, '');

  if (title.length > MAX_TITLE_LENGTH) {
    title = `${title.slice(0, MAX_TITLE_LENGTH - 3)}...`;
  }

  return title || null;
}
