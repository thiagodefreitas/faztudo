# Common development tasks. Run `make help` for the list.
SHELL := /bin/bash
GO ?= go
GORELEASER ?= goreleaser

.PHONY: help setup check lint lint-prose authorship secrets test licenses site build release-check web dev

VERSION ?= $(shell git describe --tags --match 'v[0-9]*' --dirty 2>/dev/null || echo dev)
COMMIT  ?= $(shell git rev-parse HEAD 2>/dev/null)
DATE    ?= $(shell date -u +%Y-%m-%dT%H:%M:%SZ)
PKG     := github.com/thiagodefreitas/faztudo/internal/version
LDFLAGS := -s -w -X $(PKG).Version=$(VERSION) -X $(PKG).Commit=$(COMMIT) -X $(PKG).Date=$(DATE)

help: ## show this help
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-12s %s\n", $$1, $$2}'

setup: ## install git hooks and web dependencies
	lefthook install
	@if [ -f web/package.json ]; then npm --prefix web ci; fi
	@if [ -f site/package.json ]; then npm --prefix site ci; fi

check: lint-prose authorship secrets test licenses ## everything CI runs

licenses: ## check production Go and npm dependency licenses
	python3 -B -m unittest discover -s scripts -p 'test_*.py'
	scripts/check_licenses.sh

lint-prose: ## writing rules for docs
	python3 scripts/lint_prose.py

authorship: ## no bot authors, no attribution trailers
	scripts/check_authorship.sh

secrets: ## scan the whole history for secrets
	gitleaks detect --redact --no-banner --log-opts="--all"

test: ## Go and web tests
	@if [ -f go.mod ]; then $(GO) test -race ./...; fi
	@if [ -f web/package.json ]; then npm --prefix web test; fi

site: ## build the documentation site
	npm --prefix site run build

web: ## build the web app and stage it for embedding
	npm --prefix web ci
	npm --prefix web run build
	find internal/webui/dist -mindepth 1 ! -name .keep -exec rm -rf {} +
	cp -r web/dist/. internal/webui/dist/

dev: ## run the daemon and the web dev server (proxying /api) together
	@trap 'kill 0' INT TERM; $(GO) run ./cmd/faztudo serve & npm --prefix web run dev; wait

build: web ## build bin/faztudo with the web app and version information
	CGO_ENABLED=0 $(GO) build -trimpath -ldflags "$(LDFLAGS)" -o bin/faztudo ./cmd/faztudo
	@bin/faztudo version

release-check: ## validate the release configuration and build a local snapshot
	$(GORELEASER) check
	$(GORELEASER) release --snapshot --clean --skip=publish
