import { format, subDays, subMonths, startOfMonth } from "date-fns";
import type { Expense, CategoryBudgets, CategoryMappings } from "../types";

function d(daysAgo: number): string {
  return format(subDays(new Date(), daysAgo), "yyyy-MM-dd");
}
function ts(daysAgo: number): string {
  return `${d(daysAgo)}T12:00:00`;
}

// Realistic Singapore daily-life expenses spread across ~10 weeks
const RAW: { name: string; amount: number; cat: string; daysAgo: number }[] = [
  // This week
  { name: "Kopi at kopitiam", amount: 1.5, cat: "Food & Dining", daysAgo: 0 },
  { name: "Grab to camp", amount: 14.2, cat: "Transportation", daysAgo: 0 },
  { name: "Chicken rice", amount: 4.5, cat: "Food & Dining", daysAgo: 1 },
  { name: "Netflix", amount: 15.98, cat: "Subscriptions", daysAgo: 1 },
  { name: "NTUC FairPrice", amount: 67.4, cat: "Shopping", daysAgo: 2 },
  { name: "Bubble tea", amount: 6.9, cat: "Food & Dining", daysAgo: 2 },
  { name: "MRT top-up", amount: 20.0, cat: "Transportation", daysAgo: 3 },
  { name: "Watsons skincare", amount: 28.5, cat: "Grooming", daysAgo: 3 },
  { name: "McDonald's", amount: 11.4, cat: "Food & Dining", daysAgo: 4 },
  { name: "Spotify", amount: 9.99, cat: "Subscriptions", daysAgo: 4 },
  { name: "Hawker dinner", amount: 7.5, cat: "Food & Dining", daysAgo: 5 },
  { name: "Grab Food delivery", amount: 22.3, cat: "Food & Dining", daysAgo: 5 },
  { name: "Cinema ticket", amount: 14.0, cat: "Social & Leisure", daysAgo: 6 },
  // 1–2 weeks ago
  { name: "Uniqlo tee", amount: 29.9, cat: "Shopping", daysAgo: 8 },
  { name: "Electricity bill", amount: 71.2, cat: "Other", daysAgo: 9 },
  { name: "Kopitiam breakfast", amount: 4.8, cat: "Food & Dining", daysAgo: 10 },
  { name: "Grab to Orchard", amount: 18.5, cat: "Transportation", daysAgo: 10 },
  { name: "Nasi lemak", amount: 5.5, cat: "Food & Dining", daysAgo: 11 },
  { name: "YouTube Premium", amount: 5.99, cat: "Subscriptions", daysAgo: 12 },
  { name: "Cold Storage", amount: 54.6, cat: "Shopping", daysAgo: 13 },
  { name: "Escape room", amount: 38.0, cat: "Social & Leisure", daysAgo: 13 },
  { name: "Pharmacy", amount: 18.5, cat: "Healthcare", daysAgo: 14 },
  // 2–3 weeks ago
  { name: "Korean BBQ", amount: 55.0, cat: "Food & Dining", daysAgo: 16 },
  { name: "Grab ride", amount: 12.4, cat: "Transportation", daysAgo: 17 },
  { name: "Coffee Bean", amount: 8.5, cat: "Food & Dining", daysAgo: 18 },
  { name: "Zalora order", amount: 62.0, cat: "Shopping", daysAgo: 19 },
  { name: "Clinic visit", amount: 35.0, cat: "Healthcare", daysAgo: 20 },
  { name: "Hawker supper", amount: 9.0, cat: "Food & Dining", daysAgo: 21 },
  // 3–4 weeks ago
  { name: "Grab to airport", amount: 45.0, cat: "Transportation", daysAgo: 23 },
  { name: "NTUC FairPrice", amount: 88.9, cat: "Shopping", daysAgo: 24 },
  { name: "Water bill", amount: 22.1, cat: "Other", daysAgo: 25 },
  { name: "Bubble tea", amount: 7.2, cat: "Food & Dining", daysAgo: 25 },
  { name: "Dim sum brunch", amount: 32.5, cat: "Food & Dining", daysAgo: 27 },
  { name: "Movie + popcorn", amount: 28.0, cat: "Social & Leisure", daysAgo: 28 },
  // Last month
  { name: "Netflix", amount: 15.98, cat: "Subscriptions", daysAgo: 31 },
  { name: "Spotify", amount: 9.99, cat: "Subscriptions", daysAgo: 34 },
  { name: "NTUC FairPrice", amount: 91.2, cat: "Shopping", daysAgo: 36 },
  { name: "Korean restaurant", amount: 42.0, cat: "Food & Dining", daysAgo: 38 },
  { name: "Grab rides (week)", amount: 48.5, cat: "Transportation", daysAgo: 39 },
  { name: "Dentist", amount: 85.0, cat: "Healthcare", daysAgo: 41 },
  { name: "Night out Clarke Quay", amount: 78.0, cat: "Social & Leisure", daysAgo: 43 },
  { name: "Shopee order", amount: 34.9, cat: "Shopping", daysAgo: 45 },
  { name: "Electricity bill", amount: 68.4, cat: "Other", daysAgo: 47 },
  // 2 months ago
  { name: "Netflix", amount: 15.98, cat: "Subscriptions", daysAgo: 62 },
  { name: "Spotify", amount: 9.99, cat: "Subscriptions", daysAgo: 65 },
  { name: "NTUC FairPrice", amount: 76.3, cat: "Shopping", daysAgo: 67 },
  { name: "Japanese dinner", amount: 62.0, cat: "Food & Dining", daysAgo: 69 },
  { name: "Grab rides", amount: 41.2, cat: "Transportation", daysAgo: 70 },
  { name: "Pharmacy", amount: 14.5, cat: "Healthcare", daysAgo: 72 },
  { name: "Bowling", amount: 18.0, cat: "Social & Leisure", daysAgo: 74 },
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
  "Shopping",
  "Social & Leisure",
  "Subscriptions",
  "Healthcare",
  "Grooming",
  "Other",
];

export const DEMO_BUDGETS: CategoryBudgets = {
  "Food & Dining": 300,
  "Transportation": 120,
  "Shopping": 250,
  "Social & Leisure": 150,
  "Subscriptions": 60,
  "Healthcare": 80,
  "Grooming": 50,
  "Other": 100,
};

export const DEMO_MAPPINGS: CategoryMappings = {
  "grab": "Transportation",
  "mrt": "Transportation",
  "bus": "Transportation",
  "netflix": "Subscriptions",
  "spotify": "Subscriptions",
  "youtube": "Subscriptions",
  "ntuc": "Shopping",
  "fairprice": "Shopping",
  "cold storage": "Shopping",
  "shopee": "Shopping",
  "zalora": "Shopping",
  "clinic": "Healthcare",
  "pharmacy": "Healthcare",
  "dentist": "Healthcare",
  "watsons": "Grooming",
};
