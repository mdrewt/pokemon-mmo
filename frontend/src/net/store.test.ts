// Store convention guard: content tables are keyed Maps so a re-subscribe (which re-delivers every
// row as an insert) is idempotent and never duplicates content. This test fails if a content
// collection regresses to a plain array (the typeRelations/fusions bug class).

import { describe, expect, it } from 'vitest';
import type { Fusion, TypeRelationRow } from '../module_bindings/types';
import { AuthoritativeStore } from './store';

describe('store content tables are idempotent on re-subscribe', () => {
  it('re-inserting the same type_relation row keeps one entry', () => {
    const store = new AuthoritativeStore();
    const row: TypeRelationRow = {
      id: 1n,
      attack: { tag: 'Fire' },
      defend: { tag: 'Nature' },
      effect: { tag: 'SuperEffective' },
    };
    store.upsertTypeRelation(row);
    store.upsertTypeRelation(row); // a reconnect re-delivers the same row
    expect(store.typeRelations.size).toBe(1);
  });

  it('re-inserting the same fusion recipe keeps one entry', () => {
    const store = new AuthoritativeStore();
    const recipe: Fusion = { id: 7n, a: 1, b: 2, to: 10 };
    store.upsertFusion(recipe);
    store.upsertFusion(recipe);
    expect(store.fusions.size).toBe(1);
  });
});
