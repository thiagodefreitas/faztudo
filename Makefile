# Common development tasks. Run `make help` for the list.
SHELL := /bin/bash
GO ?= go

.PHONY: help setup check lint lint-prose authorship secrets test site

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
