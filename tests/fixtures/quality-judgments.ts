/**
 * Quality judgments for the Canopy website (canopy-website).
 *
 * Each judgment maps a query to expected results with graded relevance.
 * These run against a real Upstash index to catch ranking regressions,
 * score calibration drift, and semantic quality issues.
 */

export interface ExpectedResult {
  url: string;
  /** Must appear at or above this position (1-indexed). */
  minRank?: number;
  /** 0 = irrelevant, 1 = marginal, 2 = relevant, 3 = perfect match. */
  relevance: 0 | 1 | 2 | 3;
}

export interface Judgment {
  query: string;
  category:
    | "exact-keyword"
    | "semantic"
    | "question"
    | "gibberish"
    | "off-topic"
    | "edge-case";
  expected: ExpectedResult[];
  /** If true, the query should return no confident results. */
  expectEmpty?: boolean;
}

export const judgments: Judgment[] = [
  // ── Exact keyword queries ─────────────────────────────
  {
    query: "keyboard shortcuts",
    category: "exact-keyword",
    expected: [
      { url: "/docs/keyboard-shortcuts", minRank: 1, relevance: 3 }
    ]
  },
  {
    query: "recipes",
    category: "exact-keyword",
    expected: [
      { url: "/docs/recipes", minRank: 1, relevance: 3 }
    ]
  },
  {
    query: "copytree",
    category: "exact-keyword",
    expected: [
      { url: "/docs/copytree", minRank: 1, relevance: 3 }
    ]
  },
  {
    query: "download",
    category: "exact-keyword",
    expected: [
      { url: "/download", minRank: 1, relevance: 3 }
    ]
  },
  {
    query: "getting started",
    category: "exact-keyword",
    expected: [
      { url: "/docs/getting-started", minRank: 2, relevance: 3 }
    ]
  },
  {
    query: "settings",
    category: "exact-keyword",
    expected: [
      { url: "/docs/settings", minRank: 1, relevance: 3 }
    ]
  },
  {
    query: "troubleshooting",
    category: "exact-keyword",
    expected: [
      { url: "/docs/troubleshooting", minRank: 1, relevance: 3 }
    ]
  },
  {
    query: "security",
    category: "exact-keyword",
    expected: [
      { url: "/docs/security", minRank: 1, relevance: 3 }
    ]
  },
  {
    query: "sidecar browser",
    category: "exact-keyword",
    expected: [
      { url: "/docs/sidecar-browser", minRank: 1, relevance: 3 }
    ]
  },
  {
    query: "github integration",
    category: "exact-keyword",
    expected: [
      { url: "/docs/github-integration", minRank: 1, relevance: 3 }
    ]
  },

  // ── Semantic / paraphrase queries ─────────────────────
  {
    query: "vim mode",
    category: "semantic",
    expected: [
      { url: "/docs/keyboard-shortcuts", minRank: 1, relevance: 3 }
    ]
  },
  {
    query: "git worktrees",
    category: "semantic",
    expected: [
      { url: "/docs/projects-and-worktrees", minRank: 1, relevance: 3 }
    ]
  },
  {
    query: "AI agents",
    category: "semantic",
    expected: [
      { url: "/docs/agents", minRank: 1, relevance: 3 }
    ]
  },
  {
    query: "terminal panels",
    category: "semantic",
    expected: [
      { url: "/docs/terminals-and-panels", minRank: 1, relevance: 3 }
    ]
  },
  {
    query: "update canopy",
    category: "semantic",
    expected: [
      { url: "/docs/updates", minRank: 2, relevance: 3 }
    ]
  },

  // ── Natural language questions ────────────────────────
  {
    query: "how do I install canopy",
    category: "question",
    expected: [
      { url: "/docs/getting-started", minRank: 1, relevance: 3 }
    ]
  },
  {
    query: "what is the sidecar browser",
    category: "question",
    expected: [
      { url: "/docs/sidecar-browser", minRank: 1, relevance: 3 }
    ]
  },
  {
    query: "how to use multiple agents at once",
    category: "question",
    expected: [
      { url: "/docs/agents", minRank: 3, relevance: 2 }
    ]
  },
  {
    query: "how do I manage sessions",
    category: "question",
    expected: [
      { url: "/docs/session-management", minRank: 2, relevance: 3 }
    ]
  },
  {
    query: "where can I download canopy",
    category: "question",
    expected: [
      { url: "/download", minRank: 1, relevance: 3 }
    ]
  },

  // ── Gibberish queries — should return empty/low ───────
  {
    query: "asdfghjkl",
    category: "gibberish",
    expected: [],
    expectEmpty: true
  },
  {
    query: "xyzzy qwerty zxcvbn",
    category: "gibberish",
    expected: [],
    expectEmpty: true
  },
  {
    query: "aaaaaa bbbbbbb cccccc",
    category: "gibberish",
    expected: [],
    expectEmpty: true
  },

  // ── Off-topic queries — should return empty/low ───────
  {
    query: "machine learning neural networks",
    category: "off-topic",
    expected: [],
    expectEmpty: true
  },
  {
    query: "best pizza restaurant near me",
    category: "off-topic",
    expected: [],
    expectEmpty: true
  },
  {
    query: "python pandas dataframe tutorial",
    category: "off-topic",
    expected: [],
    expectEmpty: true
  },
  {
    query: "kubernetes pod scheduling affinity",
    category: "off-topic",
    expected: [],
    expectEmpty: true
  },

  // ── Edge cases ────────────────────────────────────────
  {
    query: "a",
    category: "edge-case",
    expected: [],
    expectEmpty: true
  },
  {
    query: "Cmd+K",
    category: "edge-case",
    expected: [
      { url: "/docs/keyboard-shortcuts", minRank: 2, relevance: 2 }
    ]
  },
  {
    query: "canopy",
    category: "edge-case",
    expected: [
      { url: "/", minRank: 5, relevance: 2 }
    ]
  }
];
