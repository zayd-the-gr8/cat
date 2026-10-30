#!/usr/bin/env bash
set -euo pipefail

if [ -f "$HOME/.cargo/env" ]; then
	source "$HOME/.cargo/env"
fi

if ! command -v cargo >/dev/null 2>&1; then
	rustup_installer="$(mktemp)"
	curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs -o "$rustup_installer"
	sh "$rustup_installer" -y
	rm "$rustup_installer"
	source "$HOME/.cargo/env"
fi

rustup toolchain install nightly --component rust-src --target wasm32-unknown-unknown

if ! command -v wasm-bindgen >/dev/null 2>&1; then
	cargo install wasm-bindgen-cli --version 0.2.105 --locked
fi

binaryen_dir="$HOME/.local/binaryen"
export PATH="$binaryen_dir/bin:$PATH"
if ! command -v wasm-opt >/dev/null 2>&1; then
	mkdir -p "$binaryen_dir"
	binaryen_archive="$(mktemp)"
	binaryen_url="$(
		curl --proto '=https' --tlsv1.2 -fsSL \
			https://api.github.com/repos/WebAssembly/binaryen/releases/latest |
			node -e '
				let response = "";
				process.stdin.on("data", (chunk) => response += chunk);
				process.stdin.on("end", () => {
					const release = JSON.parse(response);
					const asset = release.assets.find(({ name }) => name.endsWith("x86_64-linux.tar.gz"));
					if (!asset) throw new Error("No Linux x86_64 Binaryen archive found");
					console.log(asset.browser_download_url);
				});
			'
	)"
	curl --proto '=https' --tlsv1.2 -fsSL "$binaryen_url" -o "$binaryen_archive"
	tar -xzf "$binaryen_archive" -C "$binaryen_dir" --strip-components=1
	rm "$binaryen_archive"
fi

if ! command -v wasm-snip >/dev/null 2>&1; then
	cargo install --git https://github.com/r58Playz/wasm-snip
fi

export PATH="$HOME/.cargo/bin:$PATH"
export RELEASE=1
export OPTIMIZE_FOR_SIZE=1

pnpm --filter @mercuryworkshop/scramjet rewriter:build
pnpm --filter @mercuryworkshop/scramjet build
pnpm --filter @mercuryworkshop/scramjet-demo build
