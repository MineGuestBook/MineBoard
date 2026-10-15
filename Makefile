SHELL := /bin/bash

all: install

install: pulumi uv shell

pulumi:
	curl -fsSL https://get.pulumi.com | sh

uv:
	curl -LsSf https://astral.sh/uv/install.sh | sh

shell:
	grep -q '.pulumi/bin' $$HOME/.bashrc || \
	  echo 'export PATH="$$PATH:$$HOME/.local/bin:$$HOME/.pulumi/bin"' >> $$HOME/.bashrc

dev-backend:
	cd backend && npm run dev

test-backend:
	cd backend && npm test -- --run

