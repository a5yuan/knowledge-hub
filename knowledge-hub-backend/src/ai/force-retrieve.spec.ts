import { shouldForceRetrieve } from './force-retrieve';

/**
 * 工单 24 P0：预检索为空时代调检索的判定边界。
 *
 * 五个条件是「与」关系，任何一条不满足都不该多花一次检索 —— 逐条钉住。
 */
describe('shouldForceRetrieve（预检索为空 → 代调检索）', () => {
  /** 标准触发场景：知识库意图、需要检索、非闲聊、预检索 0 条、开关打开 */
  const base = {
    enabled: true,
    intentAllowsKb: true,
    needRetrieve: true,
    isChitchat: false,
    kbItemCount: 0,
  };

  it('标准场景：触发', () => {
    expect(shouldForceRetrieve(base)).toBe(true);
  });

  it('开关关闭：不触发（可用于线上快速止血）', () => {
    expect(shouldForceRetrieve({ ...base, enabled: false })).toBe(false);
  });

  it('闲聊/偏好类意图（不允许查知识库）：不触发', () => {
    expect(shouldForceRetrieve({ ...base, intentAllowsKb: false })).toBe(false);
  });

  it('意图路由判定不需要检索：不触发', () => {
    expect(shouldForceRetrieve({ ...base, needRetrieve: false })).toBe(false);
  });

  it('路由自相矛盾（needRetrieve=true 但 isChitchat=true）：不触发', () => {
    expect(shouldForceRetrieve({ ...base, isChitchat: true })).toBe(false);
  });

  it('预检索已经命中：不触发（这正是「不调工具也合理」的情形）', () => {
    expect(shouldForceRetrieve({ ...base, kbItemCount: 1 })).toBe(false);
    expect(shouldForceRetrieve({ ...base, kbItemCount: 5 })).toBe(false);
  });
});
