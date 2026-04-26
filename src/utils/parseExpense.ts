import Fuse from "fuse.js";
import {
  subDays,
  subWeeks,
  startOfWeek,
  nextDay,
  previousDay,
  parse,
  isValid,
  format,
} from "date-fns";

export interface ParsedExpense {
  itemName: string;
  amount: number | null;
  suggestedCategory?: string;
  confidence?: number;
  parsedDate?: string; // ISO yyyy-MM-dd, undefined = today
  raw: string;
}

const AMOUNT_RE = /(?:^|\s)\$?(\d+(?:\.\d{1,2})?)(?=\s|$)/;

// Date token patterns, ordered most-specific first
const DATE_PATTERNS: { re: RegExp; resolve: (m: RegExpMatchArray) => Date | null }[] = [
  { re: /\byesterday\b/i, resolve: () => subDays(new Date(), 1) },
  { re: /\btoday\b/i, resolve: () => new Date() },
  {
    re: /\b(\d{1,2})\s*(days?)\s*ago\b/i,
    resolve: (m) => subDays(new Date(), parseInt(m[1])),
  },
  {
    re: /\blast\s+week\b/i,
    resolve: () => subWeeks(new Date(), 1),
  },
  {
    re: /\blast\s+(mon|tue|wed|thu|fri|sat|sun)\w*/i,
    resolve: (m) => {
      const day = ["sun","mon","tue","wed","thu","fri","sat"].indexOf(m[1].toLowerCase().slice(0,3));
      if (day < 0) return null;
      return previousDay(subDays(new Date(), 1), day as 0|1|2|3|4|5|6);
    },
  },
  // "22 Apr" / "Apr 22"
  {
    re: /\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*/i,
    resolve: (m) => {
      const d = parse(`${m[1]} ${m[2]}`, "d MMM", new Date());
      return isValid(d) ? d : null;
    },
  },
  {
    re: /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+(\d{1,2})\b/i,
    resolve: (m) => {
      const d = parse(`${m[1]} ${m[2]}`, "MMM d", new Date());
      return isValid(d) ? d : null;
    },
  },
];

export function parseExpense(
  raw: string,
  mappings: Record<string, string>
): ParsedExpense {
  const text = raw.trim();
  const result: ParsedExpense = { itemName: "", amount: null, raw: text };
  if (!text) return result;

  let working = text;

  // 1. Extract date token
  for (const { re, resolve } of DATE_PATTERNS) {
    const m = working.match(re);
    if (m) {
      const d = resolve(m);
      if (d && isValid(d)) {
        result.parsedDate = format(d, "yyyy-MM-dd");
        working = working.replace(m[0], " ").replace(/\s+/g, " ").trim();
        break;
      }
    }
  }

  // 2. Extract amount
  const amtMatch = working.match(AMOUNT_RE);
  if (amtMatch) {
    result.amount = parseFloat(amtMatch[1]);
    working = working.replace(amtMatch[0], " ").replace(/\s+/g, " ").trim();
  }

  result.itemName = working.trim();

  if (!result.itemName) return result;

  const lower = result.itemName.toLowerCase();

  // 3. Category lookup
  if (mappings[lower]) {
    result.suggestedCategory = mappings[lower];
    result.confidence = 1;
    return result;
  }

  const keys = Object.keys(mappings);
  if (keys.length) {
    const fuse = new Fuse(keys, { threshold: 0.4, includeScore: true });
    const hit = fuse.search(lower)[0];
    if (hit) {
      result.suggestedCategory = mappings[hit.item];
      result.confidence = 1 - (hit.score ?? 0);
    }
  }

  return result;
}
