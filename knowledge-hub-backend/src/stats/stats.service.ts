import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';
import { KhDocument } from '../document/entities/document.entity';
import { KhUser } from '../auth/entities/kh-user.entity';
import { KhOperationLog } from '../operation/entities/kh-operation-log.entity';
import { STATUS_ARCHIVED } from '../document/document.service';
import type { AuthUser } from '../auth/interfaces/auth-user.interface';
import type { QueryStatsDto, TrendRange } from './dto/query-stats.dto';

/** 趋势图的桶：起始时间 + 展示标签（标签在 JS 侧生成，不依赖数据库时区） */
interface TrendBucket {
  label: string;
  start: Date;
}

/**
 * 大盘聚合服务（20 号工单）。
 *
 * **聚合层不建表**：每个指标都直接读别的域的表，所以这里直接注入
 * `KhDocument` / `KhUser` / `KhOperationLog` 仓库，而不导入 DocumentModule / UserModule /
 * OperationModule —— 跨域只读是聚合层的本分，绕开模块依赖能彻底避免循环依赖。
 *
 * ⚠️ **时区是本模块最容易错的地方**，而且项目里有**两套时钟基准**并存：
 *
 * | 字段 | 写入方 | 列里存的时钟读数 |
 * |---|---|---|
 * | `kh_document.created_at` | DB `DEFAULT now()`（会话时区 `Etc/UTC`） | **UTC 字面** |
 * | `kh_operation_log.created_at` | DB `DEFAULT now()` | **UTC 字面** |
 * | `kh_user.last_login_at` | 应用侧 `new Date()`（18 号工单） | **本地字面** |
 *
 * 原因是 `timestamp without time zone` 会丢掉时区信息，而 node-postgres 把 `Date` 参数按
 * **本地字段**序列化成 `2026-10-18T20:10:48.937+08:00`，PostgreSQL 对 `timestamp` 又静默忽略
 * 偏移 —— 于是应用写进去的是「本地时钟读数」，DB 自己写进去的是「UTC 时钟读数」。
 *
 * 因此边界必须按字段各自的基准生成（`utcLiteral` / `localLiteral`），否则会整体偏 8 小时：
 * 本地 00:00–08:00 创建的数据会被算到前一天（实测踩过：趋势图的非零桶落在 08/12 时而非 16/20 时）。
 *
 * 另外所有边界都在 JS 侧按用户本地日历算好再传参，SQL 里绝不出现 `NOW()` / `date_trunc('day', NOW())`
 * —— 否则「今日」会在 UTC 0 点（本地早 8 点）换日。
 */
@Injectable()
export class StatsService {
  private readonly logger = new Logger(StatsService.name);

  constructor(
    @InjectRepository(KhDocument)
    private readonly docRepo: Repository<KhDocument>,
    @InjectRepository(KhUser)
    private readonly userRepo: Repository<KhUser>,
    @InjectRepository(KhOperationLog)
    private readonly operationRepo: Repository<KhOperationLog>,
  ) {}

  /**
   * 首页大盘：4 个总数 + 趋势 + 分类分布。
   *
   * 口径与前端 Mock（`mocks/handlers/stats.ts`）逐项对齐 —— 切通道后数字不该突变：
   * - `docTotal` = 未删除 + 未归档
   * - `todayNew` = 今日 00:00（本地）之后创建、未删除（**不排除归档**，与 Mock 的 `todayNewCount` 一致）
   * - `activeUsers` = `last_login_at >= 今日 00:00`（18 号工单已在登录成功路径写入）
   * - `searchCount` = 今日 `action='search'` 的审计条数（20 号工单补的埋点）
   */
  async dashboard(query: QueryStatsDto) {
    const range = query.range ?? '7d';
    const todayStart = startOfToday();
    // 两条边界基准不同，见类注释的表格 —— 混用就是 8 小时偏差
    const createdBound = utcLiteral(todayStart);
    const loginBound = localLiteral(todayStart);

    const [docTotal, todayNew, activeUsers, searchCount, trend, categoryRatio] =
      await Promise.all([
        this.docRepo.count({
          where: { deleted: false, status: Not(STATUS_ARCHIVED) },
        }),
        // 用 QueryBuilder 而非 MoreThanOrEqual(Date)：要显式控制传给 PG 的字符串字面，
        // 让「这是 UTC 字面」写在代码里，而不是依赖驱动的隐式序列化
        this.docRepo
          .createQueryBuilder('d')
          .where('d.deleted = false')
          .andWhere('d.created_at >= :bound', { bound: createdBound })
          .getCount(),
        this.userRepo
          .createQueryBuilder('u')
          .where('u.deleted = false')
          .andWhere('u.last_login_at >= :bound', { bound: loginBound })
          .getCount(),
        this.operationRepo
          .createQueryBuilder('o')
          .where('o.action = :action', { action: 'search' })
          .andWhere('o.created_at >= :bound', { bound: createdBound })
          .getCount(),
        this.buildTrend(range),
        this.buildCategoryRatio(),
      ]);

    return {
      totals: { docTotal, todayNew, searchCount, activeUsers },
      trend,
      categoryRatio,
    };
  }

  /**
   * 个人中心「我的上传统计」。
   *
   * 口径 = 本人作者 + 未删除 + 未归档，与「我的文档」列表同源 ——
   * 验收要求 `docCount` 与列表 `total` 完全一致，否则用户会以为掉数据了。
   * `file_size` 对存量文档为 NULL，故 `COALESCE` 兜 0。
   */
  async mine(user: AuthUser) {
    const row = await this.docRepo
      .createQueryBuilder('d')
      .select('COUNT(d.id)', 'docCount')
      .addSelect('COALESCE(SUM(d.file_size), 0)', 'totalSize')
      .where('d.deleted = false')
      .andWhere('d.status != :archived', { archived: STATUS_ARCHIVED })
      .andWhere('d.author_id = :uid', { uid: user.userId })
      .getRawOne<{ docCount: string; totalSize: string }>();

    return {
      docCount: Number(row?.docCount ?? 0),
      totalSize: Number(row?.totalSize ?? 0),
    };
  }

  /**
   * 趋势：按 range 分桶统计**新增文档数**。
   *
   * `generate_series` 生成完整时间轴再 LEFT JOIN —— 朴素写法
   * `GROUP BY date_trunc(...)` 会让「零新增」的日期整个消失，折线图把空白期跳过去，
   * 视觉上呈现虚假的连续增长。这是本模块必须守住的一个正确性点。
   *
   * 边界用 JS 算（`buildAxis`），SQL 只负责按给定步长铺轴 —— 见类注释的时区说明。
   */
  private async buildTrend(range: TrendRange) {
    const axis = buildAxis(range);
    const step = range === 'today' ? '1 hour' : '1 day';

    // 轴参数传 **UTC 字面**：`created_at` 存的是 UTC 时钟读数，轴必须落在同一空间。
    // 标签仍在 JS 侧按本地时区生成（buildAxis），所以「本地 16 时」的桶里放的是 UTC 08:38 的行。
    const rows = await this.docRepo.query<
      { value: string }[]
    >(
      `WITH axis AS (
         SELECT generate_series($1::timestamp, $2::timestamp, $3::interval) AS bucket_start
       )
       SELECT COUNT(d.id) AS value
       FROM axis
       LEFT JOIN kh_document d
         ON d.created_at >= axis.bucket_start
        AND d.created_at < axis.bucket_start + $3::interval
        AND d.deleted = false
       GROUP BY axis.bucket_start
       ORDER BY axis.bucket_start`,
      [
        utcLiteral(axis[0].start),
        utcLiteral(axis[axis.length - 1].start),
        step,
      ],
    );

    return {
      range,
      // 行序与 axis 一一对应（同一 generate_series 步长），标签直接用 JS 生成的值
      points: axis.map((bucket, i) => ({
        label: bucket.label,
        value: Number(rows[i]?.value ?? 0),
      })),
    };
  }

  /**
   * 分类分布：未归档文档按 `category_id` 分组。
   *
   * `LEFT JOIN` 保证**没有文档的分类也出现**（count = 0）—— 否则环形图会少几块，
   * 用户看不到「哪个分类是空的」。
   */
  private async buildCategoryRatio() {
    const rows = await this.docRepo.query<
      { key: string | null; name: string; count: string }[]
    >(
      `SELECT c.category_code AS key, c.category_name AS name, COUNT(d.id) AS count
       FROM kh_category c
       LEFT JOIN kh_document d
         ON d.category_id = c.id AND d.deleted = false AND d.status != $1
       WHERE c.deleted = false AND c.status = 1
       GROUP BY c.id, c.category_code, c.category_name, c.sort
       ORDER BY c.sort, c.id`,
      [STATUS_ARCHIVED],
    );

    return rows.map((r) => ({
      // key 缺失时回落 name：前端只用 key 做展示幂等，不参与业务判断
      key: r.key ?? r.name,
      name: r.name,
      count: Number(r.count),
    }));
  }
}

/** 本地时区「今日 00:00」 */
function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * 本地时刻 → **UTC 字面**字符串，用于和 `created_at`（DB `DEFAULT now()` 写入的 UTC 读数）比较。
 *
 * PostgreSQL 对 `timestamp` 类型会静默忽略入参里的时区后缀，
 * 所以 `'2026-10-17T16:00:00.000Z'::timestamp` 得到的就是字面 `2026-10-17 16:00:00`
 * —— 正是 `created_at` 里存的时钟读数（实测确认，见工单 20 实施记录）。
 */
function utcLiteral(d: Date): string {
  return d.toISOString();
}

/**
 * 本地时刻 → **本地字面**字符串，用于和 `last_login_at` 比较。
 *
 * 该字段由应用侧 `new Date()` 写入（18 号工单），node-postgres 按**本地字段**序列化成
 * `2026-10-18T20:10:48.937+08:00`，`timestamp` 列忽略偏移后存的是本地时钟读数。
 * 与 `created_at` 差 8 小时，**不能共用同一条边界**。
 */
function localLiteral(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

/** 按 range 生成桶（起始时间 + 标签），全部基于本地时区 */
function buildAxis(range: TrendRange): TrendBucket[] {
  const base = startOfToday();
  const buckets: TrendBucket[] = [];

  if (range === 'today') {
    for (let h = 0; h < 24; h++) {
      const start = new Date(base);
      start.setHours(h);
      buckets.push({ label: `${String(h).padStart(2, '0')}时`, start });
    }
    return buckets;
  }

  const days = range === '7d' ? 7 : 30;
  for (let i = days - 1; i >= 0; i--) {
    const start = new Date(base);
    start.setDate(start.getDate() - i);
    buckets.push({
      label: `${start.getMonth() + 1}/${start.getDate()}`,
      start,
    });
  }
  return buckets;
}
