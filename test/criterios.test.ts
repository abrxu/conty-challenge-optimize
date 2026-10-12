import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { deliveriesSince } from "../src/clock.ts";
import { getQueryCount, openDatabase, resetQueryCount } from "../src/db.ts";
import { CAMPAIGN_ID, seed } from "../src/seed.ts";

type Match = { id: string; name: string; niche_score: number; latest_reach: number; deliveries_90d: number };
type Page = { campaign_id: string; total: number; creators: Match[] };

// Referência ingênua: mesma semântica da implementação original, lendo direto do DatabaseSync.
function reference(db: DatabaseSync, campaignId: string, limit: number, offset: number): Page {
  const campaign = db.prepare("SELECT niches_json FROM campaigns WHERE id = ?").get(campaignId) as
    | { niches_json: string }
    | undefined;
  if (!campaign) throw new Error("campanha inexistente");
  const campaignNiches = JSON.parse(campaign.niches_json) as string[];
  const since = deliveriesSince();
  const creators = db.prepare("SELECT id, name, niches_json FROM creators").all() as Array<{
    id: string;
    name: string;
    niches_json: string;
  }>;
  const accountsStmt = db.prepare("SELECT id FROM social_accounts WHERE creator_id = ?");
  const metricStmt = db.prepare(
    "SELECT views FROM metrics WHERE account_id = ? ORDER BY captured_at DESC, id DESC LIMIT 1",
  );
  const deliveriesStmt = db.prepare(
    "SELECT COUNT(*) AS n FROM deliveries WHERE creator_id = ? AND delivered_at >= ?",
  );
  const scored: Match[] = [];
  for (const c of creators) {
    const niches = JSON.parse(c.niches_json) as string[];
    let score = 0;
    for (const a of campaignNiches) for (const b of niches) if (a === b) score += 1;
    if (score === 0) continue;
    let reach = 0;
    for (const acc of accountsStmt.all(c.id) as Array<{ id: string }>) {
      const m = metricStmt.get(acc.id) as { views: number } | undefined;
      if (m) reach += Number(m.views);
    }
    const d = deliveriesStmt.get(c.id, since) as { n: number };
    scored.push({ id: c.id, name: c.name, niche_score: score, latest_reach: reach, deliveries_90d: Number(d.n) });
  }
  scored.sort((l, r) => {
    if (r.niche_score !== l.niche_score) return r.niche_score - l.niche_score;
    if (r.latest_reach !== l.latest_reach) return r.latest_reach - l.latest_reach;
    return l.id < r.id ? -1 : l.id > r.id ? 1 : 0;
  });
  return { campaign_id: campaignId, total: scored.length, creators: scored.slice(offset, offset + limit) };
}

function seeded(creators: number, seedValue: number) {
  const db = openDatabase(":memory:");
  seed(db, { creators, seed: seedValue });
  return { db, app: createApp(db) };
}

async function fetchPage(app: ReturnType<typeof createApp>, campaignId: string, limit: number, offset: number) {
  const res = await app.request(`/campaigns/${campaignId}/creators?limit=${limit}&offset=${offset}`);
  expect(res.status).toBe(200);
  return (await res.json()) as Page;
}

describe("Critério: a listagem continua igual à original em volumes maiores que o do seed", () => {
  const cases = [
    { creators: 600, seed: 7 },
    { creators: 2000, seed: 7 },
    { creators: 600, seed: 13 },
    { creators: 2000, seed: 13 },
  ];
  for (const c of cases) {
    it(`volume maior: ${c.creators} criadores, seed ${c.seed}, várias páginas e limits batem com a referência`, async () => {
      const { db, app } = seeded(c.creators, c.seed);
      const full = reference(db, CAMPAIGN_ID, Number.MAX_SAFE_INTEGER, 0);
      const total = full.total;
      expect(total).toBeGreaterThan(50);
      for (const limit of [1, 20, 50]) {
        const lastPartial = total - (total % limit || limit);
        const offsets = [0, 20, 40, Math.floor(total / 2), lastPartial, total - 1, total, total + 100];
        for (const offset of offsets) {
          const got = await fetchPage(app, CAMPAIGN_ID, limit, offset);
          expect(got, `limit=${limit} offset=${offset}`).toEqual({
            ...full,
            creators: full.creators.slice(offset, offset + limit),
          });
        }
      }
    }, 120_000);
  }
});

describe("Critério: empates de métrica", () => {
  function tiesDb() {
    const db = openDatabase(":memory:");
    db.exec(`INSERT INTO campaigns VALUES ('cmp_tie', 'Empates', '["beleza","moda"]');`);
    const ins = db.prepare("INSERT INTO creators VALUES (?, ?, ?, '')");
    const acc = db.prepare("INSERT INTO social_accounts VALUES (?, ?, 'instagram')");
    const met = db.prepare("INSERT INTO metrics VALUES (?, ?, ?, ?, '')");
    // 30 criadores com score 2 e alcance 1000 (inseridos fora de ordem), atravessando a página de 20.
    const ids = Array.from({ length: 30 }, (_, i) => `crt_t${String(i).padStart(2, "0")}`).reverse();
    for (const id of ids) {
      ins.run(id, id, '["beleza","moda"]');
      // Duas contas por criador, métricas com o MESMO captured_at entre contas diferentes.
      acc.run(`acc_${id}_0`, id);
      acc.run(`acc_${id}_1`, id);
      met.run(`met_${id}_0a`, `acc_${id}_0`, 400, "2026-05-30T00:00:00.000Z");
      met.run(`met_${id}_1a`, `acc_${id}_1`, 600, "2026-05-30T00:00:00.000Z");
      // Mesmo captured_at na mesma conta: vence o id maior (b > a).
      met.run(`met_${id}_1b`, `acc_${id}_1`, 600, "2026-05-30T00:00:00.000Z");
      met.run(`met_${id}_0old`, `acc_${id}_0`, 99999, "2026-04-01T00:00:00.000Z");
    }
    // Criadores com score 1 empatados entre si em alcance 0.
    for (const id of ["crt_z2", "crt_z1", "crt_z3"]) ins.run(id, id, '["moda"]');
    return db;
  }

  it("empate de niche_score e latest_reach desempata por id asc atravessando a fronteira de página", async () => {
    const db = tiesDb();
    const app = createApp(db);
    const p1 = await fetchPage(app, "cmp_tie", 20, 0);
    const p2 = await fetchPage(app, "cmp_tie", 20, 20);
    const all = [...p1.creators, ...p2.creators].map((c) => c.id);
    const expectedTies = Array.from({ length: 30 }, (_, i) => `crt_t${String(i).padStart(2, "0")}`);
    expect(all).toEqual([...expectedTies, "crt_z1", "crt_z2", "crt_z3"]);
    expect(p1.total).toBe(33);
    expect(p1.creators.every((c) => c.latest_reach === 1000 && c.niche_score === 2)).toBe(true);
    expect(p1).toEqual(reference(db, "cmp_tie", 20, 0));
    expect(p2).toEqual(reference(db, "cmp_tie", 20, 20));
  });

  it("empate de captured_at em contas diferentes soma a métrica mais recente de cada conta", async () => {
    const db = tiesDb();
    const page = await fetchPage(createApp(db), "cmp_tie", 1, 0);
    expect(page.creators[0]?.latest_reach).toBe(1000);
  });

  it("empates batem com a referência para todos os offsets e limit=1", async () => {
    const db = tiesDb();
    const app = createApp(db);
    for (let offset = 0; offset <= 34; offset += 1) {
      expect(await fetchPage(app, "cmp_tie", 1, offset)).toEqual(reference(db, "cmp_tie", 1, offset));
    }
  });
});

describe("Critério: páginas além do fim", () => {
  it("em volume grande, offset além do fim devolve creators [] e total correto", async () => {
    const { db, app } = seeded(2000, 7);
    const total = reference(db, CAMPAIGN_ID, 1, 0).total;
    const page = await fetchPage(app, CAMPAIGN_ID, 20, total + 500);
    expect(page.creators).toEqual([]);
    expect(page.total).toBe(total);
  });

  it("offset exatamente igual a total devolve creators [] e total correto", async () => {
    const { db, app } = seeded(2000, 7);
    const total = reference(db, CAMPAIGN_ID, 1, 0).total;
    const page = await fetchPage(app, CAMPAIGN_ID, 20, total);
    expect(page).toEqual({ campaign_id: CAMPAIGN_ID, total, creators: [] });
  });
});

describe("Critério: no máximo 8 queries por página de 20, independente do volume", () => {
  it("orçamento <= 8 queries para limit=20 offset=0 com 2000 criadores", async () => {
    const { app } = seeded(2000, 7);
    resetQueryCount();
    await fetchPage(app, CAMPAIGN_ID, 20, 0);
    expect(getQueryCount()).toBeLessThanOrEqual(8);
  });

  it("orçamento <= 8 queries com offset alto e limit=50 em 2000 criadores", async () => {
    const { db, app } = seeded(2000, 7);
    const total = reference(db, CAMPAIGN_ID, 1, 0).total;
    resetQueryCount();
    await fetchPage(app, CAMPAIGN_ID, 50, total - 30);
    expect(getQueryCount()).toBeLessThanOrEqual(8);
  });

  it("orçamento <= 8 queries para página além do fim em 2000 criadores", async () => {
    const { db, app } = seeded(2000, 7);
    const total = reference(db, CAMPAIGN_ID, 1, 0).total;
    resetQueryCount();
    await fetchPage(app, CAMPAIGN_ID, 20, total + 10);
    expect(getQueryCount()).toBeLessThanOrEqual(8);
  });
});
