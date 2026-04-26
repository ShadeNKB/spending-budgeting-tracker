import type { ItemCategoryPattern } from "./types";

export const DEFAULT_CATEGORIES: string[] = [
  "Food & Dining",
  "Gaming",
  "Social & Leisure",
  "Transportation",
  "Shopping",
  "Healthcare",
  "Grooming",
  "Subscriptions",
  "Investment",
  "Travel",
  "Other",
];

// Flat category renames — applied first
export const CATEGORY_MIGRATIONS: Record<string, string> = {
  "Bills & Utilities": "Travel",
  "Education": "Subscriptions",
};

// Item-name keyword overrides — applied after flat renames, most specific wins
export const ITEM_CATEGORY_PATTERNS: ItemCategoryPattern[] = [
  {
    category: "Gaming",
    fromCategories: ["Entertainment", "Social & Leisure"],
    keywords: [
      "valorant", "call of duty", "cod", "fortnite", "fnfn", "nintendo",
      "ps4", "ps5", "ps3", "playstation", "xbox", "steam", "csgo", "warzone",
      "game", "gaming", "minecraft", "roblox", "league of legends", "lol",
      "overwatch", "apex", "battlefield", "fifa", "ea fc",
    ],
  },
  {
    category: "Subscriptions",
    fromCategories: ["Entertainment", "Education", "Other", "Investment"],
    keywords: [
      "disney+", "disney plus", "netflix", "spotify", "youtube premium",
      "apple tv", "hbo", "prime video", "chatgpt", "claude", "deepstash",
      "tradezella", "kimi ai", "kimi", "google storage", "google one",
      "icloud", "apple storage", "notion", "github", "figma", "canva",
    ],
  },
  {
    category: "Grooming",
    fromCategories: ["Other", "Healthcare"],
    keywords: [
      "haircut", "hair cut", "barber", "hairdresser", "hair salon",
      "trim", "shave", "wax", "nails", "nail salon", "manicure", "pedicure",
    ],
  },
  {
    category: "Social & Leisure",
    fromCategories: ["Entertainment", "Other"],
    keywords: [
      "pool", "billiard", "bowling", "club", "clubbing", "bar ",
      "alcohol", "gambling", "casino", "nights out", "night out",
      "pub", "drinks", "beer", "wine", "cocktail", "nightclub",
    ],
  },
  {
    category: "Shopping",
    fromCategories: ["Other"],
    keywords: ["jersey", "uniform", "kit", "gear"],
  },
  {
    category: "Travel",
    fromCategories: ["Bills & Utilities", "Other", "Travel"],
    keywords: [
      "euro exchange", "exchange rate", "currency exchange",
      "youtrip", "esim", "e-sim", "travel card",
    ],
  },
];

export const DEBOUNCE_SAVE_MS = 2000;
export const SAVE_FEEDBACK_MS = 1000;
export const SAVE_DELAY_MS = 500;
export const FUSE_THRESHOLD = 0.3;
export const FUSE_SCORE_CUTOFF = 0.4;
export const AI_SUGGESTION_DEBOUNCE_MS = 300;
export const AI_THINKING_DELAY_MS = 500;
export const MAX_RECENT_TRANSACTIONS = 5;
export const ITEMS_PER_PAGE = 10;
export const NOTIFICATION_DURATION_MS = 4000;
export const LOAD_DELAY_MS = 500;
export const MIN_ITEM_NAME_LENGTH = 2;
