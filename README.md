# Portrait Booth

Portrait Booth 是一个用于制作个人肖像及常见护照、签证照片的 Web App，支持上传或设备摄像头拍摄、脸部角度指导、模板裁剪、基础编辑、本地导出和短期跨设备取回。详见[产品说明](docs/PRODUCT.md)与[SPEC](docs/SPEC.md)。

## 当前状态

项目处于首个 MVP 实现阶段（[项目状态](STATUS.md)）。仓库为 monorepo：`frontend/`（Vite + React + TypeScript）、`backend/`（FastAPI + SQLite + 本地磁盘存储）、`templates/`（版本化模板数据）。

## 安装和启动

前置：Node.js 24+、Python 3.11+、[uv](https://docs.astral.sh/uv/)。

```sh
# 后端（API，端口 8000）
PORTRAIT_SECRET_KEY_BASE=R-ULVqaTDhAzfxpReUBrpPyuGKuMivOtt9iXbVIKNFk= \
cd backend && uv sync --extra dev && uv run uvicorn app.main:app --reload

# 前端（开发服务器，端口 5173，/api 代理到 8000）
cd frontend && npm install && npm run dev
```

浏览器打开 http://localhost:5173。

## 常用命令

| 位置     | 命令                                   | 用途                                           |
| -------- | -------------------------------------- | ---------------------------------------------- |
| frontend | `npm run dev`                          | 开发服务器                                     |
| frontend | `npm run build`                        | 类型检查 + 生产构建                            |
| frontend | `npm test`                             | Vitest 单元测试                                |
| frontend | `npm run lint` / `npm run format`      | ESLint / Prettier                              |
| backend  | `uv run uvicorn app.main:app --reload` | 开发服务器                                     |
| backend  | `uv run pytest`                        | pytest 测试                                    |
| backend  | `uv run ruff check .`                  | 静态检查                                       |
| 根目录   | `docker compose up --build`            | 全栈容器（前端产物 + API + SQLite + 磁盘存储） |

完整命令与开发工作流见[贡献指南](CONTRIBUTING.md)。

## 文档

- [项目状态](STATUS.md)
- [文档索引](docs/README.md)
- [产品说明](docs/PRODUCT.md)
- [架构说明](docs/架构说明.md)
- [贡献指南](CONTRIBUTING.md)
