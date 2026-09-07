import { getObsidianContextPrompt } from '@/core/prompt/mainAgent';
import { buildCodexSystemPrompt } from '@/providers/codex/prompt/mainAgent';

describe('buildCodexSystemPrompt', () => {
  it('reuses the shared Obsidian context and preserves user configuration', () => {
    const prompt = buildCodexSystemPrompt({
      vaultPath: '/home/user/My Vault',
      mediaFolder: '  note assets  ',
      userName: '  Alice  ',
      customPrompt: '  Answer in Chinese.  ',
    });

    expect(prompt).toContain(getObsidianContextPrompt());
    expect(prompt).toContain('Vault absolute path: /home/user/My Vault');
    expect(prompt).toContain('You are collaborating with **Alice**.');
    expect(prompt).toContain('Media folder: `note assets`');
    expect(prompt.endsWith('## Custom Instructions\n\nAnswer in Chinese.')).toBe(true);
  });

  it('uses runtime tools and permissions without legacy Claude assumptions', () => {
    const prompt = buildCodexSystemPrompt();

    expect(prompt).toContain('You are Codex, running inside Claudian');
    expect(prompt).toContain('Relative and absolute paths');
    expect(prompt).toContain('runtime sandbox and approval policy');
    expect(prompt).toContain('tools actually available in this session');
    for (const legacy of ['Read file_path=', 'WebFetch', 'bash: date', 'absolute path will FAIL', 'curl']) {
      expect(prompt).not.toContain(legacy);
    }
  });

  it('sets autonomous work and concise communication defaults within the requested scope', () => {
    const prompt = buildCodexSystemPrompt();

    expect(prompt).toContain('Carry authorized work through to completion');
    expect(prompt).toContain('Plan mode');
    expect(prompt).toContain('source notes unchanged');
    expect(prompt).toContain('Only download remote images into the vault or rewrite embeds when requested');
    expect(prompt).toContain('user instructions take precedence over skill guidelines');
    expect(prompt).toContain('exact file and instruction');
    expect(prompt).toContain('clear, concise paragraphs');
    expect(prompt).toContain('smallest meaningful checks');
  });

  it.each([{}, { userName: '  ', customPrompt: '  ', mediaFolder: '  ' }])(
    'omits empty customization and uses the vault root for media (%j)',
    (settings) => {
      const prompt = buildCodexSystemPrompt(settings);

      expect(prompt).not.toContain('## User Context');
      expect(prompt).not.toContain('## Custom Instructions');
      expect(prompt).not.toContain('Vault absolute path:');
      expect(prompt).toContain('Media folder: `.`');
    },
  );
});
