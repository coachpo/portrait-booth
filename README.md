# Portrait Booth

Portrait Booth is a web app for producing personal portraits and common
passport and visa photos: upload or on-device camera capture, face-angle
guidance, template cropping, basic editing, local export, and short-term
cross-device retrieval. See the [product overview](docs/PRODUCT.md) and
[SPEC](docs/SPEC.md).

## Current status

The project is in its first MVP implementation stage
([project status](STATUS.md)). The repository is a monorepo: `frontend/`
(Vite + React + TypeScript), `backend/` (FastAPI + SQLite + local disk
storage), and `templates/` (versioned template data).

## Install and run

Prerequisites: Node.js 24+, Python 3.11+, [uv](https://docs.astral.sh/uv/).

```sh
# Backend (API, port 8000)
 cd backend && uv sync --extra dev && PORTRAIT_SECRET_KEY_BASE=R-ULVqaTDhAzfxpReUBrpPyuGKuMivOtt9iXbVIKNFk= uv run uvicorn app.main:app --reload

# Frontend (dev server, port 5173, /api proxied to 8000)
cd frontend && npm install && npm run dev
```

Open http://localhost:5173 in a browser.

## Common commands

| Location | Command                                | Purpose                                                             |
| -------- | -------------------------------------- | ------------------------------------------------------------------- |
| frontend | `npm run dev`                          | Dev server                                                          |
| frontend | `npm run build`                        | Type check + production build                                       |
| frontend | `npm test`                             | Vitest unit tests                                                   |
| frontend | `npm run lint` / `npm run format`      | ESLint / Prettier                                                   |
| backend  | `uv run uvicorn app.main:app --reload` | Dev server                                                          |
| backend  | `uv run pytest`                        | pytest tests                                                        |
| backend  | `uv run ruff check .`                  | Static checks                                                       |
| root     | `docker compose up --build`            | Full-stack container (frontend build + API + SQLite + disk storage) |

See the [contribution guide](CONTRIBUTING.md) for the full command list and
development workflow.

## Documentation

- [Project status](STATUS.md)
- [Documentation index](docs/README.md)
- [Product overview](docs/PRODUCT.md)
- [Architecture](docs/architecture.md)
- [Contribution guide](CONTRIBUTING.md)
