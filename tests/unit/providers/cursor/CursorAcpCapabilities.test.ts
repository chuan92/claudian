import { CURSOR_ACP_CLIENT_CAPABILITIES } from '@/providers/cursor/runtime/CursorAcpCapabilities';

describe('CURSOR_ACP_CLIENT_CAPABILITIES', () => {
  it('requests Cursor parameterized model controls', () => {
    expect(CURSOR_ACP_CLIENT_CAPABILITIES).toEqual({
      _meta: { parameterizedModelPicker: true },
    });
  });
});
