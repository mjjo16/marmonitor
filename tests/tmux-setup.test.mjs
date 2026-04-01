import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

// We test the pure functions directly — they operate on file paths, not global state.
// Import will work after build.
import {
  addMarmonitorPlugin,
  detectTmuxIntegrationMode,
  getMarmonitorPluginDir,
  hasInstalledMarmonitorPlugin,
  hasMarmonitorPlugin,
  removeMarmonitorPlugin,
} from "../dist/tmux/setup.js";

async function withTmpConf(content, fn) {
  const dir = await mkdtemp(join(tmpdir(), "marmonitor-test-"));
  const confPath = join(dir, ".tmux.conf");
  await writeFile(confPath, content, "utf-8");
  try {
    await fn(confPath);
  } finally {
    await rm(dir, { recursive: true });
  }
}

describe("hasMarmonitorPlugin", () => {
  it("returns true when plugin line exists", async () => {
    await withTmpConf(
      "set -g @plugin 'tmux-plugins/tpm'\nset -g @plugin 'mjjo16/marmonitor-tmux'\n",
      async (confPath) => {
        assert.equal(await hasMarmonitorPlugin(confPath), true);
      },
    );
  });

  it("returns false when plugin line is absent", async () => {
    await withTmpConf("set -g @plugin 'tmux-plugins/tpm'\n", async (confPath) => {
      assert.equal(await hasMarmonitorPlugin(confPath), false);
    });
  });

  it("returns false for empty file", async () => {
    await withTmpConf("", async (confPath) => {
      assert.equal(await hasMarmonitorPlugin(confPath), false);
    });
  });

  it("returns false when file does not exist", async () => {
    assert.equal(await hasMarmonitorPlugin("/tmp/nonexistent-tmux-conf-12345"), false);
  });
});

describe("addMarmonitorPlugin", () => {
  it("appends plugin line to existing config", async () => {
    await withTmpConf("set -g @plugin 'tmux-plugins/tpm'\n", async (confPath) => {
      const result = await addMarmonitorPlugin(confPath);
      assert.equal(result, true);
      const content = await readFile(confPath, "utf-8");
      assert.ok(content.includes("set -g @plugin 'mjjo16/marmonitor-tmux'"));
    });
  });

  it("does not duplicate if already present", async () => {
    await withTmpConf("set -g @plugin 'mjjo16/marmonitor-tmux'\n", async (confPath) => {
      const result = await addMarmonitorPlugin(confPath);
      assert.equal(result, false); // already exists
      const content = await readFile(confPath, "utf-8");
      const count = content.split("marmonitor-tmux").length - 1;
      assert.equal(count, 1); // still only one
    });
  });

  it("creates file if it does not exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "marmonitor-test-"));
    const confPath = join(dir, ".tmux.conf");
    try {
      const result = await addMarmonitorPlugin(confPath);
      assert.equal(result, true);
      const content = await readFile(confPath, "utf-8");
      assert.ok(content.includes("set -g @plugin 'mjjo16/marmonitor-tmux'"));
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("preserves existing content when appending", async () => {
    const existing = "# my tmux config\nset -g status on\nset -g @plugin 'tmux-plugins/tpm'\n";
    await withTmpConf(existing, async (confPath) => {
      await addMarmonitorPlugin(confPath);
      const content = await readFile(confPath, "utf-8");
      assert.ok(content.startsWith("# my tmux config"));
      assert.ok(content.includes("set -g status on"));
      assert.ok(content.includes("tmux-plugins/tpm"));
      assert.ok(content.includes("mjjo16/marmonitor-tmux"));
    });
  });
});

describe("removeMarmonitorPlugin", () => {
  it("removes plugin line and keeps other lines", async () => {
    const content = [
      "set -g @plugin 'tmux-plugins/tpm'",
      "set -g @plugin 'mjjo16/marmonitor-tmux'",
      "set -g status on",
      "",
    ].join("\n");
    await withTmpConf(content, async (confPath) => {
      const result = await removeMarmonitorPlugin(confPath);
      assert.equal(result, true);
      const after = await readFile(confPath, "utf-8");
      assert.ok(!after.includes("marmonitor-tmux"));
      assert.ok(after.includes("tmux-plugins/tpm"));
      assert.ok(after.includes("set -g status on"));
    });
  });

  it("returns false when plugin line is not present", async () => {
    await withTmpConf("set -g @plugin 'tmux-plugins/tpm'\n", async (confPath) => {
      const result = await removeMarmonitorPlugin(confPath);
      assert.equal(result, false);
    });
  });

  it("returns false when file does not exist", async () => {
    const result = await removeMarmonitorPlugin("/tmp/nonexistent-tmux-conf-12345");
    assert.equal(result, false);
  });

  it("handles file with only marmonitor line", async () => {
    await withTmpConf("set -g @plugin 'mjjo16/marmonitor-tmux'\n", async (confPath) => {
      const result = await removeMarmonitorPlugin(confPath);
      assert.equal(result, true);
      const after = await readFile(confPath, "utf-8");
      assert.ok(!after.includes("marmonitor-tmux"));
    });
  });

  it("removes all occurrences if duplicated", async () => {
    const content = [
      "set -g @plugin 'mjjo16/marmonitor-tmux'",
      "set -g status on",
      "set -g @plugin 'mjjo16/marmonitor-tmux'",
      "",
    ].join("\n");
    await withTmpConf(content, async (confPath) => {
      await removeMarmonitorPlugin(confPath);
      const after = await readFile(confPath, "utf-8");
      assert.ok(!after.includes("marmonitor-tmux"));
      assert.ok(after.includes("set -g status on"));
    });
  });
});

describe("tmux integration inspection", () => {
  it("returns the default plugin directory under ~/.tmux/plugins", () => {
    assert.equal(
      getMarmonitorPluginDir("/Users/tester"),
      "/Users/tester/.tmux/plugins/marmonitor-tmux",
    );
  });

  it("detects a local run-shell integration", async () => {
    await withTmpConf(
      "run-shell ~/Documents/mjjo/marmonitor-tmux/marmonitor.tmux\n",
      async (confPath) => {
        const mode = await detectTmuxIntegrationMode(
          confPath,
          "/tmp/nonexistent-marmonitor-plugin",
        );
        assert.equal(mode, "local");
      },
    );
  });

  it("detects a configured-but-missing TPM plugin", async () => {
    await withTmpConf("set -g @plugin 'mjjo16/marmonitor-tmux'\n", async (confPath) => {
      const mode = await detectTmuxIntegrationMode(confPath, "/tmp/nonexistent-marmonitor-plugin");
      assert.equal(mode, "missing");
    });
  });

  it("detects a TPM checkout with git metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "marmonitor-plugin-"));
    const pluginDir = join(dir, "marmonitor-tmux");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(dir, ".tmux.conf"), "set -g @plugin 'mjjo16/marmonitor-tmux'\n", "utf-8");
    await writeFile(join(pluginDir, "marmonitor.tmux"), "#!/usr/bin/env bash\n", "utf-8");
    try {
      await writeFile(join(pluginDir, ".git"), "", "utf-8");
      const confPath = join(dir, ".tmux.conf");
      const mode = await detectTmuxIntegrationMode(confPath, pluginDir);
      assert.equal(mode, "tpm");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("detects a non-git plugin directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "marmonitor-plugin-"));
    const pluginDir = join(dir, "marmonitor-tmux");
    const confPath = join(dir, ".tmux.conf");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(confPath, "set -g @plugin 'mjjo16/marmonitor-tmux'\n", "utf-8");
    await writeFile(join(pluginDir, "marmonitor.tmux"), "#!/usr/bin/env bash\n", "utf-8");
    try {
      const mode = await detectTmuxIntegrationMode(confPath, pluginDir);
      assert.equal(mode, "not_git");
      assert.equal(await hasInstalledMarmonitorPlugin(pluginDir), true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
