.PHONY: bootstrap install-web install-ts install-py build-web dev-web start-ts start-py dev-ts dev-py clean

##= Installation

bootstrap: install-web install-ts install-py

install-web:
	cd components/web && pnpm install

install-ts:
	cd components/typescript && pnpm install

install-py:
	cd components/python && uv sync --dev

##= Web Build

build-web:
	cd components/web && pnpm build

# Watch mode for web - rebuilds on changes
dev-web:
	cd components/web && pnpm build --watch

##= Development (web watch + server)

# TypeScript server with web watch
dev-ts:
	@echo "Starting web build watcher and TypeScript server..."
	@trap 'kill 0' EXIT; \
		(cd components/web && pnpm build --watch) & \
		sleep 2 && cd components/typescript && pnpm run server

# Python server with web watch
dev-py:
	@echo "Starting web build watcher and Python server..."
	@trap 'kill 0' EXIT; \
		(cd components/web && pnpm build --watch) & \
		sleep 2 && cd components/python && uv run src/main.py

##= Server Only (no web watch - use pre-built assets)

start-ts: build-web
	cd components/typescript && pnpm run server

start-py: build-web
	cd components/python && uv run src/main.py

##= Utilities

clean:
	rm -rf components/web/dist
	rm -rf components/web/node_modules
	rm -rf components/typescript/node_modules
	rm -rf components/python/.venv

# Type checking
check-web:
	cd components/web && pnpm check

check-ts:
	cd components/typescript && pnpm run typecheck

check: check-web check-ts
