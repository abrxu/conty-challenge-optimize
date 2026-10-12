import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { deliveriesSince } from "../src/clock.ts";
import { getQueryCount, openDatabase, resetQueryCount } from "../src/db.ts";
import { CAMPAIGN_ID, seed } from "../src/seed.ts";

type Match = { id: string; name: string; niche_score: number; latest_reach: number; deliveries_90d: number };
type Page = { campaign_id: string; total: number; creators: Match[] };

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

function pageOffsets(total: number, limit: number): number[] {
  const lastPage = total === 0 ? 0 : total - (total % limit || limit);
  return [...new Set([0, 20, 40, Math.floor(total / 2), lastPage, Math.max(0, total - 1), total, total + 100])];
}

describe("Critério: a listagem continua igual à original em volumes maiores que o do seed", () => {
  const cases = [
    { creators: 0, seed: 7 },
    { creators: 1, seed: 7 },
    { creators: 80, seed: 7 },
    { creators: 600, seed: 7 },
    { creators: 2000, seed: 7 },
    { creators: 5000, seed: 7 },
    { creators: 600, seed: 13 },
    { creators: 2000, seed: 13 },
  ];
  for (const c of cases) {
    it(`volume ${c.creators} criadores, seed ${c.seed}: offsets 0, último, igual ao total e além do total batem com a referência`, async () => {
      const { db, app } = seeded(c.creators, c.seed);
      const full = reference(db, CAMPAIGN_ID, Number.MAX_SAFE_INTEGER, 0);
      const total = full.total;
      if (c.creators === 0) expect(total).toBe(0);
      if (c.creators >= 600) expect(total).toBeGreaterThan(50);
      for (const limit of [1, 20, 50]) {
        for (const offset of pageOffsets(total, limit)) {
          const got = await fetchPage(app, CAMPAIGN_ID, limit, offset);
          expect(got, `limit=${limit} offset=${offset}`).toEqual({
            ...full,
            creators: full.creators.slice(offset, offset + limit),
          });
        }
      }
    }, c.creators >= 5000 ? 180_000 : 120_000);
  }

  it("criador sem conta entra com alcance 0 e a página inteira bate com a referência", async () => {
    const { db, app } = seeded(80, 7);
    db.prepare("INSERT INTO creators (id, name, niches_json, raw_payload) VALUES (?, ?, ?, ?)").run(
      "crt_sem_conta",
      "Sem conta",
      '["beleza","moda"]',
      "",
    );
    const full = reference(db, CAMPAIGN_ID, Number.MAX_SAFE_INTEGER, 0);
    const withoutAccount = full.creators.find((creator) => creator.id === "crt_sem_conta");
    expect(withoutAccount).toMatchObject({ niche_score: 2, latest_reach: 0, deliveries_90d: 0 });
    for (const limit of [20, 50]) {
      for (const offset of pageOffsets(full.total, limit)) {
        expect(await fetchPage(app, CAMPAIGN_ID, limit, offset)).toEqual({
          ...full,
          creators: full.creators.slice(offset, offset + limit),
        });
      }
    }
  });
});

describe("Critério: empates de métrica", () => {
  function tiesDb() {
    const db = openDatabase(":memory:");
    db.exec(`INSERT INTO campaigns VALUES ('cmp_tie', 'Empates', '["beleza","moda"]');`);
    const ins = db.prepare("INSERT INTO creators VALUES (?, ?, ?, '')");
    const acc = db.prepare("INSERT INTO social_accounts VALUES (?, ?, 'instagram')");
    const met = db.prepare("INSERT INTO metrics VALUES (?, ?, ?, ?, '')");
    const ids = Array.from({ length: 30 }, (_, i) => `crt_t${String(i).padStart(2, "0")}`).reverse();
    for (const id of ids) {
      ins.run(id, id, '["beleza","moda"]');
      acc.run(`acc_${id}_0`, id);
      acc.run(`acc_${id}_1`, id);
      met.run(`met_${id}_0a`, `acc_${id}_0`, 400, "2026-05-30T00:00:00.000Z");
      met.run(`met_${id}_1a`, `acc_${id}_1`, 600, "2026-05-30T00:00:00.000Z");
      met.run(`met_${id}_1b`, `acc_${id}_1`, 700, "2026-05-30T00:00:00.000Z");
      met.run(`met_${id}_0old`, `acc_${id}_0`, 99999, "2026-04-01T00:00:00.000Z");
    }
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
    expect(p1.creators.every((c) => c.latest_reach === 1100 && c.niche_score === 2)).toBe(true);
    expect(p1).toEqual(reference(db, "cmp_tie", 20, 0));
    expect(p2).toEqual(reference(db, "cmp_tie", 20, 20));
  });

  it("empate de captured_at em contas diferentes soma a métrica mais recente de cada conta", async () => {
    const db = tiesDb();
    const page = await fetchPage(createApp(db), "cmp_tie", 1, 0);
    expect(page.creators[0]?.latest_reach).toBe(1100);
  });

  it("mesmo captured_at na mesma conta: vence a métrica de id maior", async () => {
    const db = openDatabase(":memory:");
    db.exec(`
      INSERT INTO campaigns VALUES ('cmp_mesma_conta', 'Mesma conta', '["beleza"]');
      INSERT INTO creators VALUES ('crt_m', 'Mesma conta', '["beleza"]', '');
      INSERT INTO social_accounts VALUES ('acc_m', 'crt_m', 'instagram');
      INSERT INTO metrics VALUES
        ('met_m_a', 'acc_m', 600, '2026-05-30T00:00:00.000Z', ''),
        ('met_m_b', 'acc_m', 700, '2026-05-30T00:00:00.000Z', '');
    `);
    const page = await fetchPage(createApp(db), "cmp_mesma_conta", 20, 0);
    expect(page.creators[0]?.latest_reach).toBe(700);
    expect(page).toEqual(reference(db, "cmp_mesma_conta", 20, 0));
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
