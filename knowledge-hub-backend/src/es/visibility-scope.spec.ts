import {
  buildVisibilityFilter,
  isDocVisible,
  VisibilityScope,
  VisibleDocFields,
} from './visibility-scope';

/** 普通用户作用域（有团队、非 admin、非审核人） */
function userScope(overrides: Partial<VisibilityScope> = {}): VisibilityScope {
  return { userId: 'U1', teamIds: ['T1', 'T2'], isAdmin: false, canReview: false, ...overrides };
}

describe('buildVisibilityFilter（ES 可见性子句）', () => {
  it('普通用户：3 个 should 分支 + minimum_should_match=1，规则 2/3 均带 status=1', () => {
    const f = buildVisibilityFilter(userScope()) as {
      bool: { should: unknown[]; minimum_should_match: number };
    };
    expect(f.bool.minimum_should_match).toBe(1);
    expect(f.bool.should).toHaveLength(3);
    expect(f.bool.should[0]).toEqual({ term: { author_id: 'U1' } });
    expect(f.bool.should[1]).toEqual({
      bool: { filter: [{ term: { status: 1 } }, { term: { is_public: true } }] },
    });
    expect(f.bool.should[2]).toEqual({
      bool: { filter: [{ term: { status: 1 } }, { terms: { team_id: ['T1', 'T2'] } }] },
    });
  });

  it('admin：返回 undefined（不拼 filter）', () => {
    expect(buildVisibilityFilter(userScope({ isAdmin: true }))).toBeUndefined();
  });

  it('teamIds 为空数组：terms 为空数组（自然不命中，无需特判）', () => {
    const f = buildVisibilityFilter(userScope({ teamIds: [] })) as {
      bool: { should: Array<{ bool?: { filter: unknown[] } }> };
    };
    const teamClause = f.bool.should[2].bool?.filter[1] as { terms: { team_id: string[] } };
    expect(teamClause.terms.team_id).toEqual([]);
  });

  it('canReview=true：追加第 4 个分支 status=2（待审核可见）', () => {
    const f = buildVisibilityFilter(userScope({ canReview: true })) as {
      bool: { should: unknown[] };
    };
    expect(f.bool.should).toHaveLength(4);
    expect(f.bool.should[3]).toEqual({ term: { status: 2 } });
  });
});

describe('isDocVisible（单文档可见性判定）', () => {
  const scope = userScope();

  it('规则 1：本人草稿可见（任何状态）', () => {
    expect(
      isDocVisible({ author_id: 'U1', status: 0, is_public: false, team_id: null }, scope),
    ).toBe(true);
  });

  it('规则 1：本人已归档文档仍可见', () => {
    expect(
      isDocVisible({ author_id: 'U1', status: 3, is_public: false, team_id: null }, scope),
    ).toBe(true);
  });

  it('他人草稿不可见', () => {
    expect(
      isDocVisible({ author_id: 'U2', status: 0, is_public: false, team_id: null }, scope),
    ).toBe(false);
  });

  it('规则 2：已发布 + 公开 → 全员可见', () => {
    expect(
      isDocVisible({ author_id: 'U2', status: 1, is_public: true, team_id: null }, scope),
    ).toBe(true);
  });

  it('规则 2：未发布 + 公开 → 不可见（status 必须=1）', () => {
    expect(
      isDocVisible({ author_id: 'U2', status: 0, is_public: true, team_id: null }, scope),
    ).toBe(false);
  });

  it('规则 3：已发布 + 本团队 → 可见', () => {
    expect(
      isDocVisible({ author_id: 'U2', status: 1, is_public: false, team_id: 'T2' }, scope),
    ).toBe(true);
  });

  it('规则 3：已发布 + 他人团队 → 不可见', () => {
    expect(
      isDocVisible({ author_id: 'U2', status: 1, is_public: false, team_id: 'T9' }, scope),
    ).toBe(false);
  });

  it('已发布 + 无团队 + 非公开 → 仅作者/admin 可见', () => {
    const doc: VisibleDocFields = { author_id: 'U2', status: 1, is_public: false, team_id: null };
    expect(isDocVisible(doc, scope)).toBe(false);
    expect(isDocVisible(doc, userScope({ isAdmin: true }))).toBe(true);
  });

  it('待审核：审核人可见、普通人不可见', () => {
    const doc: VisibleDocFields = { author_id: 'U2', status: 2, is_public: false, team_id: null };
    expect(isDocVisible(doc, userScope({ canReview: true }))).toBe(true);
    expect(isDocVisible(doc, scope)).toBe(false);
  });

  it('软删文档：admin 之外均不可见', () => {
    const doc: VisibleDocFields = {
      author_id: 'U1',
      status: 1,
      is_public: true,
      team_id: 'T1',
      deleted: true,
    };
    expect(isDocVisible(doc, scope)).toBe(false);
    expect(isDocVisible(doc, userScope({ isAdmin: true }))).toBe(true);
  });
});
