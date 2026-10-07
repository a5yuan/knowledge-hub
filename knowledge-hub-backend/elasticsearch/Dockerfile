# Elasticsearch 8.17.0 + IK 中文分词插件（内置到镜像）
FROM elasticsearch:8.17.0

# 拷贝 IK 插件包（由宿主机从 Infini Cloud 镜像下载，GitHub 直连不稳定）
COPY ik.zip /tmp/ik.zip

# 安装 IK 分词插件（版本需与 ES 完全一致）
RUN bin/elasticsearch-plugin install --batch file:///tmp/ik.zip
