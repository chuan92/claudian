import { QueryBackedInlineEditService } from '../../../core/auxiliary/QueryBackedInlineEditService';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { CursorAuxQueryRunner } from '../runtime/CursorAuxQueryRunner';

export class CursorInlineEditService extends QueryBackedInlineEditService {
  constructor(plugin: ProviderHost) {
    super(new CursorAuxQueryRunner(plugin));
  }
}
