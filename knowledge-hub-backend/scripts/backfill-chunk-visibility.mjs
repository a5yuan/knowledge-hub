/**
 * 09 号工单存量回填：给 kh_chunk 中已有切块补齐可见性字段（author_id / team_id / status / is_public）。
 *
 * - 只回填字段，不重跑 embedding（不消耗向量化额度）
 * - 数据源：PostgreSQL kh_document（deleted=false）→ 按 doc_id 对 kh_chunk 做 update_by_query
 * - 覆盖范围：先聚合 kh_chunk 中实际存在的 doc_id，逐文档回填（含 PG 已软删但 ES 残留的文档——跳过并告警）
 *
 * 用法（在 knowledge-hub-backend 目录下）：
 *   node scripts/backfill-chunk-visibility.mjs [--dry-run]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import elasticsearch from '@elastic/elasticsearch';

const { Client: PgClient } = pg;
const { Client: EsClient } = elasticsearch;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DRY_RUN = process.argv.includes('--dry-run');

/** kh_chunk 可见性字段 mapping（与 src/es/vector-index.service.ts CHUNK_VISIBILITY_MAPPING 一致） */
const VISIBILITY_MAPPING = {
  author_id: { type: 'keyword' },
  team_id: { type: 'keyword' },
  status: { type: 'integer' },
  is_public: { type: 'boolean' },
};

/** 极简 .env 解析（项目未引 dotenv 依赖） */
function loadEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || m[1].startsWith('#')) continue;
    out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

async function main() {
  const env = { ...loadEnv(path.join(ROOT, '.env')), ...process.env };
  const pgClient = new PgClient({
    host: env.POSTGRES_HOST || 'localhost',
    port: Number(env.POSTGRES_PORT || 5432),
    user: env.POSTGRES_USER,
    password: env.POSTGRES_PASSWORD,
    database: env.POSTGRES_DB,
  });
  const es = new EsClient({ node: env.ES_NODE || 'http://localhost:9200' });

  await pgClient.connect();
  try {
    // 1. kh_chunk 中实际有切块的 doc_id（聚合，上限 10 万）
    const agg = await es.search({
      index: 'kh_chunk',
      size: 0,
      track_total_hits: false,
      aggs: { docs: { terms: { field: 'doc_id', size: 100_000 } } },
    });
    const chunkDocIds = (agg.aggregations?.docs?.buckets ?? []).map((b) => b.key);
    if (chunkDocIds.length === 0) {
      console.log('[backfill] kh_chunk 无切块，无需回填');
      return;
    }
    console.log(`[backfill] kh_chunk 中存在切块的文档数 = ${chunkDocIds.length}`);

    // 2. 推 mapping（幂等；失败即退出——fail-closed，避免在无字段索引上做无效回填）
    await es.indices.putMapping({ index: 'kh_chunk', properties: VISIBILITY_MAPPING });
    console.log('[backfill] kh_chunk 可见性字段 mapping 已确认');

    // 3. PG 拉这批文档的可见性字段
    const { rows } = await pgClient.query(
      `SELECT id, author_id, team_id, status, is_public
         FROM kh_document
        WHERE deleted = false AND id = ANY($1::bigint[])`,
      [chunkDocIds],
    );
    const byId = new Map(rows.map((r) => [String(r.id), r]));
    const missing = chunkDocIds.filter((id) => !byId.has(id));
    if (missing.length) {
      console.warn(`[backfill] 警告：${missing.length} 个文档在 kh_chunk 有切块但 PG 无未删记录，跳过:`, missing.slice(0, 10));
    }

    if (DRY_RUN) {
      console.log(`[backfill][dry-run] 将回填 ${byId.size} 个文档，未执行写入`);
      return;
    }

    // 4. 逐文档 update_by_query 回填（不重跑 embedding）
    let updated = 0;
    let failed = 0;
    for (const [docId, row] of byId) {
      try {
        const resp = await es.updateByQuery({
          index: 'kh_chunk',
          conflicts: 'proceed',
          refresh: false,
          query: { term: { doc_id: docId } },
          script: {
            source:
              'ctx._source.author_id=params.authorId; ' +
              'ctx._source.team_id=params.teamId; ' +
              'ctx._source.status=params.status; ' +
              'ctx._source.is_public=params.isPublic;',
            params: {
              authorId: row.author_id == null ? null : String(row.author_id),
              teamId: row.team_id == null ? null : String(row.team_id),
              status: Number(row.status),
              isPublic: row.is_public === true,
            },
          },
        });
        updated += resp.updated ?? 0;
      } catch (err) {
        failed += 1;
        console.error(`[backfill] 回填失败 docId=${docId}: ${err.message}`);
      }
    }
    await es.indices.refresh({ index: 'kh_chunk' });
    console.log(`[backfill] 完成：文档 ${byId.size} 个，chunk 更新 ${updated} 条，失败 ${failed} 个`);

    // 5. 抽样核对
    const sample = await es.search({ index: 'kh_chunk', size: 3 });
    const hits = sample.hits.hits;
    console.log(`[backfill] 抽样 ${hits.length} 条核对：`);
    for (const h of hits) {
      const s = h._source ?? {};
      console.log(
        `  doc_id=${s.doc_id} author_id=${s.author_id ?? '(缺)'} team_id=${s.team_id ?? '(缺)'} status=${s.status ?? '(缺)'} is_public=${s.is_public ?? '(缺)'}`,
      );
    }
    const incomplete = hits.filter(
      (h) => !('author_id' in (h._source ?? {})) || !('status' in (h._source ?? {})),
    );
    if (incomplete.length > 0) {
      console.error('[backfill] 抽样仍缺字段，回填可能未生效，请检查 mapping 与日志');
      process.exitCode = 1;
    }
  } finally {
    await pgClient.end().catch(() => undefined);
    await es.close().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error('[backfill] 失败:', err);
  process.exit(1);
});
