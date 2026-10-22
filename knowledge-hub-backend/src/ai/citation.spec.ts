import {
  CitationStreamFilter,
  findInvalidCitations,
  stripCitationMarkers,
} from './citation';

/**
 * 工单 24 P0 的纯函数单测。
 *
 * 为什么这两个值得测：编排层的其它逻辑都要起后端 + 打模型才能验，
 * 而这两个是「答案文本 → 判定」的纯函数，越界引用又恰好是已确认的真缺陷，
 * 不测等于把唯一能确定的部分也交给运气。
 */
describe('stripCitationMarkers（注入历史时剥离旧编号）', () => {
  it('剥掉数字标记', () => {
    expect(stripCitationMarkers('加班餐补上限 500 元 [1]。')).toBe(
      '加班餐补上限 500 元 。',
    );
  });

  it('剥掉多个标记，保留正文与其它方括号', () => {
    expect(stripCitationMarkers('A [1] B [12] C [备注]')).toBe(
      'A  B  C [备注]',
    );
  });

  it('剥掉 web 局部编号 [W1]', () => {
    expect(stripCitationMarkers('钢材价格回升（来源: 某某网）[W2]')).toBe(
      '钢材价格回升（来源: 某某网）',
    );
  });

  it('不误伤其它数字：4 位以上、[n,m] 形式都不动', () => {
    expect(stripCitationMarkers('编号 [1234] 与 [1,2]')).toBe(
      '编号 [1234] 与 [1,2]',
    );
  });

  it('幂等：连续调用两次结果相同', () => {
    const once = stripCitationMarkers('文本 [1] [W3] 结束');
    expect(stripCitationMarkers(once)).toBe(once);
  });
});

describe('findInvalidCitations（越界引用编号检测）', () => {
  it('全部合法时返回空数组', () => {
    expect(findInvalidCitations('甲 [1] 乙 [2]', 2)).toEqual([]);
  });

  it('只有 1 条来源却引 [3] —— s05 实测到的那一例', () => {
    expect(findInvalidCitations('试用期为 6 个月 [3]。', 1)).toEqual([3]);
  });

  it('混合合法与越界，只报越界的并升序去重', () => {
    expect(findInvalidCitations('[1] [9] [2] [9] [0]', 3)).toEqual([0, 9]);
  });

  it('来源为 0 时任何数字标记都算越界', () => {
    expect(findInvalidCitations('结论 [1]', 0)).toEqual([1]);
  });

  it('空答案返回空数组', () => {
    expect(findInvalidCitations('', 5)).toEqual([]);
  });

  it('[Wn] 走 web 局部编号映射，不计入越界', () => {
    expect(findInvalidCitations('（来源: 某某）[W1]', 0)).toEqual([]);
  });
});

describe('CitationStreamFilter（流式丢弃越界编号）', () => {
  const mk = (max: number | (() => number)) => {
    const get = typeof max === 'function' ? max : () => max;
    return new CitationStreamFilter(get);
  };

  it('合法编号原样下发', () => {
    expect(mk(2).push('试用期 6 个月 [1]。')).toBe('试用期 6 个月 [1]。');
  });

  it('越界编号在下发前就被丢掉，正文不动', () => {
    const f = mk(1);
    expect(f.push('试用期 6 个月 [3]。')).toBe('试用期 6 个月 。');
  });

  it('编号被拆在两个 delta 里也能判出来', () => {
    const f = mk(1);
    expect(f.push('试用期 [')).toBe('试用期 ');
    expect(f.push('3] 结束')).toBe(' 结束');
  });

  it('拆分时合法编号不丢', () => {
    const f = mk(3);
    expect(f.push('见 [')).toBe('见 ');
    expect(f.push('2] 段')).toBe('[2] 段');
  });

  it('[备注]、[W1]、[1,2] 这类不算引用，原样放行', () => {
    const f = mk(0);
    expect(f.push('[备注] [W1] [1,2]')).toBe('[备注] [W1] [1,2]');
  });

  it('合法上限实时变化：先来的越界、后来的合法', () => {
    let max = 0;
    const f = mk(() => max);
    expect(f.push('甲 [1]')).toBe('甲 ');
    max = 2;
    expect(f.push('乙 [1]')).toBe('乙 [1]');
  });

  it('统计被丢掉的越界编号个数（否则无法区分「没编」和「编了被吞」）', () => {
    const f = mk(1);
    f.push('甲 [2] 乙 [3] 丙 [1]');
    expect(f.droppedCount).toBe(2);
  });

  it('合法上限为 0 时，每个编号都计入丢弃', () => {
    const f = mk(0);
    f.push('[1] [2]');
    expect(f.droppedCount).toBe(2);
  });

  it('flush 吐出未闭合的残留（否则末字被吞）', () => {
    const f = mk(1);
    expect(f.push('尾巴 [')).toBe('尾巴 ');
    expect(f.flush()).toBe('[');
    expect(f.flush()).toBe('');
  });

  it('纯文本多 chunk 拼接后与原文一致', () => {
    const f = mk(5);
    const parts = ['结论：', '试用期', '为 6 个月', '。'];
    const out = parts.map((p) => f.push(p)).join('') + f.flush();
    expect(out).toBe('结论：试用期为 6 个月。');
  });
});
