.PHONY: install install-ts install-py server-ts server-py clean

bootstrap: install-ts install-py

install-ts:
	cd components/typescript && npm install

install-py:
	cd components/python && uv sync --dev

start-ts:
	cd components/typescript && npm run server

start-py:
	cd components/python && uv run src/main.py