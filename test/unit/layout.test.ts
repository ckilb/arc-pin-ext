import { expect, test } from 'vitest';
import {
  buildLayout,
  colorForFolder,
  findNode,
  folderOptions,
  groupTitle,
  isManagedGroupTitle,
  pathOf,
  type BookmarkNode,
} from '../../src/lib/layout.ts';

const tree: BookmarkNode[] = [
  {
    id: '0',
    title: '',
    children: [
      {
        id: '1',
        title: 'Bookmarks bar',
        children: [
          { id: 'a', title: 'Mail', url: 'https://mail.example.com' },
          {
            id: 'work',
            title: 'Work',
            children: [
              { id: 'b', title: 'Issues', url: 'https://issues.example.com/list' },
              {
                id: 'old',
                title: 'Old',
                children: [{ id: 'c', title: '', url: 'https://wiki.example.com/' }],
              },
              { id: 'js', title: 'Bookmarklet', url: 'javascript:void 0' },
            ],
          },
          { id: 'empty', title: 'Empty', children: [{ id: 'x', title: 'X', url: 'chrome://x' }] },
          { id: 'd', title: 'News', url: 'https://news.example.com' },
          {
            id: 'misc',
            title: 'Misc',
            children: [{ id: 'e', title: 'E', url: 'https://e.example.com' }],
          },
        ],
      },
      { id: '2', title: 'Other bookmarks', children: [] },
    ],
  },
];

test('loose bookmarks lead, folders follow in order, deeper folders join their top folder', () => {
  const root = findNode(tree, '1');
  if (!root) throw new Error('no root');
  const layout = buildLayout(root);
  expect(layout.pins.map((pin) => [pin.bookmarkId, pin.folderId])).toEqual([
    ['a', null],
    ['d', null],
    ['b', 'work'],
    ['c', 'work'],
    ['e', 'misc'],
  ]);
  expect(layout.folders.map((folder) => folder.folderId)).toEqual(['work', 'misc']);
});

test('URLs are normalised and an untitled bookmark is named after its host', () => {
  const root = findNode(tree, '1');
  if (!root) throw new Error('no root');
  const pins = buildLayout(root).pins;
  expect(pins[0]?.url).toBe('https://mail.example.com/');
  expect(pins.find((pin) => pin.bookmarkId === 'c')?.title).toBe('wiki.example.com');
});

test('folder colours are stable and never grey', () => {
  expect(colorForFolder('Work')).toBe(colorForFolder('Work'));
  for (const name of ['Work', 'Misc', 'A', '', 'Ünïcode'])
    expect(colorForFolder(name)).not.toBe('grey');
});

test('managed group titles carry an invisible marker', () => {
  expect(groupTitle('Work')).toBe('⁣Work');
  expect(isManagedGroupTitle(groupTitle('Work'))).toBe(true);
  expect(isManagedGroupTitle('Work')).toBe(false);
  expect(isManagedGroupTitle(undefined)).toBe(false);
});

test('paths and folder options', () => {
  expect(pathOf(tree, 'old')).toBe('Bookmarks bar / Work / Old');
  const root = findNode(tree, '1');
  if (!root) throw new Error('no root');
  expect(folderOptions(root).map((option) => [option.id, option.depth])).toEqual([
    ['1', 0],
    ['work', 1],
    ['old', 2],
    ['empty', 1],
    ['misc', 1],
  ]);
});
