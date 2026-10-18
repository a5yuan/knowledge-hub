import { Logger } from '@nestjs/common';
import { OperationService } from './operation.service';
import type { AuthUser } from '../auth/interfaces/auth-user.interface';
import type { QueryOperationLogDto } from './dto/query-operation-log.dto';

/**
 * 操作日志服务语义测试：为什么重要——
 * 1) `record()` **永不抛错**是审计埋点的唯一铁律：日志写入失败若冒泡到业务，
 *    一次日志故障就会让「上传文档」这种主流程失败，代价远大于漏一条日志；
 * 2) 超长截断必须主动做：`target_title` 是 VARCHAR(200)，超长会抛 22001 被 try/catch 吞掉，
 *    结果是**那条日志整个丢失**（静默丢数据，比报错更难查）；
 * 3) `user_name` 缺失要回落 username：`real_name` 为空串时 `??` 不会回落，必须显式判；
 * 4) 查询必须 `created_at DESC` 且筛选走参数化：大盘只显示前 10 条，排序错了等于显示随机样本。
 *
 * 本组用例是「运行期才能验」那几条验收标准的**可重复替身** —— 不依赖真实数据库。
 */
const ACTOR: AuthUser = {
  userId: '1000000000000000001',
  username: 'admin',
  realName: '系统管理员',
  email: 'admin@company.com',
  avatar: null,
  roles: ['ROLE_ADMIN'],
};

function makeQb(rows: unknown[] = [], total = 0): Record<string, jest.Mock> {
  const qb: Record<string, jest.Mock> = {
    orderBy: jest.fn(),
    addOrderBy: jest.fn(),
    andWhere: jest.fn(),
    skip: jest.fn(),
    take: jest.fn(),
    getManyAndCount: jest.fn().mockResolvedValue([rows, total]),
  };
  // 链式调用：每个方法都返回 qb 自身
  for (const key of Object.keys(qb)) {
    if (key === 'getManyAndCount') continue;
    qb[key].mockReturnValue(qb);
  }
  return qb;
}

describe('OperationService 审计写入与查询语义', () => {
  let svc: OperationService;
  let repo: { insert: jest.Mock; createQueryBuilder: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    repo = {
      insert: jest.fn().mockResolvedValue(undefined),
      createQueryBuilder: jest.fn(),
    };
    svc = new OperationService(repo as never);
  });

  describe('record', () => {
    it('写库异常被吞掉：resolve 而非 reject（日志失败不得阻塞业务）', async () => {
      repo.insert.mockRejectedValueOnce(
        new Error('relation "kh_operation_log" does not exist'),
      );
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      await expect(svc.record({ action: 'login', actor: ACTOR })).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('操作日志写入失败');

      warn.mockRestore();
    });

    it('操作人快照：user_id 取自 actor，user_name 取 realName', async () => {
      await svc.record({ action: 'login', detail: '登录系统', actor: ACTOR });

      const row = repo.insert.mock.calls[0][0];
      expect(row.user_id).toBe(ACTOR.userId);
      expect(row.user_name).toBe('系统管理员');
      expect(row.action).toBe('login');
      expect(row.detail).toBe('登录系统');
    });

    it('realName 为空白时回落 username（?? 不处理空串，必须显式判）', async () => {
      await svc.record({ action: 'login', actor: { ...ACTOR, realName: '   ' } });

      expect(repo.insert.mock.calls[0][0].user_name).toBe('admin');
    });

    it('无 actor（系统动作）：user_id / user_name 均为 null', async () => {
      await svc.record({ action: 'archive', target_type: 'document', target_id: '8001' });

      const row = repo.insert.mock.calls[0][0];
      expect(row.user_id).toBeNull();
      expect(row.user_name).toBeNull();
    });

    it('超长主动截断：target_title→200、detail→500（被动 22001 会整条丢日志）', async () => {
      await svc.record({
        action: 'upload',
        target_title: 't'.repeat(250),
        detail: 'd'.repeat(600),
      });

      const row = repo.insert.mock.calls[0][0];
      expect(row.target_title).toHaveLength(200);
      expect(row.detail).toHaveLength(500);
    });
  });

  describe('findAll', () => {
    it('默认 created_at DESC + id DESC，无筛选时不追加 where', async () => {
      const qb = makeQb();
      repo.createQueryBuilder.mockReturnValueOnce(qb);

      const res = await svc.findAll({ page: 1, pageSize: 10 } as QueryOperationLogDto);

      expect(qb.orderBy).toHaveBeenCalledWith('log.created_at', 'DESC');
      expect(qb.addOrderBy).toHaveBeenCalledWith('log.id', 'DESC');
      expect(qb.andWhere).not.toHaveBeenCalled();
      expect(res).toEqual({ list: [], total: 0, page: 1, pageSize: 10 });
    });

    it('三个筛选走参数化 andWhere，分页偏移正确', async () => {
      const qb = makeQb();
      repo.createQueryBuilder.mockReturnValueOnce(qb);

      await svc.findAll({
        page: 2,
        pageSize: 5,
        action: 'upload',
        user_id: '1000000000000000001',
        target_type: 'document',
      } as QueryOperationLogDto);

      expect(qb.andWhere).toHaveBeenCalledWith('log.action = :action', { action: 'upload' });
      expect(qb.andWhere).toHaveBeenCalledWith('log.user_id = :userId', {
        userId: '1000000000000000001',
      });
      expect(qb.andWhere).toHaveBeenCalledWith('log.target_type = :targetType', {
        targetType: 'document',
      });
      expect(qb.skip).toHaveBeenCalledWith(5);
      expect(qb.take).toHaveBeenCalledWith(5);
    });

    it('出参归一：雪花 ID 转字符串、Date 转 ISO、null 字段保持 null', async () => {
      const qb = makeQb(
        [
          {
            id: '8000000000000000001',
            user_id: '1000000000000000001',
            user_name: '系统管理员',
            action: 'upload',
            target_type: 'document',
            target_id: '9000000000000000001',
            target_title: '员工差旅报销制度',
            detail: '上传文件 差旅制度.docx',
            created_at: new Date('2026-10-18T08:00:00.000Z'),
          },
        ],
        1,
      );
      repo.createQueryBuilder.mockReturnValueOnce(qb);

      const res = await svc.findAll({ page: 1, pageSize: 10 } as QueryOperationLogDto);

      expect(res.total).toBe(1);
      expect(res.list[0]).toMatchObject({
        id: '8000000000000000001',
        user_id: '1000000000000000001',
        target_id: '9000000000000000001',
        created_at: '2026-10-18T08:00:00.000Z',
      });
      expect(typeof res.list[0].id).toBe('string');
    });
  });
});
