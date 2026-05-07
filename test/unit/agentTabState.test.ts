import { describe, it, expect } from "vitest";
import { AgentTabStateMap } from "../../src/agentTabState";

describe("AgentTabStateMap", () => {
	// ── upsert ───────────────────────────────────────────────────────────────

	it("upsert inserts a new entry with correct defaults", () => {
		const m = new AgentTabStateMap();
		const tab = m.upsert("t1", { title: "Pi Agent" });
		expect(tab.terminalId).toBe("t1");
		expect(tab.title).toBe("Pi Agent");
		expect(tab.agentState).toBe("clear");
		expect(tab.index).toBe(0);
		expect(tab.breakdown).toBeNull();
		expect(tab.cost).toBeNull();
	});

	it("upsert is idempotent: second call updates fields without changing index", () => {
		const m = new AgentTabStateMap();
		m.upsert("t1", { title: "Tab 1" });
		m.upsert("t2", { title: "Tab 2" });
		const updated = m.upsert("t1", { model: "claude-sonnet-4" });
		// index must be unchanged (0 — first insertion)
		expect(updated.index).toBe(0);
		expect(updated.model).toBe("claude-sonnet-4");
		expect(updated.title).toBe("Tab 1");
		// map size must not grow
		expect(m.size).toBe(2);
	});

	it("upsert does not reorder existing entries", () => {
		const m = new AgentTabStateMap();
		m.upsert("t1", {});
		m.upsert("t2", {});
		m.upsert("t3", {});
		m.upsert("t2", { model: "updated" }); // update middle entry
		const ids = m.toArray().map((t) => t.terminalId);
		expect(ids).toEqual(["t1", "t2", "t3"]);
	});

	// ── getCurrent ───────────────────────────────────────────────────────────

	it("getCurrent returns undefined when map is empty", () => {
		const m = new AgentTabStateMap();
		expect(m.getCurrent()).toBeUndefined();
	});

	it("getCurrent returns undefined when no current is set", () => {
		const m = new AgentTabStateMap();
		m.upsert("t1", {});
		expect(m.getCurrent()).toBeUndefined();
	});

	it("getCurrent returns the set current tab", () => {
		const m = new AgentTabStateMap();
		m.upsert("t1", { title: "Tab 1" });
		m.upsert("t2", { title: "Tab 2" });
		m.setCurrent("t2");
		expect(m.getCurrent()?.terminalId).toBe("t2");
	});

	// ── remove ───────────────────────────────────────────────────────────────

	it("getCurrent returns undefined after the current tab is removed (no silent advance)", () => {
		const m = new AgentTabStateMap();
		m.upsert("t1", {});
		m.upsert("t2", {});
		m.setCurrent("t1");
		m.remove("t1");
		// Must not silently advance to t2
		expect(m.getCurrent()).toBeUndefined();
		expect(m.currentId).toBeNull();
	});

	it("remove returns false for unknown terminalId", () => {
		const m = new AgentTabStateMap();
		expect(m.remove("nonexistent")).toBe(false);
	});

	it("remove returns true and shrinks the map for a known terminalId", () => {
		const m = new AgentTabStateMap();
		m.upsert("t1", {});
		expect(m.remove("t1")).toBe(true);
		expect(m.size).toBe(0);
		expect(m.get("t1")).toBeUndefined();
	});

	// ── forEach / insertion order ────────────────────────────────────────────

	it("forEach iterates in insertion order", () => {
		const m = new AgentTabStateMap();
		m.upsert("t3", {});
		m.upsert("t1", {});
		m.upsert("t2", {});
		const ids: string[] = [];
		m.forEach((_, id) => ids.push(id));
		expect(ids).toEqual(["t3", "t1", "t2"]);
	});

	it("forEach skips removed entries", () => {
		const m = new AgentTabStateMap();
		m.upsert("t1", {});
		m.upsert("t2", {});
		m.upsert("t3", {});
		m.remove("t2");
		const ids: string[] = [];
		m.forEach((_, id) => ids.push(id));
		expect(ids).toEqual(["t1", "t3"]);
	});

	// ── setCurrent ───────────────────────────────────────────────────────────

	it("setCurrent throws for an unknown terminalId", () => {
		const m = new AgentTabStateMap();
		expect(() => m.setCurrent("ghost")).toThrow(/unknown terminalId/);
	});

	it("setCurrent does not throw for a known terminalId", () => {
		const m = new AgentTabStateMap();
		m.upsert("t1", {});
		expect(() => m.setCurrent("t1")).not.toThrow();
		expect(m.currentId).toBe("t1");
	});

	// ── toArray ──────────────────────────────────────────────────────────────

	it("toArray returns empty array for empty map", () => {
		const m = new AgentTabStateMap();
		expect(m.toArray()).toEqual([]);
	});

	it("toArray returns entries in insertion order with correct index values", () => {
		const m = new AgentTabStateMap();
		m.upsert("t1", { title: "A" });
		m.upsert("t2", { title: "B" });
		m.upsert("t3", { title: "C" });
		const arr = m.toArray();
		expect(arr.map((t) => t.terminalId)).toEqual(["t1", "t2", "t3"]);
		expect(arr.map((t) => t.index)).toEqual([0, 1, 2]);
	});
});
