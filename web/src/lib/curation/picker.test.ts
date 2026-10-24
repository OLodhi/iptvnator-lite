import { expect, test } from 'vitest';
import type { CurationCategory, CurationView } from '@tv/shared';
import { createPickerState } from './picker.ts';

const cat = (remoteId: string, displayName: string, visible: boolean): CurationCategory => ({
  id: Number(remoteId), remoteId, name: displayName, displayName, itemCount: 10, visible, isNew: false,
});

const view = (): CurationView => ({
  kind: 'live',
  style: 'mixed',
  newCount: 0,
  groups: [
    { tag: 'UK', friendlyName: 'United Kingdom', hint: [], rule: null, categories: [cat('1', 'Sports', true), cat('2', 'PPV', true), cat('3', 'News', true)] },
    { tag: 'US', friendlyName: null, hint: ['ESPN'], rule: null, categories: [cat('4', 'Sports', false), cat('5', 'News', false)] },
  ],
  untagged: [cat('10', 'Zulu', false), cat('11', 'alpha', true), cat('12', 'Alpine', false), cat('13', 'Beta', false), cat('14', '4K Movies', false)],
});

test('a group switch sets the group and clears its exceptions', () => {
  const p = createPickerState(view());
  p.toggleCategory('2');
  expect(p.groupState('UK')).toBe('some');
  p.toggleGroup('UK');
  expect(p.groupState('UK')).toBe('on');
  expect(p.toUpdate().categories).not.toHaveProperty('2');
  p.toggleGroup('UK');
  expect(p.groupState('UK')).toBe('off');
  expect(p.toUpdate().tags.UK).toBe(false);
  expect(p.toUpdate().categories).not.toHaveProperty('1');
});

test('unticking one category in an on group makes it "some" and records an exception', () => {
  const p = createPickerState(view());
  expect(p.groupState('UK')).toBe('on');
  p.toggleCategory('1');
  expect(p.groupState('UK')).toBe('some');
  expect(p.toUpdate().categories).toMatchObject({ '1': false });
});

test('toUpdate sends group rules and only real exceptions', () => {
  const v = view();
  v.untagged = [];
  const p = createPickerState(v);
  p.toggleCategory('2'); // UK| PPV off
  p.toggleCategory('2'); // back on: no longer an exception
  p.toggleCategory('2'); // off again
  expect(p.toUpdate()).toEqual({ tags: { UK: true, US: false }, categories: { '2': false } });
});

test('No tag choices are per category, never a group rule', () => {
  const p = createPickerState(view());
  p.toggleCategory('10');
  const update = p.toUpdate();
  expect(Object.keys(update.tags)).toEqual(['UK', 'US']);
  expect('' in update.tags).toBe(false);
  expect(update.categories['10']).toBe(true);
  expect(update.categories['11']).toBe(true);
  expect(update.categories['12']).toBe(false);
});

test('filter is case-insensitive over display names', () => {
  const p = createPickerState(view());
  expect(p.filter('ALP').map((c) => c.remoteId)).toEqual(['11', '12']);
  expect(p.filter('  ')).toHaveLength(5);
});

test('keep and hide all matches act on the filtered set only', () => {
  const p = createPickerState(view());
  p.keepMatches('alp');
  expect(p.isVisible('12')).toBe(true);
  expect(p.isVisible('13')).toBe(false);
  p.hideMatches('alp');
  expect(p.isVisible('11')).toBe(false);
  expect(p.isVisible('12')).toBe(false);
});

test('azIndex points at the first category of each letter', () => {
  const p = createPickerState(view());
  expect(p.untagged.map((c) => c.displayName)).toEqual(['4K Movies', 'alpha', 'Alpine', 'Beta', 'Zulu']);
  expect(p.azIndex()).toEqual([
    { letter: '#', index: 0 },
    { letter: 'A', index: 1 },
    { letter: 'B', index: 3 },
    { letter: 'Z', index: 4 },
  ]);
});

test('keptCount matches the footer "82 of 764 kept" arithmetic', () => {
  const p = createPickerState(view());
  expect(p.total()).toBe(10);
  expect(p.keptCount()).toBe(4); // UK 3 + alpha
  p.toggleGroup('US');
  expect(p.keptCount()).toBe(6);
  p.hideMatches('');
  expect(p.keptCount()).toBe(5);
});

test('a stored rule of off survives an untouched Done, even with most categories visible', () => {
  const v = view();
  v.groups[0]!.rule = false; // UK: rule off, but 3 visible exceptions
  const p = createPickerState(v);
  expect(p.groupState('UK')).toBe('on');
  const update = p.toUpdate();
  expect(update.tags.UK).toBe(false);
  expect(update.categories).toMatchObject({ '1': true, '2': true, '3': true });
});

test('a group with no stored rule starts on when every category is visible, else off', () => {
  const v = view();
  v.groups[1]!.categories[0]!.visible = true; // US: one of two visible, no rule
  const p = createPickerState(v);
  expect(p.toUpdate().tags).toEqual({ UK: true, US: false });
  expect(p.toUpdate().categories).toMatchObject({ '4': true });
});
