/**
 * Bookmark folder → strip layout. Tab groups cannot nest, so a bookmark's group is
 * the subfolder directly under the chosen folder, however deep it sits:
 *
 *   <chosen folder>
 *     ├── Mail            → native pinned tab
 *     ├── Work            → tab group "Work"
 *     │   ├── Issues      → tab in "Work"
 *     │   └── Old
 *     │       └── Wiki    → also in "Work"
 *     └── News            → native pinned tab (loose bookmarks always lead)
 */

import { isWebUrl, normalizeUrl, parseUrl } from './url.ts';
import type { FolderOption, FolderSpec, GroupColor, Layout, PinSpec } from './types.ts';

export interface BookmarkNode {
  id: string;
  title: string;
  url?: string;
  children?: BookmarkNode[];
}

/** Invisible marker at the start of a managed group's title, to tell it from your own groups. */
export const GROUP_MARKER = '⁣';

export const GROUP_COLORS: GroupColor[] = [
  'grey',
  'blue',
  'red',
  'yellow',
  'green',
  'pink',
  'purple',
  'cyan',
  'orange',
];

export function groupTitle(folderTitle: string): string {
  return `${GROUP_MARKER}${folderTitle}`;
}

export function isManagedGroupTitle(title: string | undefined): boolean {
  return typeof title === 'string' && title.startsWith(GROUP_MARKER);
}

/** A stable colour per folder name; grey is skipped because it reads as "no colour". */
export function colorForFolder(title: string): GroupColor {
  let hash = 0;
  for (let index = 0; index < title.length; index += 1) {
    hash = (hash * 31 + title.charCodeAt(index)) % 1000003;
  }
  const palette = GROUP_COLORS.filter((color) => color !== 'grey');
  return palette[hash % palette.length] ?? 'blue';
}

export function isFolder(node: BookmarkNode): boolean {
  return node.url === undefined;
}

export function findNode(nodes: readonly BookmarkNode[], id: string): BookmarkNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = node.children ? findNode(node.children, id) : null;
    if (found) return found;
  }
  return null;
}

/** "Bookmarks bar / Work" style path of a folder, for the options page. */
export function pathOf(
  nodes: readonly BookmarkNode[],
  id: string,
  trail: string[] = [],
): string | null {
  for (const node of nodes) {
    const here = node.title ? [...trail, node.title] : trail;
    if (node.id === id) return here.join(' / ');
    const found = node.children ? pathOf(node.children, id, here) : null;
    if (found !== null) return found;
  }
  return null;
}

function pinOf(node: BookmarkNode, folderId: string | null): PinSpec {
  const url = normalizeUrl(node.url) ?? String(node.url);
  return {
    bookmarkId: node.id,
    url,
    title: node.title || parseUrl(url)?.host || url,
    folderId,
  };
}

function collect(node: BookmarkNode, visit: (bookmark: BookmarkNode) => void): void {
  for (const child of node.children ?? []) {
    if (isFolder(child)) collect(child, visit);
    else visit(child);
  }
}

export function buildLayout(root: BookmarkNode): Layout {
  const loose: PinSpec[] = [];
  const grouped: PinSpec[] = [];
  const folders: FolderSpec[] = [];

  for (const child of root.children ?? []) {
    if (!isFolder(child)) {
      if (isWebUrl(child.url)) loose.push(pinOf(child, null));
      continue;
    }
    const before = grouped.length;
    collect(child, (bookmark) => {
      if (isWebUrl(bookmark.url)) grouped.push(pinOf(bookmark, child.id));
    });
    if (grouped.length > before) {
      folders.push({ folderId: child.id, title: child.title, color: colorForFolder(child.title) });
    }
  }

  return { pins: [...loose, ...grouped], folders };
}

/** The chosen folder and every folder below it, for the "Add pin" dialog. */
export function folderOptions(root: BookmarkNode): FolderOption[] {
  const options: FolderOption[] = [];
  const walk = (node: BookmarkNode, depth: number) => {
    options.push({ id: node.id, title: node.title, depth });
    for (const child of node.children ?? []) if (isFolder(child)) walk(child, depth + 1);
  };
  walk(root, 0);
  return options;
}
