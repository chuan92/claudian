import {
  buildTitleGenerationPrompt,
  TITLE_GENERATION_SYSTEM_PROMPT,
} from '@/core/prompt/titleGeneration';

describe('titleGeneration', () => {
  it('exports a non-empty system prompt string', () => {
    expect(typeof TITLE_GENERATION_SYSTEM_PROMPT).toBe('string');
    expect(TITLE_GENERATION_SYSTEM_PROMPT.length).toBeGreaterThan(0);
  });

  it('includes the max character constraint', () => {
    expect(TITLE_GENERATION_SYSTEM_PROMPT).toContain('max 50 chars');
  });

  it('instructs to start with a strong verb', () => {
    expect(TITLE_GENERATION_SYSTEM_PROMPT).toContain('strong verb');
  });

  it('instructs to return only the raw title text', () => {
    expect(TITLE_GENERATION_SYSTEM_PROMPT).toContain('ONLY the raw title text');
  });

  it('instructs to match the language of the user request', () => {
    expect(TITLE_GENERATION_SYSTEM_PROMPT.toLowerCase()).toContain('language');
  });

  describe('buildTitleGenerationPrompt', () => {
    it('wraps the user request', () => {
      const prompt = buildTitleGenerationPrompt('Explain this paper');
      expect(prompt).toContain('Explain this paper');
      expect(prompt).toContain('Generate a title for this conversation:');
    });

    it('truncates very long user messages', () => {
      const prompt = buildTitleGenerationPrompt('x'.repeat(1000));
      expect(prompt).toContain('x'.repeat(500) + '...');
      expect(prompt).not.toContain('x'.repeat(501));
    });

    it('omits the note line when no note context is provided', () => {
      const prompt = buildTitleGenerationPrompt('Explain this paper');
      expect(prompt).not.toContain('Note in context');
    });

    it('includes the note name when a note path is provided', () => {
      const prompt = buildTitleGenerationPrompt('深入浅出解读这篇论文', {
        notePath: 'papers/Attention Is All You Need.md',
      });
      expect(prompt).toContain('Attention Is All You Need');
      expect(prompt).not.toContain('papers/');
      expect(prompt).not.toContain('.md');
    });
  });
});
