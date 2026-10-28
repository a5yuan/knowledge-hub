-- 文档元数据表
CREATE TABLE IF NOT EXISTS kh_document (
    id BIGINT PRIMARY KEY,
    title VARCHAR NOT NULL,
    content_id VARCHAR NOT NULL UNIQUE,
    summary VARCHAR,
    category_id BIGINT,
    team_id BIGINT,
    author_id BIGINT,
    cover_image VARCHAR,
    tags VARCHAR,
    status SMALLINT NOT NULL DEFAULT 0,
    remark VARCHAR,
    view_count INT NOT NULL DEFAULT 0,
    like_count INT NOT NULL DEFAULT 0,
    comment_count INT NOT NULL DEFAULT 0,
    favourite_count INT NOT NULL DEFAULT 0,
    word_count INT NOT NULL DEFAULT 0,
    publish_time TIMESTAMP,
    is_public BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    create_by BIGINT,
    update_by BIGINT,
    deleted BOOLEAN NOT NULL DEFAULT false
);
-- 文档发布审核记录
-- 一次「提交审核」一行；approve/reject 后 review_result 非空，不再出现在待办列表
CREATE TABLE IF NOT EXISTS kh_document_review (
    id BIGINT PRIMARY KEY,                          -- 审核记录 ID（雪花）
    document_id BIGINT NOT NULL,                    -- 被审文档 ID → kh_document.id
    reviewer_id BIGINT,                             -- 审核人 ID；待审时为 NULL
    reviewer_name VARCHAR,                          -- 审核人姓名
    review_result SMALLINT,                         -- NULL=待审 1=通过 2=驳回
    review_comment VARCHAR,                         -- 审核意见（驳回必填）
    before_status SMALLINT NOT NULL,                -- 提审前文档 status（0 草稿 / 1 已发布）
    reviewed_at TIMESTAMP,                          -- 审核完成时间
    created_at TIMESTAMP NOT NULL DEFAULT NOW()     -- 提交审核时间
);
-- 按文档查审核历史
CREATE INDEX IF NOT EXISTS idx_kh_document_review_document_id ON kh_document_review(document_id);
-- 待办列表：仅 review_result IS NULL 的行
CREATE INDEX IF NOT EXISTS idx_kh_document_review_pending ON kh_document_review(review_result) WHERE review_result IS NULL;

-- ==================== 用户与角色 ====================

CREATE TABLE IF NOT EXISTS kh_user (
    id BIGINT PRIMARY KEY,                          -- 用户 ID（雪花）
    username VARCHAR(50) NOT NULL,                  -- 登录用户名
    password VARCHAR(255) NOT NULL,                 -- 密码（bcrypt 哈希）
    email VARCHAR(100),                             -- 邮箱（可选）
    real_name VARCHAR(50),                          -- 真实姓名 / 显示名
    avatar VARCHAR(500),                            -- 头像 URL
    email_verified SMALLINT NOT NULL DEFAULT 1,     -- 0 未验证 1 已验证
    status SMALLINT NOT NULL DEFAULT 1,             -- 0 禁用 1 启用
    last_login_at TIMESTAMP,                        -- 最后登录时间
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),    -- 创建时间
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),    -- 更新时间
    deleted BOOLEAN NOT NULL DEFAULT false          -- 软删除标记
);
-- 未删除用户名唯一
CREATE UNIQUE INDEX IF NOT EXISTS uk_kh_user_username ON kh_user(username) WHERE deleted = false;

CREATE TABLE IF NOT EXISTS kh_role (
    id BIGINT PRIMARY KEY,                          -- 角色 ID（雪花）
    role_name VARCHAR(50) NOT NULL,                 -- 角色名称（展示用）
    role_code VARCHAR(50) NOT NULL UNIQUE,          -- 角色编码，如 ROLE_ADMIN / ROLE_REVIEWER / ROLE_USER
    description VARCHAR(200),                     -- 角色描述
    status SMALLINT NOT NULL DEFAULT 1              -- 0 禁用 1 启用
);

CREATE TABLE IF NOT EXISTS kh_user_role (
    id BIGINT PRIMARY KEY,                          -- 关联 ID（雪花）
    user_id BIGINT NOT NULL REFERENCES kh_user(id), -- 用户 ID
    role_id BIGINT NOT NULL REFERENCES kh_role(id), -- 角色 ID
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),    -- 分配时间
    UNIQUE (user_id, role_id)
);
CREATE INDEX IF NOT EXISTS idx_kh_user_role_user_id ON kh_user_role(user_id);

-- 预置角色
INSERT INTO kh_role (id, role_name, role_code, description) VALUES
    (2000000000000000001, '管理员', 'ROLE_ADMIN', '系统管理'),
    (2000000000000000002, '审核员', 'ROLE_REVIEWER', '文档审核'),
    (2000000000000000003, '普通用户', 'ROLE_USER', '默认角色')
ON CONFLICT (id) DO NOTHING;

-- 测试账号（密码均为 123456，bcrypt）
INSERT INTO kh_user (id, username, password, email, real_name, status) VALUES
    (1000000000000000001, 'admin', '$2a$10$N.zmdr9k7uOCQb376NoUnuTJ8iAt6Z5EHsM8lE9lBOsl7iKTVKIUi', 'admin@company.com', '系统管理员', 1),
    (1000000000000000002, 'reviewer', '$2a$10$N.zmdr9k7uOCQb376NoUnuTJ8iAt6Z5EHsM8lE9lBOsl7iKTVKIUi', 'reviewer@company.com', '审核员张三', 1),
    (1000000000000000003, 'user', '$2a$10$N.zmdr9k7uOCQb376NoUnuTJ8iAt6Z5EHsM8lE9lBOsl7iKTVKIUi', 'user@company.com', '普通用户李四', 1)
ON CONFLICT (id) DO NOTHING;

INSERT INTO kh_user_role (id, user_id, role_id) VALUES
    (3000000000000000001, 1000000000000000001, 2000000000000000001),  -- admin → 管理员
    (3000000000000000002, 1000000000000000001, 2000000000000000002),  -- admin → 审核员
    (3000000000000000003, 1000000000000000002, 2000000000000000002),  -- reviewer → 审核员
    (3000000000000000004, 1000000000000000003, 2000000000000000003)   -- user → 普通用户
ON CONFLICT (id) DO NOTHING;

-- ==================== 权限 RBAC ====================

CREATE TABLE IF NOT EXISTS kh_permission (
    id BIGINT PRIMARY KEY,                          -- 权限 ID（雪花）
    parent_id BIGINT NOT NULL DEFAULT 0,            -- 父权限 ID，0 为根
    permission_name VARCHAR(50) NOT NULL,           -- 权限名称
    permission_code VARCHAR(100) NOT NULL UNIQUE,   -- 权限编码（运行时校验）
    permission_type SMALLINT NOT NULL,              -- 1 菜单 2 按钮 3 接口
    menu_url VARCHAR(200),                          -- 菜单路径
    api_url VARCHAR(500),                           -- 接口 URL 模式
    method VARCHAR(10),                             -- HTTP 方法
    icon VARCHAR(50),                               -- 图标
    sort INT NOT NULL DEFAULT 0,
    status SMALLINT NOT NULL DEFAULT 1,             -- 0 禁用 1 启用
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    deleted BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS kh_role_permission (
    id BIGINT PRIMARY KEY,
    role_id BIGINT NOT NULL REFERENCES kh_role(id),
    permission_id BIGINT NOT NULL REFERENCES kh_permission(id),
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS kh_user_permission (
    id BIGINT PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES kh_user(id),
    permission_id BIGINT NOT NULL REFERENCES kh_permission(id),
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, permission_id)
);

INSERT INTO kh_permission (id, parent_id, permission_name, permission_code, permission_type, menu_url, icon, sort) VALUES
    (4000000000000000001, 0, '首页', 'dashboard', 1, '/dashboard', 'DashboardOutlined', 1),
    (4000000000000000002, 0, '文档中心', 'document', 1, '/documents', 'FileTextOutlined', 2),
    (4000000000000000003, 0, '搜索', 'search', 1, '/search', 'SearchOutlined', 3),
    (4000000000000000004, 0, '个人中心', 'profile', 1, '/profile', 'UserOutlined', 4),
    (4000000000000000005, 0, '系统管理', 'system', 1, '/admin', 'SettingOutlined', 5)
ON CONFLICT (id) DO NOTHING;

INSERT INTO kh_permission (id, parent_id, permission_name, permission_code, permission_type, sort) VALUES
    (4000000000000000011, 4000000000000000002, '文档列表', 'document:list', 2, 1),
    (4000000000000000012, 4000000000000000002, '创建文档', 'document:create', 2, 2),
    (4000000000000000013, 4000000000000000002, '编辑文档', 'document:edit', 2, 3),
    (4000000000000000014, 4000000000000000002, '删除文档', 'document:delete', 2, 4),
    (4000000000000000015, 4000000000000000002, '文档审核', 'document:review', 2, 5)
ON CONFLICT (id) DO NOTHING;

INSERT INTO kh_permission (id, parent_id, permission_name, permission_code, permission_type, menu_url, sort) VALUES
    (4000000000000000021, 4000000000000000005, '用户管理', 'system:user', 1, '/admin/users', 1),
    (4000000000000000022, 4000000000000000005, '角色管理', 'system:role', 1, '/admin/roles', 2),
    (4000000000000000023, 4000000000000000005, '权限管理', 'system:permission', 1, '/admin/permissions', 3),
    (4000000000000000024, 4000000000000000005, '团队管理', 'system:team', 1, '/admin/teams', 4)
ON CONFLICT (id) DO NOTHING;

INSERT INTO kh_permission (id, parent_id, permission_name, permission_code, permission_type, sort) VALUES
    (4000000000000000041, 4000000000000000023, '新增权限', 'system:permission:create', 2, 1),
    (4000000000000000042, 4000000000000000023, '编辑权限', 'system:permission:edit', 2, 2),
    (4000000000000000043, 4000000000000000023, '删除权限', 'system:permission:delete', 2, 3)
ON CONFLICT (id) DO NOTHING;

INSERT INTO kh_role_permission (id, role_id, permission_id) VALUES
    (4100000000000000001, 2000000000000000002, 4000000000000000011),
    (4100000000000000002, 2000000000000000002, 4000000000000000015),
    (4100000000000000003, 2000000000000000003, 4000000000000000001),
    (4100000000000000004, 2000000000000000003, 4000000000000000002),
    (4100000000000000005, 2000000000000000003, 4000000000000000011),
    (4100000000000000006, 2000000000000000003, 4000000000000000012),
    (4100000000000000007, 2000000000000000003, 4000000000000000003),
    (4100000000000000008, 2000000000000000003, 4000000000000000004),
    (4100000000000000009, 2000000000000000003, 4000000000000000013),
    (4100000000000000010, 2000000000000000003, 4000000000000000014),
    (4100000000000000011, 2000000000000000002, 4000000000000000003)
ON CONFLICT (id) DO NOTHING;

-- 用户直赋权限（图1 扩展能力演示）：reviewer(1000000000000000002) 直赋 创建文档权限
-- 用户最终权限 = 角色权限 ∪ 直赋权限（去重合并）；src/auth/permission.service.ts 运行时合并
INSERT INTO kh_user_permission (id, user_id, permission_id) VALUES
    (4200000000000000001, 1000000000000000002, 4000000000000000012)
ON CONFLICT (id) DO NOTHING;


-- ==================== 团队 ====================

CREATE TABLE IF NOT EXISTS kh_team (
    id BIGINT PRIMARY KEY,                          -- 团队 ID（雪花）
    team_name VARCHAR(100) NOT NULL,                -- 团队名称
    team_code VARCHAR(50),                          -- 团队编码
    description VARCHAR(500),                       -- 描述
    leader_id BIGINT,                               -- 负责人 → kh_user.id
    parent_id BIGINT NOT NULL DEFAULT 0,            -- 父团队 ID，0 为根
    sort INT NOT NULL DEFAULT 0,                    -- 排序
    status SMALLINT NOT NULL DEFAULT 1,             -- 0 禁用 1 启用
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    deleted BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_kh_team_parent_id ON kh_team(parent_id);

CREATE TABLE IF NOT EXISTS kh_team_member (
    id BIGINT PRIMARY KEY,                          -- 关联 ID（雪花）
    team_id BIGINT NOT NULL REFERENCES kh_team(id),
    user_id BIGINT NOT NULL REFERENCES kh_user(id),
    member_role VARCHAR(20) NOT NULL DEFAULT 'member', -- leader / member
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE (team_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_kh_team_member_user_id ON kh_team_member(user_id);

INSERT INTO kh_team (id, team_name, team_code, description, leader_id, parent_id, sort) VALUES
    (8000000000000000001, '技术中心', 'TECH_CENTER', '研发与技术团队', 1000000000000000001, 0, 1),
    (8000000000000000002, '后端开发组', 'BACKEND_TEAM', '后端开发', 1000000000000000001, 8000000000000000001, 1)
ON CONFLICT (id) DO NOTHING;

INSERT INTO kh_team_member (id, team_id, user_id, member_role) VALUES
    (9000000000000000001, 8000000000000000001, 1000000000000000001, 'leader'),
    (9000000000000000002, 8000000000000000002, 1000000000000000001, 'leader'),
    (9000000000000000003, 8000000000000000002, 1000000000000000003, 'member')
ON CONFLICT (id) DO NOTHING;

-- 团队管理权限码（parent = system:team 菜单 4000000000000000024，按钮级 type=2，接口校验复用同码）
INSERT INTO kh_permission (id, parent_id, permission_name, permission_code, permission_type, sort) VALUES
    (4000000000000000051, 4000000000000000024, '创建团队', 'team:create', 2, 1),
    (4000000000000000052, 4000000000000000024, '编辑团队', 'team:edit', 2, 2),
    (4000000000000000053, 4000000000000000024, '删除团队', 'team:delete', 2, 3),
    (4000000000000000054, 4000000000000000024, '成员管理', 'team:member', 2, 4)
ON CONFLICT (id) DO NOTHING;

-- ROLE_USER 授权 创建/编辑/成员管理；team:delete 不授权任何角色（仅 Admin 旁路可删，演示权限收敛）
INSERT INTO kh_role_permission (id, role_id, permission_id) VALUES
    (4100000000000000012, 2000000000000000003, 4000000000000000051),
    (4100000000000000013, 2000000000000000003, 4000000000000000052),
    (4100000000000000014, 2000000000000000003, 4000000000000000054)
ON CONFLICT (id) DO NOTHING;
-- ==================== AI 会话 ====================

CREATE TABLE IF NOT EXISTS kh_ai_session (
    id BIGINT PRIMARY KEY,
    user_id BIGINT NOT NULL,
    title VARCHAR(80) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_kh_ai_session_user_updated
    ON kh_ai_session(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS kh_ai_message (
    id BIGINT PRIMARY KEY,
    session_id BIGINT NOT NULL REFERENCES kh_ai_session(id) ON DELETE CASCADE,
    role VARCHAR(16) NOT NULL,
    content TEXT NOT NULL,
    sources JSONB,
    -- 生成式 UI 界面蓝图（genui 方案 A：落库，回放时原样还原卡片）
    -- 结构见 src/ai/ui/surface.ts 的 Surface；校验失败时为空
    surfaces JSONB,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_kh_ai_message_session_id
    ON kh_ai_message(session_id, created_at);

-- ==================== 目录（16 号工单） ====================

-- 目录表（树形，按 zone 分区）
-- zone 仅三值：mine / public / department —— archive 是文档状态（status=3）而非分区，不入本表
CREATE TABLE IF NOT EXISTS kh_folder (
    id BIGINT PRIMARY KEY,                          -- 目录 ID（雪花）
    folder_name VARCHAR(100) NOT NULL,              -- 目录名称
    parent_id BIGINT NOT NULL DEFAULT 0,            -- 父目录 ID，0 为根
    zone VARCHAR(20) NOT NULL,                      -- 分区：mine / public / department
    owner_id BIGINT,                                -- mine 分区归属用户 → kh_user.id
    department_id BIGINT,                           -- department 分区归属部门 → kh_department.id（18 号工单建表）
    sort INT NOT NULL DEFAULT 0,                    -- 同级排序
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    create_by BIGINT,
    update_by BIGINT,
    deleted BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_kh_folder_parent_id ON kh_folder(parent_id);
CREATE INDEX IF NOT EXISTS idx_kh_folder_zone ON kh_folder(zone) WHERE deleted = false;

-- 文档归属目录（严格归属：单列外键，可空；NULL = 根目录）
ALTER TABLE kh_document ADD COLUMN IF NOT EXISTS folder_id BIGINT;
CREATE INDEX IF NOT EXISTS idx_kh_document_folder_id ON kh_document(folder_id);

-- ==================== 分类与标签（17 号工单） ====================

-- 文档分类（扁平字典，不做层级）；category_code 供前端 Category.key（slug）
CREATE TABLE IF NOT EXISTS kh_category (
    id BIGINT PRIMARY KEY,                          -- 分类 ID（雪花）
    category_name VARCHAR(50) NOT NULL,             -- 分类名称
    category_code VARCHAR(50),                      -- 分类编码（slug，供前端 key）
    sort INT NOT NULL DEFAULT 0,                    -- 排序
    status SMALLINT NOT NULL DEFAULT 1,             -- 0 禁用 1 启用
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    create_by BIGINT,
    update_by BIGINT,
    deleted BOOLEAN NOT NULL DEFAULT false
);
-- 未删除分类名/编码唯一：部分唯一索引让软删行退出唯一性约束（否则删掉的名字无法复用）
CREATE UNIQUE INDEX IF NOT EXISTS uk_kh_category_name ON kh_category(category_name) WHERE deleted = false;
CREATE UNIQUE INDEX IF NOT EXISTS uk_kh_category_code ON kh_category(category_code) WHERE deleted = false;

-- 文档标签（扁平字典）；use_count 为冗余引用计数，增删关联后按关联表重算（幂等，不做自增自减）
CREATE TABLE IF NOT EXISTS kh_tag (
    id BIGINT PRIMARY KEY,                          -- 标签 ID（雪花）
    tag_name VARCHAR(50) NOT NULL,                  -- 标签名称
    use_count INT NOT NULL DEFAULT 0,               -- 引用计数（冗余，可重算）
    status SMALLINT NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    create_by BIGINT,
    update_by BIGINT,
    deleted BOOLEAN NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_kh_tag_name ON kh_tag(tag_name) WHERE deleted = false;

-- 文档-标签关联（多对多）：D 方案的唯一真相源（写侧以本表为准，读侧只认本表）
CREATE TABLE IF NOT EXISTS kh_document_tag (
    id BIGINT PRIMARY KEY,                          -- 关联 ID（雪花）
    document_id BIGINT NOT NULL REFERENCES kh_document(id),
    tag_id BIGINT NOT NULL REFERENCES kh_tag(id),
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),    -- 决策 #5：与 kh_user_role / kh_role_permission 对齐
    UNIQUE (document_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_kh_document_tag_tag_id ON kh_document_tag(tag_id);

-- 分类外键索引（category_id 列已存在于 kh_document，本工单仅补索引）
CREATE INDEX IF NOT EXISTS idx_kh_document_category_id ON kh_document(category_id);

-- 种子分类（与前端 Mock 对齐，保证切通道后 UI 不空）
INSERT INTO kh_category (id, category_name, category_code, sort) VALUES
    (6000000000000000001, '技术文档', 'tech', 1),
    (6000000000000000002, '产品文档', 'product', 2),
    (6000000000000000003, '管理制度', 'policy', 3),
    (6000000000000000004, '会议纪要', 'meeting', 4),
    (6000000000000000005, '其他', 'other', 99)
ON CONFLICT (id) DO NOTHING;

-- 种子标签（与前端 Mock 对齐）
INSERT INTO kh_tag (id, tag_name) VALUES
    (7000000000000000001, 'NestJS'),
    (7000000000000000002, 'RAG'),
    (7000000000000000003, '知识图谱'),
    (7000000000000000004, '前端'),
    (7000000000000000005, '性能优化')
ON CONFLICT (id) DO NOTHING;

-- 存量迁移：把 kh_document.tags 逗号串拆成关联行（标签名未登记入 kh_tag 则跳过；幂等可重跑）
-- 当前环境无存量数据，脚本不实际生效；留档以便生产环境复用时直接搬用
INSERT INTO kh_document_tag (id, document_id, tag_id)
SELECT
    (EXTRACT(EPOCH FROM clock_timestamp())::BIGINT * 1000000
     + ROW_NUMBER() OVER ())::BIGINT,
    d.id,
    t.id
FROM kh_document d
CROSS JOIN LATERAL unnest(string_to_array(d.tags, ',')) AS tag_name(name)
JOIN kh_tag t ON t.tag_name = trim(tag_name.name) AND t.deleted = false
WHERE d.tags IS NOT NULL
  AND d.tags <> ''
  AND d.deleted = false
ON CONFLICT (document_id, tag_id) DO NOTHING;

-- 迁移后重算引用计数（按关联表实际行数覆盖，幂等）
UPDATE kh_tag SET use_count = (
    SELECT COUNT(*) FROM kh_document_tag WHERE tag_id = kh_tag.id
);

-- 分类/标签管理权限码（parent = 文档中心菜单，按钮级 type=2，接口校验复用同码）
INSERT INTO kh_permission (id, parent_id, permission_name, permission_code, permission_type, sort) VALUES
    (4000000000000000061, 4000000000000000002, '分类管理', 'doc:meta:category', 2, 6),
    (4000000000000000062, 4000000000000000002, '标签管理', 'doc:meta:tag', 2, 7)
ON CONFLICT (id) DO NOTHING;

-- ROLE_USER(2000000000000000003) 授权；注意 POST /tag 不挂权限码（文档编写的自由输入创建流程需要）
-- 这里用裸 ON CONFLICT DO NOTHING：kh_role_permission 上是列级 UNIQUE(role_id, permission_id)，
-- 只写 ON CONFLICT (id) 在重跑时会撞列级约束抛错（init.sql 既有 4 处同款缺陷）
INSERT INTO kh_role_permission (id, role_id, permission_id) VALUES
    (4100000000000000015, 2000000000000000003, 4000000000000000061),
    (4100000000000000016, 2000000000000000003, 4000000000000000062)
ON CONFLICT DO NOTHING;


-- ==================== 用户与部门（18 号工单） ====================

-- 部门表（树形，深度 ≤ 3）。字段风格对齐 kh_team / kh_folder：下划线前缀命名 + parent_id 以 0 表根
CREATE TABLE IF NOT EXISTS kh_department (
    id BIGINT PRIMARY KEY,                          -- 部门 ID（雪花）
    dept_name VARCHAR(50) NOT NULL,                 -- 部门名称
    dept_code VARCHAR(50),                          -- 部门编码
    parent_id BIGINT NOT NULL DEFAULT 0,            -- 父部门 ID，0 为根
    sort INT NOT NULL DEFAULT 0,                    -- 同级排序
    status SMALLINT NOT NULL DEFAULT 1,             -- 0 禁用 1 启用
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    create_by BIGINT,                               -- 创建人 → kh_user.id
    update_by BIGINT,                               -- 最后更新人 → kh_user.id
    deleted BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_kh_department_parent_id ON kh_department(parent_id);
-- 未删部门名唯一（软删后允许复用同名，故建部分唯一索引而非列级 UNIQUE）
CREATE UNIQUE INDEX IF NOT EXISTS uk_kh_department_name ON kh_department(dept_name) WHERE deleted = false;

-- 用户归属部门（可空：不强制所有用户归部门）
ALTER TABLE kh_user ADD COLUMN IF NOT EXISTS department_id BIGINT;
CREATE INDEX IF NOT EXISTS idx_kh_user_department_id ON kh_user(department_id);

-- 种子部门（三层结构：技术中心 → 研发部 → 前端组/后端组，用于验证树形与深度约束）
INSERT INTO kh_department (id, dept_name, dept_code, parent_id, sort) VALUES
    (5000000000000000001, '技术中心', 'TECH', 0, 1),
    (5000000000000000002, '研发部',   'RD',   5000000000000000001, 1),
    (5000000000000000003, '产品部',   'PD',   5000000000000000001, 2),
    (5000000000000000004, '市场部',   'MKT',  0, 2),
    (5000000000000000005, '前端组',   'FE',   5000000000000000002, 1),
    (5000000000000000006, '后端组',   'BE',   5000000000000000002, 2)
ON CONFLICT (id) DO NOTHING;

-- 存量用户归部门：admin 归「后端组」，使 zone=department 有可验证数据
UPDATE kh_user SET department_id = 5000000000000000006
  WHERE username = 'admin' AND department_id IS NULL;

-- 用户与部门管理权限码。
-- ⚠️ 18 号工单原文预留 4000000000000000061~0064 / 0071，但 0061/0062 已被 17 号工单
--    （doc:meta:category / doc:meta:tag）占用，故改取 0081 起号段，避开冲突。
-- system:dept 菜单为新建（原权限树只有 system:user/role/permission/team 四项，无部门菜单）
INSERT INTO kh_permission (id, parent_id, permission_name, permission_code, permission_type, menu_url, sort) VALUES
    (4000000000000000081, 4000000000000000005, '组织架构', 'system:dept', 1, '/admin/departments', 5)
ON CONFLICT (id) DO NOTHING;

INSERT INTO kh_permission (id, parent_id, permission_name, permission_code, permission_type, sort) VALUES
    (4000000000000000082, 4000000000000000021, '查看用户', 'user:view',   2, 1),
    (4000000000000000083, 4000000000000000021, '创建用户', 'user:create', 2, 2),
    (4000000000000000084, 4000000000000000021, '编辑用户', 'user:edit',   2, 3),
    (4000000000000000085, 4000000000000000021, '删除用户', 'user:delete', 2, 4),
    (4000000000000000086, 4000000000000000081, '组织管理', 'org:manage',  2, 1)
ON CONFLICT (id) DO NOTHING;

-- ROLE_USER 授权：仅 user:view 与 org:manage（与 team 权限的演示收敛风格一致）
-- user:create / user:edit / user:delete 不授任何角色 —— 仅 Admin 经 PermissionsGuard 旁路放行
--
-- ⚠️ 菜单码 system:user(0021) / system:dept(0081) 刻意不授 ROLE_USER，与 system:team(0024) 同款处理：
--    ROLE_USER 连顶层「系统管理」菜单 system(0005) 都未授，单授 0081 是死码（父菜单不显示 → 子项无挂载点），
--    要让非 Admin 看见必须连 0005 一起放开，那是「普通用户可见系统管理分组」的语义变更，本工单不做。
--    故 user:view / org:manage 只作为「接口级能力码」存在：Admin 经 PermissionsGuard 旁路全通过，
--    非 Admin 即使被直赋该码也只能调接口、看不到管理页。team:* 自 05 工单起即为此约定。
INSERT INTO kh_role_permission (id, role_id, permission_id) VALUES
    (4100000000000000081, 2000000000000000003, 4000000000000000082),
    (4100000000000000082, 2000000000000000003, 4000000000000000086)
ON CONFLICT DO NOTHING;


-- ==================== 操作日志（19 号工单） ====================

-- 审计日志：仅追加，永不更新、不软删。
-- ⚠️ 这是本批工单唯一不带 deleted 的表 —— 审计表若允许软删，等于允许隐藏操作痕迹。
-- ⚠️ user_name / target_title 是刻意的冗余快照：读取不联表，且目标被删后日志仍可读（审计的基本要求）。
CREATE TABLE IF NOT EXISTS kh_operation_log (
    id BIGINT PRIMARY KEY,                          -- 日志 ID（雪花）
    user_id BIGINT,                                 -- 操作人 → kh_user.id（可空：系统动作）
    user_name VARCHAR(50),                          -- 操作人显示名（冗余快照，避免联表）
    action VARCHAR(30) NOT NULL,                    -- 动作类型：upload/update/delete/login/ai-ask/...
    target_type VARCHAR(30),                        -- 目标类型：document/user/team/folder
    target_id BIGINT,                               -- 目标 ID
    target_title VARCHAR(200),                      -- 目标标题（冗余快照，目标删除后日志仍可读）
    detail VARCHAR(500),                            -- 明细描述
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_kh_operation_log_created_at ON kh_operation_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_kh_operation_log_user_id ON kh_operation_log(user_id);
CREATE INDEX IF NOT EXISTS idx_kh_operation_log_action ON kh_operation_log(action);


-- ==================== 系统公告（21 号工单） ====================

-- 公告：publish_time 独立于 created_at（可先创建后发布），expire_time 为空 = 长期有效。
-- ⚠️ 时间列一律由 DB 侧写入（NOW()），与本库其它 created_at 同为 UTC 字面基准；
--    应用侧不要用 new Date() 写这些列，否则会混入本地字面（见 stats.service.ts 的两套时钟说明）。
CREATE TABLE IF NOT EXISTS kh_announcement (
    id BIGINT PRIMARY KEY,                          -- 公告 ID（雪花）
    title VARCHAR(200) NOT NULL,                    -- 公告标题
    content TEXT NOT NULL,                          -- 公告正文（TEXT：正文可能较长）
    status SMALLINT NOT NULL DEFAULT 1,             -- 0 停用 / 1 启用（前端 enabled 由它映射）
    publish_time TIMESTAMP,                         -- 发布时间（NULL = 未发布）
    expire_time TIMESTAMP,                          -- 过期时间（NULL = 长期有效）
    sort INT NOT NULL DEFAULT 0,                    -- 排序（同级置顶用）
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    create_by BIGINT,
    update_by BIGINT,
    deleted BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_kh_announcement_status ON kh_announcement(status) WHERE deleted = false;
CREATE INDEX IF NOT EXISTS idx_kh_announcement_publish_time ON kh_announcement(publish_time DESC);

-- 种子公告（与 Mock 的 3 条对齐，切换通道后 UI 不空；第 3 条 status=0 用于验证「停用不出现在大盘」）
INSERT INTO kh_announcement (id, title, content, status, publish_time, sort) VALUES
    (3000000000000000001, '知识库系统 v2 上线通知', '新版知识库已上线，新增智能搜索与在线文档能力，欢迎体验。', 1, NOW() - INTERVAL '2 day', 1),
    (3000000000000000002, '信息安全月活动预告',     '本月将开展信息安全培训与钓鱼演练，请各位同事留意通知。', 1, NOW() - INTERVAL '5 day', 2),
    (3000000000000000003, '旧版文档迁移完成',       '旧版文件服务器文档已全部迁移至知识库，原地址将停用。', 0, NOW() - INTERVAL '15 day', 3)
ON CONFLICT (id) DO NOTHING;

-- 权限：公告管理（菜单 + 按钮）。⚠️ ID 现查现取，本段实施时的水位是 …0086，不预约号段。
INSERT INTO kh_permission (id, parent_id, permission_name, permission_code, permission_type, menu_url, icon, sort) VALUES
    (4000000000000000087, 4000000000000000005, '公告管理', 'system:announcement', 1, '/admin/announcements', 'Bell', 5)
ON CONFLICT (id) DO NOTHING;

INSERT INTO kh_permission (id, parent_id, permission_name, permission_code, permission_type, sort) VALUES
    (4000000000000000088, 4000000000000000087, '维护公告', 'announcement:manage', 2, 1)
ON CONFLICT (id) DO NOTHING;

-- ROLE_ADMIN 显式授权：PermissionsGuard 对 ROLE_ADMIN 有**接口级**旁路，但前端菜单与按钮可见性
-- 依赖 /auth/permissions 返回的真实授权数据（permission.service 只做角色权限 ∪ 直赋权限，无 admin 旁路）。
-- 不授这两条，admin 登录后看不到「公告管理」菜单。
INSERT INTO kh_role_permission (id, role_id, permission_id) VALUES
    (4100000000000000091, 2000000000000000001, 4000000000000000087),
    (4100000000000000092, 2000000000000000001, 4000000000000000088)
ON CONFLICT DO NOTHING;


-- ==================== 大盘聚合（20 号工单） ====================

-- 文档文件体积（字节）：MyStats.totalSize 与列表 fileSize 的唯一来源。
-- 存量文档与在线文档为 NULL —— 前端按 undefined / '—' 处理，聚合时 COALESCE 为 0。
ALTER TABLE kh_document ADD COLUMN IF NOT EXISTS file_size BIGINT;
