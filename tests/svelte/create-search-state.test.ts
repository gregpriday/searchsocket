import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tick } from "svelte";
import { createSearch } from "../../src/svelte/index.svelte";
import type { SearchResponse, SearchResult } from "../../src/types";

function result(title: string): SearchResult {
  return { url: `/${title.toLowerCase()}`, title, snippet: `About ${title}`, score: 0.9 };
}

function response(results: SearchResult[]): SearchResponse {
  return { q: "test", scope: "", results, meta: { timingsMs: { search: 1, total: 2 } } };
}

function okFetch(results: SearchResult[]) {
  // A fresh Response per call: a body can only be read once, so a shared
  // instance makes every request after the first fail to parse.
  return vi.fn<typeof fetch>().mockImplementation(
    async () =>
      new Response(JSON.stringify(response(results)), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
  );
}

async function settle(ms = 300) {
  // Let the effect run and schedule the debounce timer before advancing it.
  await tick();
  vi.advanceTimersByTime(ms);
  for (let i = 0; i < 5; i += 1) {
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await tick();
  }
}

describe("createSearch — status, resolvedQuery, clear and retry", () => {
  let cleanup: Array<() => void> = [];

  function tracked<T extends { destroy: () => void }>(instance: T): T {
    cleanup.push(() => instance.destroy());
    return instance;
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    cleanup = [];
  });

  afterEach(() => {
    cleanup.forEach((fn) => fn());
    vi.useRealTimers();
  });

  describe("status", () => {
    it("starts idle", () => {
      const search = tracked(createSearch({ fetchImpl: okFetch([]) }));
      expect(search.status).toBe("idle");
      expect(search.hasSearched).toBe(false);
      expect(search.resolvedQuery).toBe("");
    });

    it("moves idle → debouncing → loading → success", async () => {
      // A fetch held open lets the "loading" state be observed, rather than
      // skipping straight from debouncing to success.
      let release!: (value: Response) => void;
      const pending = new Promise<Response>((resolve) => {
        release = resolve;
      });
      const fetchImpl = vi.fn<typeof fetch>().mockReturnValue(pending);
      const search = tracked(createSearch({ fetchImpl }));

      expect(search.status).toBe("idle");

      search.query = "deploy";
      await tick();
      expect(search.status).toBe("debouncing");
      expect(fetchImpl).not.toHaveBeenCalled();

      vi.advanceTimersByTime(300);
      await tick();
      expect(search.status).toBe("loading");
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      release(
        new Response(JSON.stringify(response([result("Deploy")])), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      );
      await settle();

      expect(search.status).toBe("success");
      expect(search.hasSearched).toBe(true);
      expect(search.resolvedQuery).toBe("deploy");
    });

    it("reports empty separately from idle", async () => {
      const search = tracked(createSearch({ fetchImpl: okFetch([]) }));
      search.query = "nothing";
      await settle();

      expect(search.status).toBe("empty");
      expect(search.results).toEqual([]);
      expect(search.hasSearched).toBe(true);
    });

    it("reports error and keeps the query that failed", async () => {
      const failing = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));
      const search = tracked(createSearch({ fetchImpl: failing }));

      search.query = "deploy";
      await settle();

      expect(search.status).toBe("error");
      expect(search.error?.message).toBe("offline");
      expect(search.resolvedQuery).toBe("deploy");
    });

    it("returns to idle when the query is emptied", async () => {
      const search = tracked(createSearch({ fetchImpl: okFetch([result("Deploy")]) }));
      search.query = "deploy";
      await settle();

      search.query = "";
      await tick();

      expect(search.status).toBe("idle");
      expect(search.results).toEqual([]);
      expect(search.resolvedQuery).toBe("");
    });
  });

  describe("resolvedQuery", () => {
    it("lags the live query while the next search is in flight", async () => {
      const fetchImpl = okFetch([result("Deploy")]);
      const search = tracked(createSearch({ fetchImpl }));

      search.query = "deploy";
      await settle();
      expect(search.resolvedQuery).toBe("deploy");

      search.query = "deployment";
      await tick();

      // Results from "deploy" are still on screen; highlighting them against
      // the new query is exactly the bug resolvedQuery prevents.
      expect(search.results).toHaveLength(1);
      expect(search.resolvedQuery).toBe("deploy");

      await settle();
      expect(search.resolvedQuery).toBe("deployment");
    });
  });

  describe("keepPreviousResults", () => {
    it("keeps previous results by default", async () => {
      const search = tracked(createSearch({ fetchImpl: okFetch([result("Deploy")]) }));
      search.query = "deploy";
      await settle();

      search.query = "deployment";
      await tick();
      expect(search.results).toHaveLength(1);
    });

    it("clears them when asked", async () => {
      const search = tracked(
        createSearch({ fetchImpl: okFetch([result("Deploy")]), keepPreviousResults: false })
      );
      search.query = "deploy";
      await settle();

      search.query = "deployment";
      await tick();
      expect(search.results).toHaveLength(0);
      expect(search.resolvedQuery).toBe("");
    });
  });

  describe("minQueryLength", () => {
    it("does not search below the threshold", async () => {
      const fetchImpl = okFetch([result("Deploy")]);
      const search = tracked(createSearch({ fetchImpl, minQueryLength: 3 }));

      search.query = "de";
      await settle();
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(search.status).toBe("idle");

      search.query = "dep";
      await settle();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(search.status).toBe("success");
    });

    it("defaults to searching any non-empty query", async () => {
      const fetchImpl = okFetch([result("Deploy")]);
      const search = tracked(createSearch({ fetchImpl }));

      search.query = "d";
      await settle();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
  });

  describe("clear", () => {
    it("resets query, results and hasSearched", async () => {
      const search = tracked(createSearch({ fetchImpl: okFetch([result("Deploy")]) }));
      search.query = "deploy";
      await settle();
      expect(search.hasSearched).toBe(true);

      search.clear();
      await tick();

      expect(search.query).toBe("");
      expect(search.results).toEqual([]);
      expect(search.status).toBe("idle");
      expect(search.hasSearched).toBe(false);
    });
  });

  describe("clear atomicity", () => {
    it("resets every field synchronously", async () => {
      const search = tracked(createSearch({ fetchImpl: okFetch([result("Deploy")]) }));
      search.query = "deploy";
      await settle();
      expect(search.results).toHaveLength(1);

      search.clear();

      // No await: a consumer reading straight after clear() must not still see
      // the previous query's rows.
      expect(search.query).toBe("");
      expect(search.results).toEqual([]);
      expect(search.status).toBe("idle");
      expect(search.resolvedQuery).toBe("");
      expect(search.error).toBeNull();
      expect(search.loading).toBe(false);
      expect(search.hasSearched).toBe(false);
    });
  });

  describe("retry", () => {
    it("re-runs the current query without mutating it", async () => {
      let fail = true;
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => {
        if (fail) throw new Error("offline");
        return new Response(JSON.stringify(response([result("Deploy")])), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });
      const search = tracked(createSearch({ fetchImpl }));

      search.query = "deploy";
      await settle();
      expect(search.status).toBe("error");

      fail = false;
      search.retry();
      await settle();

      expect(search.query).toBe("deploy");
      expect(search.status).toBe("success");
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it("bypasses the cache", async () => {
      const fetchImpl = okFetch([result("Deploy")]);
      const search = tracked(createSearch({ fetchImpl }));

      search.query = "deploy";
      await settle();
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      // A repeat of the same query is served from cache...
      search.query = "";
      await tick();
      search.query = "deploy";
      await settle();
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      // ...but retry deliberately goes back to the network.
      search.retry();
      await settle();
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it("does not transfer its cache bypass to a different query", async () => {
      const fetchImpl = okFetch([result("Deploy")]);
      const search = tracked(createSearch({ fetchImpl }));

      search.query = "deploy";
      await settle();
      search.query = "guide";
      await settle();
      expect(fetchImpl).toHaveBeenCalledTimes(2);

      search.query = "";
      await settle();

      // Both calls coalesce into one effect run for "deploy", so the retry
      // applies to it — and "guide" is still served from cache afterwards.
      search.retry();
      search.query = "deploy";
      await settle();
      expect(fetchImpl).toHaveBeenCalledTimes(2);

      search.query = "guide";
      await settle();
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it("does nothing harmful with an empty query", async () => {
      const fetchImpl = okFetch([]);
      const search = tracked(createSearch({ fetchImpl }));

      search.retry();
      await settle();

      expect(fetchImpl).not.toHaveBeenCalled();
      expect(search.status).toBe("idle");
    });
  });

  describe("cache identity", () => {
    it("keys the cache on the query exactly as typed", async () => {
      const fetchImpl = okFetch([result("Deploy")]);
      const search = tracked(createSearch({ fetchImpl }));

      search.query = "deploy guide";
      await settle();
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      // An identical repeat is served from cache...
      search.query = "";
      await settle();
      search.query = "deploy guide";
      await settle();
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      // ...but a whitespace variant is a different query. Collapsing it here
      // would let one query serve another's cached response, and a custom
      // endpoint is free to treat the two differently.
      search.query = "  deploy   guide  ";
      await settle();
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it("sends the query exactly as typed", async () => {
      const fetchImpl = okFetch([result("Deploy")]);
      const search = tracked(createSearch({ fetchImpl }));

      search.query = " deploy ";
      await settle();

      const body = JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body));
      expect(body.q).toBe(" deploy ");
    });
  });
});
