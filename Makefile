SHELL := /bin/bash

all: install

install: wrangler pulumi uv shell

wrangler:
	npm install -g wrangler

pulumi:
	curl -fsSL https://get.pulumi.com | sh

uv:
	curl -LsSf https://astral.sh/uv/install.sh | sh

shell:
	grep -q '.pulumi/bin' $$HOME/.bashrc || \
	  echo 'export PATH="$$PATH:$$HOME/.local/bin:$$HOME/.pulumi/bin"' >> $$HOME/.bashrc