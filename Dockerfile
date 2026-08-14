# 家庭信息助理系统 · API 镜像
# 单阶段构建：保留 devDependencies（tsx），使容器内 `npm run migrate / backup` 都能跑，
# 与设计文档 §10 的操作方式（docker compose exec api npm run ...）一致。
# 生产日志干净：NODE_ENV=production 由 docker-compose 注入（禁 pino-pretty）。
FROM node:22-alpine

WORKDIR /app

# 先拷依赖清单装包（利用层缓存，改代码不重装依赖）
COPY package.json package-lock.json ./
RUN npm ci

# 拷源码 + 构建
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

# 移除非运行时需要的源码（保持镜像里只有可执行产物，缩小体积）
RUN rm -rf src scripts tsconfig.json

EXPOSE 3000 8081

# 启动前先跑迁移（幂等），再起服务
CMD ["sh", "-c", "npm run migrate && npm start"]
