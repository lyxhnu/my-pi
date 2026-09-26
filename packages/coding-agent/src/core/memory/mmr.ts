/**
 * Maximal Marginal Relevance rerank for memory search results. Pure TS port of OMP mnemopi's MMR
 * fallback path: greedy selection of `lambda * relevance - (1 - lambda) * maxSimilarityToSelected`,
 * with word-set Jaccard as the similarity — cheap, deterministic, and needs no embeddings.
 */

const WORD_SEGMENTER = new Intl.Segmenter("zh-CN", { granularity: "word" });

/** Splits normalized Chinese, English, and mixed text into word-like tokens. */
function tokenize(text: string): Set<string> {
	const tokens = new Set<string>();
	for (const part of WORD_SEGMENTER.segment(text.normalize("NFKC").toLowerCase())) {
		if (part.isWordLike) tokens.add(part.segment);
	}
	return tokens;
}

/** Jaccard similarity over normalized word sets. Empty sides score 0. */
export function jaccardSimilarity(textA: string, textB: string): number {
	const wordsA = tokenize(textA);
	const wordsB = tokenize(textB);
	if (wordsA.size === 0 || wordsB.size === 0) return 0;
	let intersection = 0;
	for (const word of wordsA) {
		if (wordsB.has(word)) intersection += 1;
	}
	return intersection / (wordsA.size + wordsB.size - intersection);
}

export interface MmrCandidate<T> {
	item: T;
	/**
	 * Relevance normalized to 0..1. Term-count scores are unbounded, and feeding them in raw would
	 * drown the 0..1 similarity penalty — normalize before reranking.
	 */
	relevance: number;
	/** Full text the similarity penalty is computed over (heading + body, not just the snippet). */
	text: string;
}

/**
 * Greedy MMR: seed with the highest-relevance candidate, then repeatedly pick the remaining candidate
 * with the best `lambda * relevance - (1 - lambda) * maxSimilarityToSelected`. `topK <= 0` returns
 * nothing; a single candidate is returned as-is.
 */
export function mmrRerank<T>(candidates: MmrCandidate<T>[], lambda: number, topK: number): T[] {
	const limit = Math.max(0, Math.trunc(topK));
	if (limit <= 0) return [];
	if (candidates.length <= 1) return candidates.slice(0, limit).map((candidate) => candidate.item);

	const sorted = candidates.slice().sort((a, b) => b.relevance - a.relevance);
	const selected: MmrCandidate<T>[] = [sorted[0]!];
	const remaining = sorted.slice(1);

	while (remaining.length > 0 && selected.length < limit) {
		let bestIndex = 0;
		let bestScore = Number.NEGATIVE_INFINITY;
		for (let index = 0; index < remaining.length; index++) {
			const candidate = remaining[index]!;
			let maxSimilarity = 0;
			for (const chosen of selected) {
				const similarity = jaccardSimilarity(candidate.text, chosen.text);
				if (similarity > maxSimilarity) maxSimilarity = similarity;
			}
			const mmrScore = lambda * candidate.relevance - (1 - lambda) * maxSimilarity;
			if (mmrScore > bestScore) {
				bestScore = mmrScore;
				bestIndex = index;
			}
		}
		selected.push(remaining.splice(bestIndex, 1)[0]!);
	}

	return selected.map((candidate) => candidate.item);
}
