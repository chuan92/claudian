import { QueryBackedInstructionRefineService } from '../../../core/auxiliary/QueryBackedInstructionRefineService';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { CursorAuxQueryRunner } from '../runtime/CursorAuxQueryRunner';

export class CursorInstructionRefineService extends QueryBackedInstructionRefineService {
  constructor(plugin: ProviderHost) {
    super(new CursorAuxQueryRunner(plugin));
  }
}
