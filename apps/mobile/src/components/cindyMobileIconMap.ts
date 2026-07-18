/**
 * CINDY mobile icon slot map for M1/M2 UI alignment.
 *
 * This is pure metadata: M1 wires BrandArrow + model brand marks, while page-level
 * replacement for folder/FAB/action-sheet slots stays in the M2 layout pass.
 */
export type CindyMobileIconSlot =
  | 'sessionLeadingGlyph'
  | 'modelBrandMark'
  | 'projectFolder'
  | 'newChatFab'
  | 'sheetRename'
  | 'sheetPinTop'
  | 'sheetCopyLink'
  | 'sheetArchive'
  | 'sheetInfo'
  | 'sheetDelete';

export interface CindyMobileIconSpec {
  slot: CindyMobileIconSlot;
  currentAsset: string;
  targetAsset: string;
  status: 'wired' | 'mapped';
  colorToken: string;
  figmaNode?: string;
}

export const cindyMobileIconSpecs: readonly CindyMobileIconSpec[] = [
  {
    slot: 'sessionLeadingGlyph',
    currentAsset: 'MobileVendorIcon Claude/Codex glyph',
    targetAsset: 'BrandArrow',
    status: 'wired',
    colorToken: 'textTertiary / statusAccent',
    figmaNode: '301:854 / 301:881 / 301:1077 / 301:1096',
  },
  {
    slot: 'modelBrandMark',
    currentAsset: 'provider mark',
    targetAsset: 'MobileModelBrandMark',
    status: 'wired',
    colorToken: 'textSecondary / textPrimary',
  },
  {
    slot: 'projectFolder',
    currentAsset: 'lucide Folder / FolderOpen',
    targetAsset: 'material folder outline or custom active folder SVG',
    status: 'mapped',
    colorToken: 'textSecondary / activeGlyph',
    figmaNode: '301:898 / 301:905 / 301:912 / 301:1121 / 301:1128 / 301:1135',
  },
  {
    slot: 'newChatFab',
    currentAsset: 'lucide SquarePen',
    targetAsset: 'message compose glyph',
    status: 'mapped',
    colorToken: 'ctaText',
    figmaNode: '301:918 / 301:1141',
  },
  {
    slot: 'sheetRename',
    currentAsset: 'lucide Pencil',
    targetAsset: 'pencil action glyph',
    status: 'mapped',
    colorToken: 'sheetActionText',
    figmaNode: '301:1016 / 301:1262',
  },
  {
    slot: 'sheetPinTop',
    currentAsset: 'lucide Pin / PinOff',
    targetAsset: 'top-filled action glyph',
    status: 'mapped',
    colorToken: 'sheetActionText',
    figmaNode: '301:1019 / 301:1265',
  },
  {
    slot: 'sheetCopyLink',
    currentAsset: 'lucide Copy',
    targetAsset: 'copy link action glyph',
    status: 'mapped',
    colorToken: 'sheetActionText',
    figmaNode: '301:1024 / 301:1270',
  },
  {
    slot: 'sheetArchive',
    currentAsset: 'lucide Archive',
    targetAsset: 'archive action glyph',
    status: 'mapped',
    colorToken: 'sheetActionText',
    figmaNode: '301:1029 / 301:1275',
  },
  {
    slot: 'sheetInfo',
    currentAsset: 'lucide Info',
    targetAsset: 'info action glyph',
    status: 'mapped',
    colorToken: 'sheetActionText',
    figmaNode: '301:1034 / 301:1280',
  },
  {
    slot: 'sheetDelete',
    currentAsset: 'lucide Trash2',
    targetAsset: 'delete action glyph',
    status: 'mapped',
    colorToken: 'destructive',
    figmaNode: '301:1038 / 301:1284',
  },
] as const;
