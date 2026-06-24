// M5: two-window integration test. Two browser contexts join the same authoritative world and we
// assert end-to-end behaviour against canonical state via the dev-only `window.__game` hook
// (see src/test/introspect.ts) — never canvas pixels.
//
// Covered (the "thorough" set): both windows connect and see each other + the NPC; movement syncs
// both directions (A->B and B->A); jump advances a tile; an obstacle bump is rejected with no
// desync (predicted == authoritative); prediction converges to authority; the NPC wanders; a
// disconnect despawns the character in the other window.
//
// Determinism: global-setup republishes with --delete-data, so the world starts as {1 NPC, 0
// players}; the two joins make it {1 NPC, 2 players}. Spawn tiles are random, so the test reads
// actual tiles from the snapshot and moves relative to them rather than hard-coding positions.

import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import type { GameSnapshot, GameCharSnapshot } from '../src/test/introspect';

type DirKey = 'KeyW' | 'KeyA' | 'KeyS' | 'KeyD';

// game-core's STEP_MS, read once from the introspection hook in beforeAll (not hard-coded — it is
// the single source of truth for the drain/tick cadence; see ARCHITECTURE.md "rules written once").
let stepMs = 0;

async function snapshot(page: Page): Promise<GameSnapshot> {
  return page.evaluate(() => window.__game!());
}

function own(g: GameSnapshot): GameCharSnapshot {
  const c = g.characters.find((ch) => ch.isOwn);
  if (!c) throw new Error('no own character in snapshot');
  return c;
}

function byId(g: GameSnapshot, id: string): GameCharSnapshot | undefined {
  return g.characters.find((ch) => ch.entityId === id);
}

/** Join the game: navigate, enter a name, and wait until connected with an own character. */
async function join(page: Page, name: string): Promise<void> {
  await page.goto('/');
  await page.fill('#name-entry input', name);
  await page.click('#name-entry button');
  await page.waitForFunction(
    () => {
      const g = window.__game?.();
      return !!g && g.status === 'connected' && g.ownEntityId !== null && g.predicted !== null;
    },
    { timeout: 20_000 },
  );
  // Ensure key events land on the document, not the (now-removed) name input.
  await page.locator('#app').click();
}

/** Tap a key once (held < stepMs so it's a single step, not a sustained hold). */
async function tap(page: Page, code: string): Promise<void> {
  await page.keyboard.down(code);
  await page.waitForTimeout(60);
  await page.keyboard.up(code);
}

/** Read the own AUTHORITATIVE tile (server truth mirrored into the store). */
async function ownTile(page: Page): Promise<{ x: number; y: number }> {
  const o = own(await snapshot(page));
  return { x: o.tileX, y: o.tileY };
}

/** Close any wild encounter that a grass step triggered (M8: walking in grass can start a battle at
 *  random). Escape closes the battle screen → overworld; movement tests call this so a random
 *  encounter can't swallow a later input. No-op when not battling. */
async function fleeIfBattling(page: Page): Promise<void> {
  if ((await snapshot(page)).battle !== null) {
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await snapshot(page)).battle).toBeNull();
  }
}

/** Catch exactly one wild monster: fight encounters attempting recruit (with bait when available)
 *  each turn until the owned-monster count grows, then return. Bounded. Used by the fusion test to
 *  obtain base-form monsters. */
async function recruitOne(page: Page): Promise<void> {
  const count = async () => (await snapshot(page)).monsters.length;
  const start = await count();
  let battles = 0;
  while ((await count()) === start && battles++ < 12) {
    await page.locator('#app').click();
    await page.keyboard.press('KeyH'); // heal so the party can fight
    await expect
      .poll(async () =>
        (await snapshot(page)).monsters.filter((m) => m.partySlot !== null).every((m) => m.currentHp > 0),
      )
      .toBe(true);
    await page.keyboard.press('KeyF');
    await expect.poll(async () => (await snapshot(page)).battle !== null).toBe(true);
    let guard = 0;
    while (guard++ < 12) {
      const g = await snapshot(page);
      if (!g.battle || g.battle.outcome !== 'Ongoing') break;
      const before = g.battle.turn;
      const baitBtn = page.locator('#battle-screen [data-recruit="bait"]');
      const btn = (await baitBtn.count()) > 0 ? baitBtn : page.locator('#battle-screen [data-recruit="plain"]');
      await btn.first().click();
      await expect
        .poll(async () => {
          const b = (await snapshot(page)).battle;
          return b === null || b.outcome !== 'Ongoing' || b.turn > before;
        })
        .toBe(true);
    }
    const cont = page.locator('#battle-screen').getByText('Continue');
    if ((await cont.count()) > 0) await cont.click();
    await expect.poll(async () => (await snapshot(page)).battle).toBeNull();
  }
}

/** Wait until prediction has reconciled to authority (no move in flight). Doubles as the
 *  no-desync invariant: if predicted never equals authoritative, this poll times out. */
async function settle(page: Page): Promise<void> {
  await fleeIfBattling(page); // a grass step may have opened a battle that gates movement input
  await expect
    .poll(async () => {
      const g = await snapshot(page);
      const o = own(g);
      return g.predicted !== null && g.predicted.x === o.tileX && g.predicted.y === o.tileY;
    })
    .toBe(true);
}

/** Tap a direction, let the step complete and reconcile, return the new authoritative tile.
 *  Because it settles, a returned tile equal to the prior one means a genuine wall, not a slow
 *  frame. */
async function stepDir(page: Page, key: DirKey): Promise<{ x: number; y: number }> {
  await tap(page, key);
  await page.waitForTimeout(stepMs + 120);
  await settle(page);
  return ownTile(page);
}

/** Step each direction until the own tile actually changes (throws if boxed in). */
async function stepAnyOpenDir(page: Page): Promise<void> {
  const dirs: DirKey[] = ['KeyD', 'KeyS', 'KeyA', 'KeyW'];
  for (const key of dirs) {
    const before = await ownTile(page);
    const after = await stepDir(page, key);
    if (after.x !== before.x || after.y !== before.y) return;
  }
  throw new Error('character could not move in any direction (boxed in?)');
}

test.describe.serial('two-window integration', () => {
  let ctxA: BrowserContext;
  let ctxB: BrowserContext;
  let pageA: Page;
  let pageB: Page;
  let idA: string;
  let idB: string;

  test.beforeAll(async ({ browser }) => {
    ctxA = await browser.newContext();
    ctxB = await browser.newContext();
    pageA = await ctxA.newPage();
    pageB = await ctxB.newPage();
    await join(pageA, 'Ash');
    await join(pageB, 'Misty');
    const gA = await snapshot(pageA);
    stepMs = gA.stepMs;
    idA = gA.ownEntityId!;
    idB = (await snapshot(pageB)).ownEntityId!;
  });

  test.afterAll(async () => {
    await ctxA?.close();
    await ctxB?.close();
  });

  test('both windows connect and see each other plus the NPC', async () => {
    expect(idA).not.toBe(idB);

    for (const page of [pageA, pageB]) {
      // Each window should converge to exactly two players + one NPC.
      await expect
        .poll(async () => {
          const g = await snapshot(page);
          const players = g.characters.filter((c) => !c.isNpc).length;
          const npcs = g.characters.filter((c) => c.isNpc).length;
          return `${players}p/${npcs}n`;
        })
        .toBe('2p/1n');
    }

    // A sees B's character and vice versa.
    expect(byId(await snapshot(pageA), idB)).toBeTruthy();
    expect(byId(await snapshot(pageB), idA)).toBeTruthy();
  });

  test('movement in A syncs to B', async () => {
    await stepAnyOpenDir(pageA);
    const aTile = await ownTile(pageA);
    // B sees A's character arrive at A's authoritative tile.
    await expect
      .poll(async () => {
        const b = byId(await snapshot(pageB), idA);
        return b ? `${b.tileX},${b.tileY}` : null;
      })
      .toBe(`${aTile.x},${aTile.y}`);
  });

  test('movement in B syncs to A (bidirectional)', async () => {
    await stepAnyOpenDir(pageB);
    const bTile = await ownTile(pageB);
    await expect
      .poll(async () => {
        const a = byId(await snapshot(pageA), idB);
        return a ? `${a.tileX},${a.tileY}` : null;
      })
      .toBe(`${bTile.x},${bTile.y}`);
  });

  test('obstacle bump is rejected with no desync', async () => {
    // Walk West until genuinely blocked. stepDir settles each step, so a tile that doesn't change
    // means a real wall to the west (border or obstacle), not a missed frame.
    let prev = await ownTile(pageA);
    for (let i = 0; i < 30; i++) {
      const cur = await stepDir(pageA, 'KeyA');
      if (cur.x === prev.x && cur.y === prev.y) break;
      prev = cur;
    }
    // One more bump into the wall. Confirm an input was actually SUBMITTED (nextSeq advances) so a
    // silently-dropped key can't masquerade as a rejection — then assert the tile didn't change (the
    // server rejected the move) and predicted still equals authority (no desync).
    const beforeSeq = Number((await snapshot(pageA)).predictor?.nextSeq);
    const before = await ownTile(pageA);
    const after = await stepDir(pageA, 'KeyA');
    const g = await snapshot(pageA);
    expect(Number(g.predictor?.nextSeq)).toBeGreaterThan(beforeSeq);
    expect(after).toEqual(before);
    expect(g.predicted).toMatchObject({ x: own(g).tileX, y: own(g).tileY });
  });

  test('jump advances a tile with no desync', async () => {
    // Coming off the West wall, East is open (we just came from there). Step East (faces East),
    // then jump East one more tile.
    await stepDir(pageA, 'KeyD');
    const before = await ownTile(pageA);
    await tap(pageA, 'Space');
    // Poll for the specific landing tile (one East) so we wait exactly until the jump resolves.
    await expect.poll(async () => (await ownTile(pageA)).x).toBe(before.x + 1);
    await settle(pageA);
    const g = await snapshot(pageA);
    expect({ x: own(g).tileX, y: own(g).tileY }).toEqual({ x: before.x + 1, y: before.y });
    expect(g.predicted).toMatchObject({ x: own(g).tileX, y: own(g).tileY });
    // The jump syncs to B as well.
    await expect
      .poll(async () => {
        const b = byId(await snapshot(pageB), idA);
        return b ? `${b.tileX},${b.tileY}` : null;
      })
      .toBe(`${before.x + 1},${before.y}`);
  });

  test('predicted state converges to authority in both windows', async () => {
    for (const page of [pageA, pageB]) {
      await expect
        .poll(async () => {
          const g = await snapshot(page);
          const o = own(g);
          return g.predicted ? g.predicted.x === o.tileX && g.predicted.y === o.tileY : false;
        })
        .toBe(true);
    }
  });

  test('each player is granted one starter monster in party slot 0 (M6)', async () => {
    for (const page of [pageA, pageB]) {
      await expect.poll(async () => (await snapshot(page)).monsters.length).toBe(1);
      const starter = (await snapshot(page)).monsters[0]!;
      expect(starter.partySlot).toBe(0);
      expect(starter.level).toBe(1);
      expect(starter.speciesId).toBeGreaterThan(0);
      // RLS: each client receives ONLY its own monster (would be 2 here without the visibility
      // filter — the other player's hidden genes must never reach the wire).
      expect((await snapshot(page)).visibleMonsterCount).toBe(1);
    }
  });

  test('pressing B opens the box showing the starter party (M6)', async () => {
    await pageA.locator('#app').click(); // ensure the page (not a stale element) has focus
    await pageA.keyboard.press('KeyB');
    await expect(pageA.locator('#box-screen')).toBeVisible();
    await expect(pageA.locator('#box-screen')).toContainText('Party (1/3)');
    await pageA.keyboard.press('Escape');
    await expect(pageA.locator('#box-screen')).toBeHidden();
  });

  test('a battle can be fought to a conclusion and XP is awarded (M7)', async () => {
    // Record the starter's level so we can confirm a win awards XP (level may rise).
    const startLevel = (await snapshot(pageA)).monsters[0]!.level;

    await pageA.locator('#app').click();
    await pageA.keyboard.press('KeyF'); // start a battle
    await expect(pageA.locator('#battle-screen')).toBeVisible();
    await expect.poll(async () => (await snapshot(pageA)).battle !== null).toBe(true);

    // Fight: submit the first available skill each turn until the battle resolves.
    let guard = 0;
    while (guard++ < 20) {
      const g = await snapshot(pageA);
      if (!g.battle || g.battle.outcome !== 'Ongoing') break;
      const skill = pageA.locator('#battle-screen [data-skill]').first();
      const before = g.battle.turn;
      await skill.click();
      await expect
        .poll(async () => {
          const b = (await snapshot(pageA)).battle;
          return b === null || b.turn > before || b.outcome !== 'Ongoing';
        })
        .toBe(true);
      // The turn log shows attack events with damage.
      await expect(pageA.locator('#battle-screen')).toContainText('used');
    }

    const ended = (await snapshot(pageA)).battle!;
    expect(['PlayerWon', 'PlayerLost']).toContain(ended.outcome);
    // A win records the XP gained (shown on the victory screen); a loss awards none.
    if (ended.outcome === 'PlayerWon') {
      expect(ended.lastXpGain).toBeGreaterThan(0);
      await expect(pageA.locator('#battle-screen')).toContainText('EXP');
    }

    // Dismiss the result → back to overworld (battle row gone).
    await pageA.locator('#battle-screen').getByText('Continue').click();
    await expect.poll(async () => (await snapshot(pageA)).battle).toBeNull();
    await expect(pageA.locator('#battle-screen')).toBeHidden();

    // A win awards XP; level is monotonic (never drops). (level-1 vs level-1 may also be a loss.)
    const after = (await snapshot(pageA)).monsters[0]!;
    expect(after.level).toBeGreaterThanOrEqual(startLevel);
    // HP persisted out of battle (it is a valid, non-restored value until we heal).
    expect(after.currentHp).toBeLessThanOrEqual(after.maxHp);

    // Heal (H) restores the party to full HP.
    await pageA.locator('#app').click();
    await pageA.keyboard.press('KeyH');
    await expect
      .poll(async () => {
        const m = (await snapshot(pageA)).monsters[0]!;
        return m.currentHp === m.maxHp;
      })
      .toBe(true);

    // The box detail shows an EXP progress bar.
    await pageA.keyboard.press('KeyB');
    await expect(pageA.locator('#box-screen')).toContainText('EXP');
    await pageA.keyboard.press('Escape');
  });

  test('a wild monster can be recruited, consuming bait (M8)', async () => {
    test.setTimeout(150_000);
    // The previous test leaves the box open; close any overlay so we start from the overworld.
    await expect
      .poll(async () => {
        if (await pageA.locator('#box-screen').isVisible()) {
          await pageA.keyboard.press('Escape');
          return false;
        }
        return true;
      })
      .toBe(true);

    // Each player is granted starter bait on first join.
    expect((await snapshot(pageA)).baitCount).toBe(5);
    const startCount = (await snapshot(pageA)).monsters.length;

    // Recruit-by-weaken is probabilistic; attempt across several encounters until one joins. Each
    // failed attempt forfeits the turn (the wild strikes back), so a battle ends in Recruited or
    // PlayerLost — never a kill (recruiting deals no damage).
    let recruited = false;
    for (let battle = 0; battle < 12 && !recruited; battle++) {
      // Heal so the party can fight, then start an encounter.
      await pageA.locator('#app').click();
      await pageA.keyboard.press('KeyH');
      await expect
        .poll(async () => {
          const m = (await snapshot(pageA)).monsters[0]!;
          return m.currentHp === m.maxHp;
        })
        .toBe(true);
      await pageA.keyboard.press('KeyF');
      await expect.poll(async () => (await snapshot(pageA)).battle !== null).toBe(true);

      let guard = 0;
      while (guard++ < 12) {
        const g = await snapshot(pageA);
        if (!g.battle || g.battle.outcome !== 'Ongoing') break;
        const before = g.battle.turn;
        // Prefer bait while we have it (a flat recruit bonus); fall back to a plain attempt.
        const baitBtn = pageA.locator('#battle-screen [data-recruit="bait"]');
        const btn = (await baitBtn.count()) > 0 ? baitBtn : pageA.locator('#battle-screen [data-recruit="plain"]');
        await btn.first().click();
        await expect
          .poll(async () => {
            const b = (await snapshot(pageA)).battle;
            return b === null || b.outcome !== 'Ongoing' || b.turn > before;
          })
          .toBe(true);
      }

      const ended = (await snapshot(pageA)).battle;
      if (ended?.outcome === 'Recruited') {
        recruited = true;
        await expect(pageA.locator('#battle-screen')).toContainText('Gotcha!');
      }
      // Dismiss the result screen (Recruited / PlayerLost) back to the overworld.
      const cont = pageA.locator('#battle-screen').getByText('Continue');
      if ((await cont.count()) > 0) await cont.click();
      await expect.poll(async () => (await snapshot(pageA)).battle).toBeNull();
    }

    expect(recruited).toBe(true);
    // The recruited wild is now an owned monster (in the box), and bait was consumed along the way.
    const afterCatch = await snapshot(pageA);
    expect(afterCatch.monsters.length).toBe(startCount + 1);
    expect(afterCatch.baitCount).toBeLessThan(5);
    // The catch joins the box (not the party) at FULL HP — locks the recruit→monster_row contract.
    const boxMon = afterCatch.monsters.find((m) => m.partySlot === null);
    expect(boxMon).toBeTruthy();
    expect(boxMon!.currentHp).toBe(boxMon!.maxHp);
    expect(boxMon!.currentHp).toBeGreaterThan(0);
  });

  test('the active monster can be switched mid-battle (M8.1)', async () => {
    // Pre-req: the recruit test left a caught monster in pageA's box. Field it in party slot 2 so the
    // battle team has two members to switch between.
    const boxMon = (await snapshot(pageA)).monsters.find((m) => m.partySlot === null);
    expect(boxMon, 'recruit test should have left a box monster').toBeTruthy();
    await pageA.keyboard.press('KeyB');
    await expect(pageA.locator('#box-screen')).toBeVisible();
    await pageA.locator(`#box-screen [data-monster-id="${boxMon!.monsterId}"]`).click();
    await pageA.locator('#box-screen [data-party="1"]').click(); // party slot index 1
    await expect
      .poll(async () => (await snapshot(pageA)).monsters.filter((m) => m.partySlot !== null).length)
      .toBe(2);
    await pageA.keyboard.press('Escape');
    await expect(pageA.locator('#box-screen')).toBeHidden();

    // Heal so both party members are conscious, then start an encounter.
    await pageA.locator('#app').click();
    await pageA.keyboard.press('KeyH');
    await pageA.keyboard.press('KeyF');
    await expect.poll(async () => (await snapshot(pageA)).battle?.playerTeam.length ?? 0).toBe(2);

    const before = (await snapshot(pageA)).battle!;
    expect(before.playerActive).toBe(0);
    // Switch to the benched member (team index 1). The wild gets a free hit on the monster sent in.
    await pageA.locator('#battle-screen [data-swap="1"]').click();
    await expect
      .poll(async () => {
        const b = (await snapshot(pageA)).battle;
        return b === null || b.playerActive === 1;
      })
      .toBe(true);
    const after = (await snapshot(pageA)).battle;
    if (after) {
      expect(after.playerActive).toBe(1);
      expect(after.turn).toBeGreaterThan(before.turn); // the swap consumed the turn
      await expect(pageA.locator('#battle-screen')).toContainText('Go,');
    }
    await fleeIfBattling(pageA);
  });

  test('a monster can be trained with food and cared for (M9)', async () => {
    const starterId = (await snapshot(pageA)).monsters.find((m) => m.partySlot === 0)!.monsterId;
    const find = async () =>
      (await snapshot(pageA)).monsters.find((m) => m.monsterId === starterId)!;

    await pageA.locator('#app').click();
    await pageA.keyboard.press('KeyB');
    await expect(pageA.locator('#box-screen')).toBeVisible();
    await expect(pageA.locator('#box-screen')).toContainText('Training');
    // Select the starter (party slot 0) so the Raise controls act on it.
    await pageA.locator(`#box-screen [data-monster-id="${starterId}"]`).click();

    // Feed a Power Snack (item 2) → training investment rises (the visible raising divergence).
    const beforeTrain = (await find()).trainingTotal;
    await pageA.locator('#box-screen [data-feed="2"]').click();
    await expect.poll(async () => (await find()).trainingTotal).toBeGreaterThan(beforeTrain);

    // Care for it → bond rises (cooldown allows the first call immediately).
    const beforeBond = (await find()).bond;
    await pageA.locator('#box-screen [data-care="1"]').click();
    await expect.poll(async () => (await find()).bond).toBeGreaterThan(beforeBond);

    await pageA.keyboard.press('Escape');
    await expect(pageA.locator('#box-screen')).toBeHidden();
  });

  test('a monster evolves once it meets the gate, keeping its identity (M10)', async () => {
    // The server marks a monster eligible (evolves_to) once its level + bond meet the gate. The
    // recruited catch (a base form, level 2-4) already qualifies at the POC-low gate — only base forms
    // have evolutions, so a non-empty evolves_to identifies one without grinding.
    const eligible = async () =>
      (await snapshot(pageA)).monsters.find((m) => m.evolvesTo.length > 0);
    await expect.poll(async () => (await eligible()) !== undefined).toBe(true);
    const before = (await eligible())!;
    const id = before.monsterId;
    const target = before.evolvesTo[0]!;
    expect(before.speciesId).not.toBe(target);
    const find = async () => (await snapshot(pageA)).monsters.find((m) => m.monsterId === id)!;

    // Evolve it from the box.
    await pageA.locator('#app').click();
    await pageA.keyboard.press('KeyB');
    await expect(pageA.locator('#box-screen')).toBeVisible();
    await pageA.locator(`#box-screen [data-monster-id="${id}"]`).click();
    await expect(pageA.locator('#box-screen')).toContainText('READY TO EVOLVE');
    await pageA.locator(`#box-screen [data-evolve="${target}"]`).click();
    await expect.poll(async () => (await find()).speciesId).toBe(target);

    // Same individual, evolved: same id + party slot, kept its bond + training.
    const after = await find();
    expect(after.partySlot).toBe(before.partySlot);
    expect(after.bond).toBe(before.bond);
    expect(after.trainingTotal).toBe(before.trainingTotal);
    await pageA.keyboard.press('Escape');
    await expect(pageA.locator('#box-screen')).toBeHidden();
  });

  test('two monsters fuse into a stronger offspring, consuming both (M10)', async () => {
    test.setTimeout(240_000);
    // Base-form monsters we own (species ids 1-4 are the base/wild forms in the content).
    const baseMonsters = async () =>
      (await snapshot(pageA)).monsters.filter((m) => m.speciesId >= 1 && m.speciesId <= 4);

    // Fusion recipes cover every base cross-pair, so we just need two base monsters of DIFFERENT
    // species. We already own the recruited catch; recruit more until a different-species pair exists.
    let tries = 0;
    while (tries++ < 8) {
      const mons = await baseMonsters();
      if (mons.length >= 2 && new Set(mons.map((m) => m.speciesId)).size >= 2) break;
      await recruitOne(pageA);
    }
    const mons = await baseMonsters();
    const a = mons[0]!;
    const b = mons.find((m) => m.speciesId !== a.speciesId);
    expect(b, 'should own two base monsters of different species to fuse').toBeTruthy();

    const beforeCount = (await snapshot(pageA)).monsters.length;
    await pageA.locator('#app').click();
    await pageA.keyboard.press('KeyB');
    await expect(pageA.locator('#box-screen')).toBeVisible();
    await pageA.locator(`#box-screen [data-monster-id="${a.monsterId}"]`).click();
    await expect(pageA.locator('#box-screen')).toContainText('FUSE');
    await pageA.locator(`#box-screen [data-fuse="${b!.monsterId}"]`).click();

    // Both parents consumed → net -1 monster, and a fusion-only species (ids 10-15) was created.
    await expect.poll(async () => (await snapshot(pageA)).monsters.length).toBe(beforeCount - 1);
    const after = await snapshot(pageA);
    expect(after.monsters.some((m) => m.speciesId >= 10 && m.speciesId <= 15)).toBe(true);
    expect(after.monsters.some((m) => m.monsterId === a.monsterId)).toBe(false);
    expect(after.monsters.some((m) => m.monsterId === b!.monsterId)).toBe(false);
    await pageA.keyboard.press('Escape');
    await expect(pageA.locator('#box-screen')).toBeHidden();
  });

  test('the NPC wanders', async () => {
    const npcId = (await snapshot(pageA)).characters.find((c) => c.isNpc)!.entityId;
    const start = byId(await snapshot(pageA), npcId)!;
    const startPos = `${start.tileX},${start.tileY}`;
    // The NPC steps every ~700ms; give it several chances to move to a different tile.
    await expect
      .poll(
        async () => {
          const n = byId(await snapshot(pageA), npcId);
          return n ? `${n.tileX},${n.tileY}` : null;
        },
        { timeout: 12_000, intervals: [500] },
      )
      .not.toBe(startPos);
  });

  test('disconnecting B despawns its character in A', async () => {
    await ctxB.close();
    await expect
      .poll(async () => byId(await snapshot(pageA), idB) ?? null)
      .toBeNull();
    // A's world is back to one other-less view: just A + the NPC.
    const g = await snapshot(pageA);
    expect(g.characters.filter((c) => !c.isNpc).length).toBe(1);
  });
});
