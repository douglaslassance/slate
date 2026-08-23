/**
 * Offline tests for LoRA reference resolution. No Ollama or mflux needed.
 *
 * mflux accepts local files, Hugging Face repos, and the collection form
 * `org/model:file.safetensors`. Slate used to detect a Hub repo by requiring
 * that the reference contain no dot, which rejected both dotted repo names and
 * every collection reference, silently turning them into vault relative paths
 * that cannot exist. These pin the three forms apart.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveLoraReference } from "../src/mflux.ts";

const VAULT = "/vault";

test("an absolute path passes through untouched", () => {
	const p = "/Users/someone/LoRAs/style.safetensors";
	assert.equal(resolveLoraReference(p, VAULT), p);
});

test("a plain Hugging Face repo passes through", () => {
	assert.equal(resolveLoraReference("someuser/my-lora", VAULT), "someuser/my-lora");
});

test("a Hugging Face repo with dots in the name passes through", () => {
	// The old !includes(".") guard broke exactly this case.
	assert.equal(
		resolveLoraReference("artificialguybr/StudioGhibli.Redmond", VAULT),
		"artificialguybr/StudioGhibli.Redmond"
	);
});

test("the collection form passes through", () => {
	const ref = "someuser/my-loras:ghibli.safetensors";
	assert.equal(resolveLoraReference(ref, VAULT), ref);
});

test("a vault relative weight file resolves against the vault root", () => {
	assert.equal(
		resolveLoraReference("Assets/LoRAs/style.safetensors", VAULT),
		"/vault/Assets/LoRAs/style.safetensors"
	);
});

test("a bare weight filename resolves against the vault root", () => {
	assert.equal(resolveLoraReference("style.safetensors", VAULT), "/vault/style.safetensors");
});

test("other weight suffixes are treated as local files", () => {
	for (const ext of [".bin", ".pt", ".ckpt"]) {
		assert.equal(
			resolveLoraReference(`loras/style${ext}`, VAULT),
			`/vault/loras/style${ext}`,
			`${ext} should resolve locally`
		);
	}
});

test("a weight suffix wins over the repo shape", () => {
	// One slash and no colon looks like a repo, but the suffix says local file.
	assert.equal(
		resolveLoraReference("LoRAs/style.safetensors", VAULT),
		"/vault/LoRAs/style.safetensors"
	);
});

test("a URL passes through rather than being mangled into a vault path", () => {
	const url = "https://huggingface.co/someuser/my-lora/resolve/main/style.safetensors";
	assert.equal(resolveLoraReference(url, VAULT), url);
});

test("surrounding whitespace is ignored", () => {
	assert.equal(resolveLoraReference("  someuser/my-lora  ", VAULT), "someuser/my-lora");
});

test("a deep relative path with no suffix still resolves locally", () => {
	assert.equal(resolveLoraReference("a/b/c", VAULT), "/vault/a/b/c");
});
