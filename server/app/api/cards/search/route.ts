import { NextRequest, NextResponse } from 'next/server';
import { readFileSync } from 'fs';
import { join } from 'path';

export const runtime = 'nodejs';

type CardRow = { id: number; n: string; s?: string; r?: string; t?: string; m?: number; l?: number; num?: string; q?: string };

let cache: CardRow[] | null = null;
function loadCards() {
  if (cache) return cache;
  const path = join(process.cwd(), '..', 'cards', 'search_index.min.json');
  const data = JSON.parse(readFileSync(path, 'utf8')) as { cards: CardRow[] };
  cache = data.cards || [];
  return cache;
}
function norm(v: string) { return (v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
function score(card: CardRow, query: string) {
  const q = norm(query);
  if (!q) return 0;
  if (String(card.id) === q) return 5000;
  const hay = card.q || norm(`${card.id} ${card.n} ${card.s || ''} ${card.r || ''} ${card.t || ''} ${card.num || ''}`);
  let s = 0;
  if (norm(card.n).includes(q)) s += 1000;
  if (hay.includes(q)) s += 600;
  for (const part of q.split(' ')) if (part && hay.includes(part)) s += 100;
  return s;
}

export async function GET(req: NextRequest) {
  const q = new URL(req.url).searchParams.get('q') || '';
  const cards = loadCards()
    .map((card) => ({ card, score: score(card, q) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 20)
    .map((x) => x.card);
  return NextResponse.json({ cards });
}
