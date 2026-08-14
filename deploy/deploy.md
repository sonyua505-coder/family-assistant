# 服务器部署指南（M6 · 设计文档 §10）

目标环境：2 vCPU / 2 GiB，Ubuntu/Debian 云服务器，公网只放行 ZeroTier(9993)。
使用者（家人/朋友）手机装 ZeroTier 客户端加入同一网络后，可打开记账 Web 链接。

---

## 1. 装 Docker（如果没有）

```bash
curl -fsSL https://get.docker.com | sh
sudo systemctl enable --now docker
```

## 2. 建目录、拉代码

```bash
sudo mkdir -p /opt/homeassistant
cd /opt/homeassistant
sudo git clone <私有仓库URL> .        # 首次；之后 sudo git pull 更新
```

## 3. 配置 .env

```bash
cd /opt/homeassistant
sudo cp deploy/env.example .env
sudo nano .env
# 必改：X_API_KEY / ADMIN_KEY（openssl rand -hex 32 生成）
# 必改：ZT_IP 填 ZeroTier 给服务器分配的固定 IP；PUBLIC_WEB_BASE 填对应 http://<ZT_IP>:8081
```

## 4. 建共享网络（与 astrbot 打通）

```bash
docker network create homeassistant-net
```

## 5. 起服务

```bash
sudo docker compose up -d --build
sudo docker compose logs -f api        # 首次看启动日志
curl http://127.0.0.1:3000/healthz     # 应返回 {"ok":true}
```

> API 端口 3000 不映射到宿主（§9）；astrbot 插件容器加入 homeassistant-net 后，
> 用 `http://homeassistant-api:3000` 访问。

## 6. 每日自动备份（ADR D22）

```bash
sudo crontab -e
# 加入（每天 03:10 冷备，容器内 npm run backup 输出到 ./backup，保留 7 份）：
10 3 * * * cd /opt/homeassistant && /usr/bin/docker compose exec -T api npm run backup >> /var/log/homeassistant-backup.log 2>&1
```

本机（Windows）异地副本：装 ZeroTier 后定时把 `服务器:/opt/homeassistant/backup/` 拉一份到本地（scp/rsync 均可）。

## 7. 升级代码

```bash
cd /opt/homeassistant && sudo git pull && sudo docker compose up -d --build
```

## 8. 接入 astrbot（M7，下一步）

- 在 astrbot 的 compose（/opt/astrbot/docker-compose.yml）给 astrbot 服务追加网络 `homeassistant-net`（1 行）
- 插件配置：`API_BASE=http://homeassistant-api:3000`、`X_API_KEY=…`

---

## 运维速查

```bash
sudo docker compose logs -f api            # 看日志
sudo docker compose restart api            # 重启
sudo docker compose exec -T api npm run backup   # 手动备份
# 直查库（node:22-alpine 无 sqlite3 CLI，走容器内 Node）：
sudo docker compose exec -T api node -e "const db=require('better-sqlite3')('/data/app.db');console.log(db.prepare('SELECT count(*) n FROM bills').get())"
```
