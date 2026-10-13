import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleBridgeOperation } from '../browser-companion/bridge-operations.js';
import { companionApiUrl } from '../browser-companion/bridge-origin.js';
import { projectStorageKey } from '../browser-companion/project-context.js';
const project = { workspaceId: 'aaaaaaaaaaaa', bridgeOrigin: 'https://bridge.test' };
const hash = '1'.repeat(64);
const formatKey = projectStorageKey(project.workspaceId, 'c2c.panel.format.v1');
function storage(rows: Record<string, any>) {
  vi.stubGlobal('chrome', { storage: { local: {
    get: async (keys: string|string[]) => Object.fromEntries((typeof keys === 'string' ? [keys] : keys).map(k => [k, rows[k]])),
    set: async (next: any) => Object.assign(rows, next), remove: async (keys: string|string[]) => { for (const k of typeof keys === 'string' ? [keys] : keys) delete rows[k]; },
  } } });
}
afterEach(() => vi.unstubAllGlobals());
describe('轻量任务面板 Bridge 转发', () => {
  it('保留服务端拒绝，结果查询路径可达', async () => {
    storage({});
    const request = vi.fn(async () => ({ ok: false, status: 403, body: { error: 'PANEL_LOCAL_AUTHORIZATION_REQUIRED' } }));
    expect(await handleBridgeOperation({ type: 'c2c.operations.action', phase: 'preview', request: {} }, {}, { project, request })).toMatchObject({ ok: false, reason: 'PANEL_LOCAL_AUTHORIZATION_REQUIRED' });
    for (const endpoint of ['/operations/preview', '/operations/confirm', '/operations/reconcile', '/operations/result?requestId=11111111-1111-4111-8111-111111111111'])
      expect(companionApiUrl(project.bridgeOrigin, endpoint)).toContain(endpoint);
  });
  it('确认响应丢失后用原标识查询，格式化完成仅清当前 workspace 历史', async () => {
    const localHistory = projectStorageKey(project.workspaceId, 'c2c_companion_journal_v1');
    const foreignHistory = projectStorageKey('bbbbbbbbbbbb', 'c2c_companion_journal_v1');
    const transport = projectStorageKey(project.workspaceId, 'c2c_companion_transport_v1');
    const rows: Record<string, any> = { [localHistory]: { state: 'OUTCOME_UNKNOWN' }, [foreignHistory]: 'keep', [transport]: 'credential' };
    storage(rows);
    await expect(handleBridgeOperation({ type: 'c2c.operations.format', phase: 'confirm', confirmationSha256: hash }, {}, { project, request: async () => { throw new Error('lost'); } })).rejects.toThrow('lost');
    expect(rows[formatKey].confirmationSha256).toBe(hash);
    const request = vi.fn(async () => ({ ok: true, status: 200, body: { workspaceId: project.workspaceId, confirmationSha256: hash, status: 'cleaned' } }));
    expect(await handleBridgeOperation({ type: 'c2c.operations.format', phase: 'check' }, {}, { project, request })).toMatchObject({ ok: true, status: 'cleaned' });
    expect(request.mock.calls[0][0]).toBe(`/operations/format/result?confirmationSha256=${hash}`);
    expect(rows[formatKey]).toBeUndefined(); expect(rows[localHistory]).toBeUndefined();
    expect(rows[foreignHistory]).toBe('keep'); expect(rows[transport]).toBe('credential');
  });
});
