import { QueryBackedTitleGenerationService } from '../../../core/auxiliary/QueryBackedTitleGenerationService';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { decodeCursorModelId } from '../models';
import { CursorAuxQueryRunner } from '../runtime/CursorAuxQueryRunner';
import { cursorChatUIConfig } from '../ui/CursorChatUIConfig';

export class CursorTitleGenerationService extends QueryBackedTitleGenerationService {
  constructor(plugin: ProviderHost) {
    super({
      createRunner: () => new CursorAuxQueryRunner(plugin),
      resolveModel: () => {
        const settings = plugin.settings as unknown as Record<string, unknown>;
        const titleModel = typeof settings.titleGenerationModel === 'string'
          ? settings.titleGenerationModel
          : '';
        return cursorChatUIConfig.ownsModel(titleModel, settings)
          ? decodeCursorModelId(titleModel) ?? undefined
          : undefined;
      },
    });
  }
}
