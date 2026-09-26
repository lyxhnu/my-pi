import { describe, expect, it } from "vitest";
import { jaccardSimilarity, type MmrCandidate, mmrRerank } from "../src/core/memory/mmr.ts";

describe("jaccardSimilarity", () => {
	it("returns 1 for identical texts", () => {
		expect(jaccardSimilarity("alpha beta gamma", "alpha beta gamma")).toBe(1);
	});

	it("is case-insensitive", () => {
		expect(jaccardSimilarity("Alpha BETA", "alpha beta")).toBe(1);
	});

	it("returns 0 for disjoint texts", () => {
		expect(jaccardSimilarity("alpha beta", "gamma delta")).toBe(0);
	});

	it("returns 0 when either side is empty", () => {
		expect(jaccardSimilarity("", "alpha")).toBe(0);
		expect(jaccardSimilarity("alpha", "   ")).toBe(0);
	});

	it("scores partial overlap as intersection over union", () => {
		// {a b c} vs {b c d}: intersection 2, union 4.
		expect(jaccardSimilarity("a b c", "b c d")).toBeCloseTo(0.5);
	});

	it("segments continuous Chinese text", () => {
		// {用户 喜欢 深色 主题 并 使用 中文 界面} vs {用户 偏好 深色 主题 使用 中文 界面}.
		expect(jaccardSimilarity("用户喜欢深色主题并使用中文界面", "用户偏好深色主题，使用中文界面")).toBeCloseTo(2 / 3);
	});

	it("segments English independently of punctuation", () => {
		expect(jaccardSimilarity("Alpha, beta! Gamma?", "alpha beta gamma")).toBe(1);
	});

	it("segments mixed Chinese and English text", () => {
		// {使用 typescript 编写 代码} vs {使用 typescript 测试 代码}: intersection 3, union 5.
		expect(jaccardSimilarity("使用 TypeScript 编写代码", "使用 TypeScript 测试代码")).toBeCloseTo(0.6);
	});
});

describe("mmrRerank", () => {
	function candidate(item: string, relevance: number, text: string): MmrCandidate<string> {
		return { item, relevance, text };
	}

	it("returns nothing for topK <= 0", () => {
		const pool = [candidate("a", 1, "alpha"), candidate("b", 0.5, "beta")];
		expect(mmrRerank(pool, 0.7, 0)).toEqual([]);
		expect(mmrRerank(pool, 0.7, -3)).toEqual([]);
	});

	it("returns a lone candidate as-is", () => {
		expect(mmrRerank([candidate("only", 0.2, "whatever text")], 0.7, 5)).toEqual(["only"]);
	});

	it("promotes a complementary result over near-duplicates of the top hit", () => {
		const duplicateText = "the build is verified with npm run check before every commit";
		const pool = [
			candidate("dup1", 0.9, duplicateText),
			candidate("dup2", 0.85, duplicateText),
			candidate("dup3", 0.8, duplicateText),
			candidate("distinct", 0.5, "session notes consolidate into project memory via autoDream"),
		];
		// dup2/dup3 score 0.7*rel - 0.3*1 < 0.7*0.5 - 0.3*0, so the distinct entry takes the second slot.
		expect(mmrRerank(pool, 0.7, 2)).toEqual(["dup1", "distinct"]);
	});

	it("degenerates to pure relevance order at lambda = 1", () => {
		const sharedText = "identical text everywhere";
		const pool = [
			candidate("mid", 0.5, sharedText),
			candidate("top", 0.9, sharedText),
			candidate("low", 0.1, "something else entirely"),
		];
		expect(mmrRerank(pool, 1, 3)).toEqual(["top", "mid", "low"]);
	});

	it("picks the least similar second result at lambda = 0", () => {
		const pool = [
			candidate("seed", 0.9, "x y z"),
			candidate("similar", 0.8, "x y w"),
			candidate("disjoint", 0.1, "p q r"),
		];
		const picked = mmrRerank(pool, 0, 2);
		expect(picked[0]).toBe("seed");
		expect(picked[1]).toBe("disjoint");
	});

	it("returns every candidate exactly once when topK exceeds the pool", () => {
		const pool = [
			candidate("a", 0.9, "alpha one"),
			candidate("b", 0.8, "alpha two"),
			candidate("c", 0.1, "gamma three"),
		];
		const picked = mmrRerank(pool, 0.7, 10);
		expect(picked).toHaveLength(3);
		expect(new Set(picked).size).toBe(3);
	});
});
