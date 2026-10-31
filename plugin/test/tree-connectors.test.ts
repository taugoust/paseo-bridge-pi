import assert from 'node:assert/strict';
import test from 'node:test';
import { treeConnectors } from '../shared/tree-connectors.ts';

test('exact visible edges form a parent trunk ending at last direct child and nested elbows', () => {
 const rows = [{ key: 'root' }, { key: 'a', parentKey: 'root' }, { key: 'nested', parentKey: 'a' }, { key: 'b', parentKey: 'root' }, { key: 'other' }, { key: 'orphan', parentKey: 'missing' }];
 const anchors = new Map([['root', { x: 19, y: 30 }], ['a', { x: 35, y: 100 }], ['nested', { x: 51, y: 350 }], ['b', { x: 35, y: 500 }], ['other', { x: 19, y: 570 }], ['orphan', { x: 19, y: 640 }]]);
 assert.deepEqual(treeConnectors(rows, anchors), [
  { x: 18.5, y: 37, width: 1, height: 463 },
  { x: 19, y: 99.5, width: 9, height: 1 },
  { x: 19, y: 499.5, width: 9, height: 1 },
  { x: 34.5, y: 107, width: 1, height: 243 },
  { x: 35, y: 349.5, width: 9, height: 1 },
 ]);
 // Expanding a report moves subsequent measured anchors, preserving trunk continuity.
 anchors.set('b', { x: 35, y: 900 });
 assert.equal(treeConnectors(rows, anchors)[0].height, 863);
 assert.deepEqual(treeConnectors([], anchors), []); // Jobs / history are not edges.
});

test('missing measurements, orphan attempts, reversed edges and clipped equal-depth anchors never invent lines', () => {
 const rows = [{ key: 'p' }, { key: 'c', parentKey: 'p' }];
 assert.deepEqual(treeConnectors(rows, new Map()), []);
 assert.deepEqual(treeConnectors(rows, new Map([['p', { x: 10, y: 20 }], ['c', { x: 10, y: 80 }]])), []);
 assert.deepEqual(treeConnectors(rows, new Map([['p', { x: 10, y: 80 }], ['c', { x: 30, y: 20 }]])), []);
});

test('deep branches retain distinct anchors rather than sharing a capped trunk', () => {
 const rows = Array.from({ length: 9 }, (_, depth) => ({ key: String(depth), ...(depth ? { parentKey: String(depth - 1) } : {}) }));
 const anchors = new Map(rows.map((row, depth) => [row.key, { x: 19 + depth * 16, y: 30 + depth * 60 }]));
 const lines = treeConnectors(rows, anchors);
 assert.equal(lines.length, 16);
 assert.equal(lines.at(-2)?.x, 130.5);
});
