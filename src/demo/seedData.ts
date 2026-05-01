import { format, subDays } from "date-fns";
import type { Expense, CategoryBudgets, CategoryMappings } from "../types";

const today = new Date();
const d = (daysAgo: number): string =>
  format(subDays(today, daysAgo), "yyyy-MM-dd");
const ts = (daysAgo: number): string =>
  `${d(daysAgo)}T12:00:00`;

// 60 entries across 10 weeks — realistic Singapore daily life
// Mix of hawker, transport, subscriptions, groceries, leisure, health
const RAW: { name: string; amount: number; cat: string; daysAgo: number }[] = [
  // Today
  { name: "Kopi O at kopitiam",        amount: 1.20,  cat: "Food & Dining",   daysAgo: 0 },
  { name: "Grab to work",              amount: 13.40, cat: "Transportation",   daysAgo: 0 },

  // Yesterday
  { name: "Chicken rice",              amount: 4.50,  cat: "Food & Dining",   daysAgo: 1 },
  { name: "Netflix",                   amount: 15.98, cat: "Subscriptions",   daysAgo: 1 },
  { name: "Watsons — moisturiser",     amount: 24.90, cat: "Grooming",        daysAgo: 1 },

  // 2 days ago
  { name: "NTUC FairPrice",            amount: 72.35, cat: "Groceries",       daysAgo: 2 },
  { name: "Mala xiang guo",            amount: 14.80, cat: "Food & Dining",   daysAgo: 2 },

  // 3 days ago
  { name: "MRT — stored value top-up", amount: 20.00, cat: "Transportation",  daysAgo: 3 },
  { name: "Spotify",                   amount: 9.99,  cat: "Subscriptions",   daysAgo: 3 },

  // 4 days ago
  { name: "McDonald's breakfast",      amount: 8.40,  cat: "Food & Dining",   daysAgo: 4 },
  { name: "Grab Food delivery",        amount: 24.70, cat: "Food & Dining",   daysAgo: 4 },

  // 5 days ago
  { name: "Cold Storage groceries",    amount: 48.60, cat: "Groceries",       daysAgo: 5 },
  { name: "Cathay cinema ticket",      amount: 14.00, cat: "Social & Leisure",daysAgo: 5 },

  // 6 days ago
  { name: "Hawker — char kway teow",   amount: 5.00,  cat: "Food & Dining",   daysAgo: 6 },
  { name: "Bus ride",                  amount: 1.89,  cat: "Transportation",  daysAgo: 6 },

  // 1 week ago
  { name: "Uniqlo — 2 tees",          amount: 49.90, cat: "Shopping",        daysAgo: 8 },
  { name: "Bubble tea — Tiger Sugar",  amount: 7.50,  cat: "Food & Dining",   daysAgo: 8 },
  { name: "Grab ride home",            amount: 16.20, cat: "Transportation",  daysAgo: 9 },
  { name: "YouTube Premium",           amount: 5.99,  cat: "Subscriptions",   daysAgo: 9 },
  { name: "Hawker — nasi lemak",       amount: 4.50,  cat: "Food & Dining",   daysAgo: 10 },
  { name: "Electricity bill",          amount: 68.40, cat: "Bills",           daysAgo: 10 },
  { name: "Clinic visit + meds",       amount: 42.00, cat: "Healthcare",      daysAgo: 11 },
  { name: "Kopitiam dinner",           amount: 8.20,  cat: "Food & Dining",   daysAgo: 12 },
  { name: "Water bill",                amount: 19.80, cat: "Bills",           daysAgo: 13 },
  { name: "Zalora — sneakers",         amount: 89.90, cat: "Shopping",        daysAgo: 13 },

  // 2 weeks ago
  { name: "Korean BBQ — Ssikkek",      amount: 55.00, cat: "Food & Dining",   daysAgo: 15 },
  { name: "Grab to Orchard",           amount: 18.50, cat: "Transportation",  daysAgo: 16 },
  { name: "Coffee Bean latte",         amount: 8.50,  cat: "Food & Dining",   daysAgo: 17 },
  { name: "Shopee — desk accessories", amount: 34.70, cat: "Shopping",        daysAgo: 17 },
  { name: "Escape room — team outing", amount: 38.00, cat: "Social & Leisure",daysAgo: 18 },
  { name: "Pharmacy — vitamins",       amount: 22.90, cat: "Healthcare",      daysAgo: 19 },
  { name: "NTUC FairPrice",            amount: 81.50, cat: "Groceries",       daysAgo: 20 },
  { name: "Dim sum Sunday brunch",     amount: 32.50, cat: "Food & Dining",   daysAgo: 21 },

  // 3 weeks ago
  { name: "Grab to airport",           amount: 46.00, cat: "Transportation",  daysAgo: 23 },
  { name: "Airport meal — Terminal 3", amount: 18.90, cat: "Food & Dining",   daysAgo: 23 },
  { name: "Nintendo eShop top-up",     amount: 50.00, cat: "Gaming",          daysAgo: 24 },
  { name: "Bubble tea run",            amount: 13.40, cat: "Food & Dining",   daysAgo: 25 },
  { name: "Night out — Clarke Quay",   amount: 68.00, cat: "Social & Leisure",daysAgo: 26 },
  { name: "Carousell sale — AirPods",  amount: 120.00,cat: "Shopping",        daysAgo: 27 },
  { name: "Hawker — wonton mee",       amount: 4.00,  cat: "Food & Dining",   daysAgo: 28 },

  // 4–5 weeks ago
  { name: "Netflix",                   amount: 15.98, cat: "Subscriptions",   daysAgo: 31 },
  { name: "Spotify",                   amount: 9.99,  cat: "Subscriptions",   daysAgo: 31 },
  { name: "NTUC FairPrice",            amount: 94.20, cat: "Groceries",       daysAgo: 33 },
  { name: "Japanese restaurant",       amount: 58.00, cat: "Food & Dining",   daysAgo: 35 },
  { name: "Grab rides (week)",         amount: 52.40, cat: "Transportation",  daysAgo: 36 },
  { name: "Dentist — scaling",         amount: 85.00, cat: "Healthcare",      daysAgo: 38 },
  { name: "Uniqlo — hoodie",           amount: 79.90, cat: "Shopping",        daysAgo: 40 },
  { name: "Electricity bill",          amount: 71.20, cat: "Bills",           daysAgo: 40 },
  { name: "Kopitiam meals (week)",     amount: 36.00, cat: "Food & Dining",   daysAgo: 42 },

  // 6–7 weeks ago
  { name: "Netflix",                   amount: 15.98, cat: "Subscriptions",   daysAgo: 62 },
  { name: "Spotify",                   amount: 9.99,  cat: "Subscriptions",   daysAgo: 62 },
  { name: "NTUC FairPrice",            amount: 76.30, cat: "Groceries",       daysAgo: 64 },
  { name: "Grab Food delivery",        amount: 31.20, cat: "Food & Dining",   daysAgo: 65 },
  { name: "Grab rides",                amount: 44.80, cat: "Transportation",  daysAgo: 66 },
  { name: "Bowling — Westgate",        amount: 18.00, cat: "Social & Leisure",daysAgo: 68 },
  { name: "Pharmacy",                  amount: 14.50, cat: "Healthcare",      daysAgo: 70 },
  { name: "Hawker meals (week)",       amount: 42.50, cat: "Food & Dining",   daysAgo: 72 },
  { name: "Steam game purchase",       amount: 28.00, cat: "Gaming",          daysAgo: 74 },
  { name: "Water bill",                amount: 21.40, cat: "Bills",           daysAgo: 75 },
];

export const DEMO_EXPENSES: Expense[] = RAW.map((r, i) => ({
  id: `demo-${i + 1}`,
  itemName: r.name,
  amount: r.amount,
  category: r.cat,
  date: d(r.daysAgo),
  createdAt: ts(r.daysAgo),
  updatedAt: ts(r.daysAgo),
}));

export const DEMO_CATEGORIES: string[] = [
  "Food & Dining",
  "Transportation",
  "Groceries",
  "Shopping",
  "Social & Leisure",
  "Subscriptions",
  "Healthcare",
  "Grooming",
  "Bills",
  "Gaming",
];

export const DEMO_BUDGETS: CategoryBudgets = {
  "Food & Dining":    350,
  "Transportation":   130,
  "Groceries":        250,
  "Shopping":         200,
  "Social & Leisure": 150,
  "Subscriptions":     60,
  "Healthcare":       100,
  "Grooming":          50,
  "Bills":            150,
  "Gaming":            60,
};

export const DEMO_MAPPINGS: CategoryMappings = {
  "grab":         "Transportation",
  "mrt":          "Transportation",
  "bus":          "Transportation",
  "netflix":      "Subscriptions",
  "spotify":      "Subscriptions",
  "youtube":      "Subscriptions",
  "apple":        "Subscriptions",
  "ntuc":         "Groceries",
  "fairprice":    "Groceries",
  "cold storage": "Groceries",
  "sheng siong":  "Groceries",
  "shopee":       "Shopping",
  "zalora":       "Shopping",
  "uniqlo":       "Shopping",
  "carousell":    "Shopping",
  "clinic":       "Healthcare",
  "pharmacy":     "Healthcare",
  "dentist":      "Healthcare",
  "hospital":     "Healthcare",
  "watsons":      "Grooming",
  "guardian":     "Grooming",
  "steam":        "Gaming",
  "nintendo":     "Gaming",
  "ps store":     "Gaming",
  "electricity":  "Bills",
  "water":        "Bills",
  "internet":     "Bills",
  "singtel":      "Bills",
  "starhub":      "Bills",
  "cinema":       "Social & Leisure",
  "cathay":       "Social & Leisure",
  "gv":           "Social & Leisure",
  "escape room":  "Social & Leisure",
  "bowling":      "Social & Leisure",
};
