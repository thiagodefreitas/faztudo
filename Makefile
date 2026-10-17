# Common development tasks. Run `make help` for the list.
SHELL := /bin/bash
GO ?= go

.PHONY: help setup check lint lint-prose authorship secrets test site build release-check

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

check: lint-prose authorship secrets test ## everything CI runs

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

build: ## build bin/faztudo with version information
	CGO_ENABLED=0 $(GO) build -trimpath -ldflags "$(LDFLAGS)" -o bin/faztudo ./cmd/faztudo
	@bin/faztudo version

release-check: ## validate the release configuration without publishing
	goreleaser check
