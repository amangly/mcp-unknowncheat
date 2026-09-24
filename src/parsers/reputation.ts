import type { Cheerio, CheerioAPI } from "cheerio";
import type { Element } from "domhandler";

export type RepSign = "positive" | "negative" | "neutral" | "unknown";
export type RepTier =
  | "legend"
  | "excellent"
  | "great"
  | "good"
  | "average"
  | "positive"
  | "novice"
  | "neutral"
  | "negative"
  | "unknown";

export interface AuthorReputation {
  score: number | null;
  power: number | null;
  dots: number;
  positiveDots: number;
  highPositiveDots: number;
  negativeDots: number;
  neutralDots: number;
  sign: RepSign;
  tier: RepTier;
  description?: string;
  trustScore: number;
}

function classifyBySrc(src: string): "highpos" | "pos" | "neg" | "neutral" | "unknown" {
  const s = src.toLowerCase();
  if (s.includes("reputation_highpos") || s.includes("rep_highpos")) return "highpos";
  if (s.includes("reputation_pos") || s.includes("rep_pos")) return "pos";
  if (s.includes("reputation_neg") || s.includes("rep_neg")) return "neg";
  if (s.includes("reputation_bar") || s.includes("rep_bar")) return "neutral";
  return "unknown";
}

function computeTier(score: number | null, sign: RepSign, negativeDots: number): RepTier {
  if (sign === "negative" || negativeDots > 0) return "negative";
  if (score === null) return sign === "neutral" ? "neutral" : "unknown";

  if (score >= 5_000) return "legend";
  if (score >= 2_000) return "excellent";
  if (score >= 1_000) return "great";
  if (score >= 500) return "good";
  if (score >= 100) return "average";
  if (score >= 10) return "positive";
  if (score > 0) return "novice";
  if (score === 0) return "neutral";
  return "negative";
}

function computeTrustScore(score: number | null, negativeDots: number, dots: number): number {
  if (negativeDots > 0) return 5;

  const base = score ?? 0;
  if (base <= 0) return dots > 0 ? 25 : 15;

  const log = Math.log10(base + 1) * 20;
  const clamped = Math.min(100, Math.round(log));
  return Math.max(15, clamped);
}

export function parseReputationInPost($: CheerioAPI, postCell: Cheerio<Element>): AuthorReputation {
  const infoText = postCell.find(".info").text();

  const scoreMatch = infoText.match(/Reputation:\s*([-\d,]+)/i);
  const score = scoreMatch ? parseInt(scoreMatch[1].replace(/,/g, ""), 10) : null;

  const powerMatch = infoText.match(/Rep\s*Power:\s*([-\d,]+)/i);
  const power = powerMatch ? parseInt(powerMatch[1].replace(/,/g, ""), 10) : null;

  let highPositiveDots = 0;
  let positiveDots = 0;
  let negativeDots = 0;
  let neutralDots = 0;
  let description: string | undefined;

  const dotsContainer = postCell.find("[id^='repinfoDots_']").first();
  const dotsScope = dotsContainer.length > 0 ? dotsContainer : postCell;

  dotsScope.find("img").each((_, el) => {
    const src = $(el).attr("src") ?? "";
    const kind = classifyBySrc(src);
    if (kind === "highpos") highPositiveDots++;
    else if (kind === "pos") positiveDots++;
    else if (kind === "neg") negativeDots++;
    else if (kind === "neutral") neutralDots++;

    if (!description && kind !== "unknown") {
      const alt = ($(el).attr("alt") ?? "").trim();
      if (alt && !/^add to|^take from/i.test(alt)) {
        description = alt;
      }
    }
  });

  const dots = highPositiveDots + positiveDots + negativeDots + neutralDots;

  let sign: RepSign;
  if (negativeDots > 0) sign = "negative";
  else if (highPositiveDots > 0 || positiveDots > 0) sign = "positive";
  else if (neutralDots > 0) sign = "neutral";
  else if (score !== null) {
    if (score > 0) sign = "positive";
    else if (score < 0) sign = "negative";
    else sign = "neutral";
  } else {
    sign = "unknown";
  }

  const tier = computeTier(score, sign, negativeDots);
  const trustScore = computeTrustScore(score, negativeDots, dots);

  return {
    score,
    power,
    dots,
    positiveDots,
    highPositiveDots,
    negativeDots,
    neutralDots,
    sign,
    tier,
    description,
    trustScore,
  };
}
