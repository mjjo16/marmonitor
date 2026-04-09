import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BADGE_THEMES,
  renderAttention,
  renderAttentionActive,
  renderBadge,
  renderFocus,
  resolveTheme,
} from "../dist/output/badge-themes.js";

describe("resolveTheme", () => {
  it("resolves all six built-in badge styles", () => {
    for (const style of ["basic", "basic-mono", "block", "block-mono", "text", "text-mono"]) {
      const theme = resolveTheme(style);
      assert.ok(theme.badge, `${style} should have a badge template`);
      assert.ok(theme.attention, `${style} should have an attention template`);
      assert.ok(theme.attentionActive, `${style} should have an attentionActive template`);
      assert.ok(theme.focus, `${style} should have a focus template`);
      assert.ok(theme.empty, `${style} should have an empty template`);
      assert.ok(theme.jumpBack, `${style} should have a jumpBack template`);
    }
  });

  it("falls back to basic for unknown style names", () => {
    assert.deepEqual(resolveTheme("nonexistent"), BADGE_THEMES.basic);
  });
});

describe("block badge themes", () => {
  it("block theme contains background colors", () => {
    const theme = BADGE_THEMES.block;
    assert.match(theme.badge, /bg=/);
    assert.match(theme.attention, /bg=/);
  });

  it("block theme does not contain Powerline glyphs", () => {
    const theme = BADGE_THEMES.block;
    const allTemplates = [
      theme.badge,
      theme.attention,
      theme.attentionActive,
      theme.focus,
      theme.empty,
      theme.jumpBack,
    ];
    for (const tmpl of allTemplates) {
      assert.doesNotMatch(tmpl, /\uE0B0/, "should not contain U+E0B0");
      assert.doesNotMatch(tmpl, /\uE0B2/, "should not contain U+E0B2");
      assert.doesNotMatch(tmpl, /\uE0B4/, "should not contain U+E0B4");
      assert.doesNotMatch(tmpl, /\uE0B6/, "should not contain U+E0B6");
    }
  });

  it("block-mono theme does not contain Powerline glyphs", () => {
    const theme = BADGE_THEMES["block-mono"];
    const allTemplates = [
      theme.badge,
      theme.attention,
      theme.attentionActive,
      theme.focus,
      theme.empty,
      theme.jumpBack,
    ];
    for (const tmpl of allTemplates) {
      assert.doesNotMatch(tmpl, /\uE0B0/, "should not contain U+E0B0");
      assert.doesNotMatch(tmpl, /\uE0B2/, "should not contain U+E0B2");
      assert.doesNotMatch(tmpl, /\uE0B4/, "should not contain U+E0B4");
      assert.doesNotMatch(tmpl, /\uE0B6/, "should not contain U+E0B6");
    }
  });

  it("block-mono uses monochrome palette only", () => {
    const theme = BADGE_THEMES["block-mono"];
    assert.doesNotMatch(theme.badge, /\{fg\}/, "should not use dynamic fg color");
    assert.doesNotMatch(theme.badge, /\{bg\}/, "should not use dynamic bg color");
  });

  it("basic themes still contain Powerline glyphs for comparison", () => {
    const basic = BADGE_THEMES.basic;
    const hasGlyph = /[\uE0B0\uE0B2\uE0B4\uE0B6]/;
    assert.match(basic.badge, hasGlyph, "basic badge should use Powerline separators");
    assert.match(basic.attention, hasGlyph, "basic attention should use Powerline separators");
  });
});

describe("renderBadge with block themes", () => {
  it("renders block badge with substituted colors", () => {
    const theme = resolveTheme("block");
    const result = renderBadge(theme, "Cl 3", "#cdd6f4", "#89b4fa");
    assert.match(result, /Cl 3/);
    assert.match(result, /fg=#cdd6f4/);
    assert.match(result, /bg=#89b4fa/);
    assert.doesNotMatch(result, /[\uE0B0\uE0B2\uE0B4\uE0B6]/);
  });

  it("renders block-mono badge without dynamic color placeholders", () => {
    const theme = resolveTheme("block-mono");
    const result = renderBadge(theme, "Cx 1", "#cdd6f4", "#89b4fa");
    assert.match(result, /Cx 1/);
    assert.match(result, /bg=#313244/);
    assert.doesNotMatch(result, /[\uE0B0\uE0B2\uE0B4\uE0B6]/);
  });
});

describe("renderAttention with block themes", () => {
  it("renders block attention pill with index and label", () => {
    const theme = resolveTheme("block");
    const result = renderAttention(theme, 1, "⏳Cl projects/myapp allow", "#f38ba8");
    assert.match(result, / 1 /);
    assert.match(result, /⏳Cl projects\/myapp allow/);
    assert.match(result, /bg=#f38ba8/);
    assert.doesNotMatch(result, /[\uE0B0\uE0B2\uE0B4\uE0B6]/);
  });
});

describe("renderAttentionActive", () => {
  it("renders active attention pill with underscore styling", () => {
    const theme = resolveTheme("basic");
    const result = renderAttentionActive(theme, 1, "⏳Cl projects/myapp allow", "#f38ba8");
    assert.match(result, / 1 /);
    assert.match(result, /⏳Cl projects\/myapp allow/);
    assert.match(result, /underscore/);
    assert.match(result, /bg=#f38ba8/);
  });

  it("renders active attention pill differently from normal attention", () => {
    const theme = resolveTheme("basic");
    const normal = renderAttention(theme, 1, "test label", "#f38ba8");
    const active = renderAttentionActive(theme, 1, "test label", "#f38ba8");
    assert.notEqual(normal, active);
    assert.match(active, /underscore/);
    assert.doesNotMatch(normal, /underscore/);
  });

  it("renders block style active pill without Powerline glyphs", () => {
    const theme = resolveTheme("block");
    const result = renderAttentionActive(theme, 2, "🤔Cx api 5s", "#cba6f7");
    assert.match(result, / 2 /);
    assert.match(result, /🤔Cx api 5s/);
    assert.match(result, /underscore/);
    assert.doesNotMatch(result, /[\uE0B0\uE0B2\uE0B4\uE0B6]/);
  });

  it("uses brighter background for active pill label area", () => {
    const theme = resolveTheme("basic");
    const active = renderAttentionActive(theme, 1, "label", "#f38ba8");
    assert.match(active, /bg=#45475a/);
  });

  it("works for all six themes", () => {
    for (const style of ["basic", "basic-mono", "block", "block-mono", "text", "text-mono"]) {
      const theme = resolveTheme(style);
      const result = renderAttentionActive(theme, 1, "test", "#f38ba8");
      assert.ok(result, `${style} should render attentionActive`);
      assert.match(result, /test/, `${style} should contain the label`);
      assert.match(result, /1/, `${style} should contain the index`);
    }
  });
});

describe("renderFocus with block themes", () => {
  it("renders focus text in block style with background", () => {
    const theme = resolveTheme("block");
    const result = renderFocus(theme, "⏳ Claude myapp allow");
    assert.match(result, /⏳ Claude myapp allow/);
    assert.match(result, /bg=#181825/);
  });
});
