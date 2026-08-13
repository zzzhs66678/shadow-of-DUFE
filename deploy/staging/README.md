# 独立 staging 运行说明

这套拓扑用于正式发布前验证，不连接生产数据库、生产资料目录或生产凭据，也不授权生产部署。默认仅监听 `127.0.0.1:8080/8443`；公开绑定必须先取得人工批准，并显式设置 `DUFESH_STAGING_ALLOW_PUBLIC_BIND=YES-I-HAVE-APPROVAL`。

## 准备

1. 在 staging 主机的仓库外创建独立配置目录和资料目录，不从生产复制敏感数据。
2. 从 `ops/postgres/postgres.env.example`、`services/auth-api/auth.env.example` 和可选的 `xiaoying-executor/xiaoying.env.example` 创建环境文件，分别生成随机凭据，权限设为 `600`。
3. staging 数据库名必须以 `_staging` 结尾；`AUTH_PUBLIC_ORIGIN`、`AUTH_ALLOWED_ORIGINS`、`DUFESH_STAGING_ORIGIN` 与 `DUFESH_STAGING_SITE_ADDRESS` 必须指向同一 staging 地址，禁止使用生产域名或 IP。
4. 使用完整 40 位 Git SHA 设置 `DUFESH_IMAGE_TAG`，并设置三个环境文件路径与独立资料目录。未验证小影时保持 `NEXT_PUBLIC_XIAOYING_URL` 为空。

## 预检与启动

```bash
chmod 600 /absolute/staging/config/*.env
sh ops/staging/preflight.sh
docker compose -p "dufesh-staging-${DUFESH_IMAGE_TAG%????????????????????????????????}" -f docker-compose.staging.yml build app auth-api
docker compose -p "dufesh-staging-${DUFESH_IMAGE_TAG%????????????????????????????????}" -f docker-compose.staging.yml --profile tools run --rm migrate
docker compose -p "dufesh-staging-${DUFESH_IMAGE_TAG%????????????????????????????????}" -f docker-compose.staging.yml up -d --no-build
sh ops/staging/smoke.sh
```

需要验证小影时，另设 `NEXT_PUBLIC_XIAOYING_URL=/campus-lab/` 和 `DUFESH_STAGING_XIAOYING_ENV_FILE`，构建小影镜像，并在启动命令加入 `--profile xiaoying`。Caddy 只依赖主应用健康状态，小影不可用不会阻止主站启动。

完成后记录 staging 地址、Git SHA、三个自建镜像摘要、迁移数量、测试时间和结果。只有 `docs/DEPLOYMENT_CHECKLIST.md` 的 staging 门禁完成后，才能申请生产发布。
